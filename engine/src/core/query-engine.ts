import type { ContextManager } from "../context/context-manager.js";
import type { Compactor, ContextBudgetOptions } from "../context/compaction.js";
import type { ModelGateway } from "../model/model-gateway.js";
import { ToolRegistry } from "../tools/registry.js";
import type { CanUseTool } from "../tools/tool.js";
import type { QueryOptions, TaskNotificationSource } from "./query.js";
import type { AgentEvent } from "../types/events.js";
import type { Message } from "../types/messages.js";
import { createSystemInitMessage, createTextMessage } from "../types/messages.js";
import { query } from "./query.js";
import { runAgent } from "./run-agent.js";
import { GENERAL_PURPOSE_AGENT } from "../agents/agent-definition.js";
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
  private userTurns = 0;

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
    this.userTurns += 1;
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
        if (event.reason === "completed") await this.maybeGenerateSessionTitle();
      }
      yield event;
    }
  }

  reset(): void {
    this.history.length = 0;
    this.userTurns = 0;
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
    this.userTurns = countUserTurns(this.history);
  }

  private async maybeGenerateSessionTitle(): Promise<void> {
    const store = this.sessionStore;
    if (!store || store.getTitle() || this.userTurns !== 1) return;
    const title = await generateSessionTitle({
      agentId: `${this.agentId}-session-title`,
      modelGateway: this.options.modelGateway,
      model: this.options.model,
      fallbackModel: this.options.fallbackModel,
      messages: this.history,
    });
    if (title) store.recordTitle(title);
  }
}

async function generateSessionTitle(input: {
  agentId: string;
  modelGateway: ModelGateway;
  model?: string;
  fallbackModel?: string;
  messages: readonly Message[];
}): Promise<string | undefined> {
  try {
    const prompt = [
      "Summarize this session as a short title for a session list.",
      "Return only the title, without quotes or punctuation decoration.",
      "Keep it under 8 words and use the user's language when possible.",
      "",
      serializeMessagesForTitle(input.messages),
    ].join("\n");
    const stream = runAgent({
      agentId: input.agentId,
      agent: {
        ...GENERAL_PURPOSE_AGENT,
        agentType: "session-title",
        tools: [],
        maxTurns: 1,
        initialPrompt: "You generate concise conversation titles. Return only the title.",
      },
      prompt,
      dependencies: { modelGateway: input.modelGateway, tools: new ToolRegistry() },
      model: input.model,
      fallbackModel: input.fallbackModel,
      maxTurns: 1,
    });

    let completed = await stream.next();
    while (!completed.done) completed = await stream.next();
    return normalizeGeneratedTitle(completed.value.result.content);
  } catch {
    return undefined;
  }
}

function serializeMessagesForTitle(messages: readonly Message[]): string {
  return messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => {
      const text = message.blocks
        .filter((block): block is { type: "text"; text: string } => block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim();
      return text ? `${message.role}: ${text}` : undefined;
    })
    .filter((line): line is string => Boolean(line))
    .join("\n")
    .slice(0, 4000);
}

function normalizeGeneratedTitle(title: string): string | undefined {
  const normalized = title
    .replace(/[\r\n]+/g, " ")
    .replace(/^\s*["'“”‘’`]+|["'“”‘’`]+\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return normalized ? normalized.slice(0, 120) : undefined;
}

function countUserTurns(messages: readonly Message[]): number {
  return messages.filter((message) => message.role === "user" && message.blocks.some((block) => block.type === "text")).length;
}

function cloneMessage(message: Message): Message {
  return JSON.parse(JSON.stringify(message)) as Message;
}
