import type { QueryEngineOptions } from "../core/query-engine.js";
import { QueryEngine } from "../core/query-engine.js";
import type { AgentEvent } from "../types/events.js";
import type { Message, MessageBlock } from "../types/messages.js";
import type { DisplayMessage, DisplayMessageOptions } from "../ui/display-message.js";
import { toDisplayMessages } from "../ui/display-message.js";
import type { SessionStoreSnapshot, SessionSummary } from "./session-store.js";

export type SimpleSessionRuntimeEventListener = (event: AgentEvent, context: SimpleSessionRuntimeEventContext) => void | Promise<void>;

export interface SimpleSessionRuntimeEventContext {
  sessionId: string;
}

export interface SimpleSessionRuntimeOptions extends Omit<QueryEngineOptions, "session"> {
  /**
   * Base directory for all sessions managed by this runtime.
   * For simple multi-user isolation, create one runtime per user or pass a per-user rootDir.
   */
  sessionRootDir?: string;
  session?: Omit<NonNullable<QueryEngineOptions["session"]>, "sessionId" | "rootDir" | "resume">;
}

export interface SimpleSessionRuntimeGetOptions {
  /** Resume transcript when the engine is first created. Defaults to true. */
  resume?: boolean;
}

export interface SimpleSessionRuntimeNewSessionOptions {
  /** Optional concrete session id. If omitted, QueryEngine creates one. */
  sessionId?: string;
}

export interface SimpleSessionRuntimeSendOptions {
  abortSignal?: AbortSignal;
  blocks?: MessageBlock[];
  displayText?: string;
  /**
   * Behavior when another send is already running for the same session.
   * Defaults to "reject".
   */
  busyBehavior?: "reject" | "interrupt";
}

export interface SimpleSessionRuntimeSnapshot {
  activeSessions: string[];
  busySessions: string[];
}

interface ManagedEngine {
  engine: QueryEngine;
  initialized: Promise<void>;
}

/**
 * Lightweight session runtime for simple web/Vue integrations.
 *
 * It keeps exactly one active QueryEngine per session id, rejects concurrent writes
 * to the same session by default, and can broadcast sendUserText events to listeners.
 * Existing QueryEngine and SessionStore behavior is not changed.
 */
export class SimpleSessionRuntime {
  private readonly engines = new Map<string, ManagedEngine>();
  private readonly busy = new Set<string>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly listeners = new Set<SimpleSessionRuntimeEventListener>();

  constructor(private readonly options: SimpleSessionRuntimeOptions) {}

  async getOrCreateEngine(sessionId: string, options: SimpleSessionRuntimeGetOptions = {}): Promise<QueryEngine> {
    const normalizedSessionId = normalizeSessionId(sessionId);
    const existing = this.engines.get(normalizedSessionId);
    if (existing) {
      await existing.initialized;
      return existing.engine;
    }

    const engine = this.createEngine(normalizedSessionId, options.resume ?? true);
    const initialized = engine.initialize();
    const managed: ManagedEngine = { engine, initialized };
    this.engines.set(normalizedSessionId, managed);
    try {
      await initialized;
    } catch (error) {
      this.engines.delete(normalizedSessionId);
      throw error;
    }
    return engine;
  }

  async newSession(options: SimpleSessionRuntimeNewSessionOptions = {}): Promise<SessionStoreSnapshot> {
    const engine = this.createEngine(options.sessionId, false);
    const snapshot = await engine.newSession();
    this.engines.set(snapshot.sessionId, { engine, initialized: Promise.resolve() });
    return snapshot;
  }

  async resumeSession(sessionId: string): Promise<SessionStoreSnapshot> {
    const engine = await this.getOrCreateEngine(sessionId, { resume: true });
    const snapshot = engine.snapshot().session;
    if (!snapshot) throw new Error("session transcripts are disabled");
    return snapshot;
  }

  async listSessions(limit = 20): Promise<SessionSummary[]> {
    const engine = this.createEngine(undefined, false);
    return engine.listSessions(limit);
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (this.busy.has(normalizedSessionId)) throw new Error(`session is busy: ${normalizedSessionId}`);
    this.abort(normalizedSessionId);
    this.engines.delete(normalizedSessionId);
    const engine = this.createEngine(undefined, false);
    return engine.deleteSession(normalizedSessionId);
  }

  async getMessages(sessionId: string): Promise<Message[]> {
    const engine = await this.getOrCreateEngine(sessionId, { resume: true });
    return engine.getHistoryMessages();
  }

  async getDisplayMessages(sessionId: string, options: DisplayMessageOptions = {}): Promise<DisplayMessage[]> {
    return toDisplayMessages(await this.getMessages(sessionId), options);
  }

  async *sendUserText(sessionId: string, text: string, options: SimpleSessionRuntimeSendOptions = {}): AsyncGenerator<AgentEvent> {
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (this.busy.has(normalizedSessionId)) {
      if (options.busyBehavior === "interrupt") {
        this.abort(normalizedSessionId);
      } else {
        throw new Error(`session is busy: ${normalizedSessionId}`);
      }
    }

    const engine = await this.getOrCreateEngine(normalizedSessionId, { resume: true });
    const controller = new AbortController();
    const externalAbort = options.abortSignal;
    const abortFromExternal = () => controller.abort(externalAbort?.reason);
    if (externalAbort?.aborted) abortFromExternal();
    else externalAbort?.addEventListener("abort", abortFromExternal, { once: true });

    this.busy.add(normalizedSessionId);
    this.controllers.set(normalizedSessionId, controller);
    try {
      for await (const event of engine.sendUserText(text, {
        abortSignal: controller.signal,
        blocks: options.blocks,
        displayText: options.displayText,
      })) {
        await this.emit(event, { sessionId: normalizedSessionId });
        yield event;
      }
    } finally {
      externalAbort?.removeEventListener("abort", abortFromExternal);
      if (this.controllers.get(normalizedSessionId) === controller) this.controllers.delete(normalizedSessionId);
      this.busy.delete(normalizedSessionId);
    }
  }

  abort(sessionId: string): boolean {
    const controller = this.controllers.get(normalizeSessionId(sessionId));
    if (!controller) return false;
    controller.abort();
    return true;
  }

  isBusy(sessionId: string): boolean {
    return this.busy.has(normalizeSessionId(sessionId));
  }

  onEvent(listener: SimpleSessionRuntimeEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  release(sessionId: string): void {
    const normalizedSessionId = normalizeSessionId(sessionId);
    this.abort(normalizedSessionId);
    this.engines.delete(normalizedSessionId);
    this.busy.delete(normalizedSessionId);
  }

  snapshot(): SimpleSessionRuntimeSnapshot {
    return {
      activeSessions: [...this.engines.keys()],
      busySessions: [...this.busy],
    };
  }

  private createEngine(sessionId: string | undefined, resume: boolean): QueryEngine {
    return new QueryEngine({
      ...this.options,
      session: {
        ...this.options.session,
        enabled: this.options.session?.enabled ?? true,
        rootDir: this.options.sessionRootDir,
        sessionId,
        resume,
      },
    });
  }

  private async emit(event: AgentEvent, context: SimpleSessionRuntimeEventContext): Promise<void> {
    for (const listener of this.listeners) {
      await listener(event, context);
    }
  }
}

function normalizeSessionId(sessionId: string): string {
  const normalized = sessionId.trim();
  if (!normalized) throw new Error("sessionId is required");
  return normalized;
}
