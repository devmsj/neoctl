import type { ContextManager } from "../context/context-manager.js";
import type { Compactor, ContextBudgetOptions } from "../context/compaction.js";
import type { ModelGateway } from "../model/model-gateway.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { CanUseTool } from "../tools/tool.js";
import type { QueryOptions, TaskNotificationSource } from "./query.js";
import type { AgentEvent } from "../types/events.js";
import type { Message } from "../types/messages.js";
import { createSystemInitMessage, createTextMessage } from "../types/messages.js";
import { query } from "./query.js";
import type { TerminalReason } from "./state.js";
import { SessionStore, type SessionStoreSnapshot, type SessionSummary } from "../session/session-store.js";

export interface QueryEngineOptions {
  agentId?: string;
  model?: string;
  fallbackModel?: string;
  queryOrigin?: string;
  maxOutputTokensOverride?: number;
  maxTurns?: number;
  modelGateway: ModelGateway;
  tools: ToolRegistry;
  contextManager?: ContextManager;
  compactor?: Compactor;
  contextBudget?: ContextBudgetOptions;
  canUseTool?: CanUseTool;
  taskNotificationSource?: TaskNotificationSource;
  commands?: readonly string[];
  agents?: readonly string[];
  skills?: readonly string[];
  plugins?: readonly string[];
  session?: {
    enabled?: boolean;
    sessionId?: string;
    rootDir?: string;
    resume?: boolean;
    toolResultThresholdChars?: number;
  };
}

export class QueryEngine {
  private readonly agentId: string;
  private readonly history: Message[] = [];
  private lastTerminalReason?: TerminalReason;
  private sessionStore?: SessionStore;
  private sessionInitialized = false;

  constructor(private readonly options: QueryEngineOptions) {
    this.agentId = options.agentId ?? "main";
  }

  async initialize(): Promise<void> {
    if (this.sessionInitialized) return;
    this.sessionInitialized = true;
    if (this.options.session?.enabled === false) return;
    if (!this.options.session) return;
    await this.openSession({
      sessionId: this.options.session.sessionId,
      resume: this.options.session.resume,
    });
  }

  async resumeSession(sessionId?: string): Promise<SessionStoreSnapshot> {
    this.sessionInitialized = true;
    await this.openSession({ sessionId, resume: true });
    const snapshot = this.sessionStore?.snapshot();
    if (!snapshot) throw new Error("session transcripts are disabled");
    return snapshot;
  }

  async listSessions(limit = 10): Promise<SessionSummary[]> {
    if (this.options.session?.enabled === false || !this.options.session) return [];
    return SessionStore.list({
      agentId: this.agentId,
      cwd: process.cwd(),
      rootDir: this.options.session.rootDir,
      limit,
    });
  }

  async *sendUserText(text: string, options: { abortSignal?: AbortSignal } = {}): AsyncGenerator<AgentEvent> {
    await this.initialize();
    const userMessage = createTextMessage("user", text);
    this.history.push(userMessage);
    this.sessionStore?.recordMessage(userMessage);

    const initMessage = createSystemInitMessage({
      agentId: this.agentId,
      tools: this.options.tools.names(),
      model: this.options.model,
      commands: [...(this.options.commands ?? [])],
      agents: [...(this.options.agents ?? [])],
      skills: [...(this.options.skills ?? [])],
      plugins: [...(this.options.plugins ?? [])],
    });
    yield {
      type: "message",
      message: initMessage,
    };
    this.sessionStore?.recordMessage(initMessage);

    const queryOptions: QueryOptions = {
      agentId: this.agentId,
      model: this.options.model,
      fallbackModel: this.options.fallbackModel,
      queryOrigin: this.options.queryOrigin ?? "repl",
      maxOutputTokensOverride: this.options.maxOutputTokensOverride,
      maxTurns: this.options.maxTurns,
      abortSignal: options.abortSignal,
    };

    const stream = query(
      this.history,
      {
        ...this.options,
        taskNotificationSource: this.options.taskNotificationSource,
        toolResultMemory: this.sessionStore?.toolResultMemory,
        recordContentReplacements: (records) => this.sessionStore?.recordContentReplacements(records),
      },
      queryOptions,
    );
    for await (const event of stream) {
      if (event.type === "message") {
        this.history.push(event.message);
        this.sessionStore?.recordMessage(event.message);
      }
      if (event.type === "terminal") {
        this.lastTerminalReason = event.reason;
      }
      yield event;
    }
  }

  reset(): void {
    this.history.length = 0;
    this.lastTerminalReason = undefined;
    this.sessionStore?.reset();
  }

  snapshot(): { agentId: string; messages: number; lastTerminalReason?: TerminalReason; session?: SessionStoreSnapshot } {
    return {
      agentId: this.agentId,
      messages: this.history.length,
      lastTerminalReason: this.lastTerminalReason,
      session: this.sessionStore?.snapshot(),
    };
  }

  getHistoryMessages(): Message[] {
    return this.history.map(cloneMessage);
  }

  get toolResultMemory() {
    return this.sessionStore?.toolResultMemory;
  }

  private async openSession(options: { sessionId?: string; resume?: boolean }): Promise<void> {
    if (this.options.session?.enabled === false || !this.options.session) return;
    this.sessionStore = await SessionStore.open({
      agentId: this.agentId,
      cwd: process.cwd(),
      sessionId: options.sessionId,
      rootDir: this.options.session.rootDir,
      resume: options.resume,
      toolResultThresholdChars: this.options.session.toolResultThresholdChars,
    });
    this.history.length = 0;
    if (options.resume) this.history.push(...this.sessionStore.getInitialMessages());
  }
}

function cloneMessage(message: Message): Message {
  return JSON.parse(JSON.stringify(message)) as Message;
}
