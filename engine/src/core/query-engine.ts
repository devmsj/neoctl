import type { ContextManager } from "../context/context-manager.js";
import type { Compactor, ContextBudgetOptions } from "../context/compaction.js";
import type { ModelGateway } from "../model/model-gateway.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { CanUseTool } from "../tools/tool.js";
import type { QueryOptions } from "./query.js";
import type { AgentEvent } from "../types/events.js";
import type { Message } from "../types/messages.js";
import { createSystemInitMessage, createTextMessage } from "../types/messages.js";
import { query } from "./query.js";
import type { TerminalReason } from "./state.js";
import { SessionStore, type SessionStoreSnapshot } from "../session/session-store.js";

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

  constructor(private readonly options: QueryEngineOptions) {
    this.agentId = options.agentId ?? "main";
  }

  async initialize(): Promise<void> {
    if (this.sessionStore || this.options.session?.enabled === false) return;
    if (!this.options.session) return;
    this.sessionStore = await SessionStore.open({
      agentId: this.agentId,
      cwd: process.cwd(),
      sessionId: this.options.session.sessionId,
      rootDir: this.options.session.rootDir,
      resume: this.options.session.resume,
      toolResultThresholdChars: this.options.session.toolResultThresholdChars,
    });
    if (this.options.session.resume) {
      this.history.length = 0;
      this.history.push(...this.sessionStore.getInitialMessages());
    }
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

  get toolResultMemory() {
    return this.sessionStore?.toolResultMemory;
  }
}
