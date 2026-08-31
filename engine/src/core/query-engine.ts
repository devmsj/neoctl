import { InMemoryAppState } from "../app/app-state.js";
import { InMemoryAppPromptStore, type AppPromptInput, type AppPromptSnapshot, type AppPromptStore } from "../app/app-prompt.js";
import { AppPromptContextManager, DefaultContextManager, type ContextManager } from "../context/context-manager.js";
import type { CompactionResult, Compactor, ContextBudgetOptions } from "../context/compaction.js";
import { ModelDrivenCompactor } from "../context/compaction.js";
import type { ModelGateway, ReasoningConfig } from "../model/model-gateway.js";
import { ToolRegistry } from "../tools/registry.js";
import type { CanUseTool, ToolUseContext } from "../tools/tool.js";
import type { QueryOptions, TaskNotificationSource } from "./query.js";
import type { AgentEvent, ContextMetrics } from "../types/events.js";
import type { Message, MessageBlock } from "../types/messages.js";
import { createSystemInitMessage, createTextMessage } from "../types/messages.js";
import { buildContextMetrics } from "./context-metrics.js";
import { applyRuntimeContextForPromptCache } from "./message-pipeline.js";
import { persistMessageImages } from "./image-storage.js";
import { query } from "./query.js";
import { runAgent } from "./run-agent.js";
import { GENERAL_PURPOSE_AGENT } from "../agents/agent-definition.js";
import type { TerminalReason } from "./state.js";
import { SessionStore, type SessionStoreSnapshot, type SessionSummary, type SessionTitleKind } from "../session/session-store.js";
import type { SessionPromptExportSnapshot } from "../session/session-export.js";
import { buildPromptCacheDiagnostics } from "./prompt-cache-telemetry.js";
import { computeStaticTokens } from "./context-metrics.js";

const DEFAULT_SESSION_TITLE_DELAY_MS = 5000;

export interface QueryEngineOptions {
  agentId?: string;
  model?: string;
  reasoning?: ReasoningConfig | null;
  queryOrigin?: string;
  maxOutputTokensOverride?: number;
  maxTurns?: number;
  modelGateway: ModelGateway;
  tools: ToolRegistry;
  contextManager?: ContextManager;
  compactor?: Compactor;
  contextBudget?: ContextBudgetOptions;
  canUseTool?: CanUseTool;
  secrets?: ToolUseContext["secrets"];
  secretRedactions?: ToolUseContext["secretRedactions"];
  taskNotificationSource?: TaskNotificationSource;
  commands?: readonly string[];
  agents?: readonly string[];
  skills?: readonly string[];
  plugins?: readonly string[];
  exportToolCalls?: (calls: Array<{ id: string; name: string; input: unknown }>) => void;
  appPromptStore?: AppPromptStore;
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
  private readonly titleTimers = new Set<ReturnType<typeof setTimeout>>();
  private lastTerminalReason?: TerminalReason;
  private sessionStore?: SessionStore;
  private currentModel?: string;
  private currentReasoning?: ReasoningConfig | null;
  private currentFastMode = false;
  private currentModelGateway: ModelGateway;
  private sessionInitialized = false;
  private titleSchedulerVersion = 0;
  private titleAgentRun?: { version: number; controller: AbortController };
  private readonly sessionTitleListeners = new Set<(snapshot: SessionStoreSnapshot | undefined) => void>();
  private readonly appPromptStore: AppPromptStore;
  private readonly contextManager: ContextManager;

  constructor(private readonly options: QueryEngineOptions) {
    this.agentId = options.agentId ?? "main";
    this.currentModel = options.model;
    this.currentReasoning = cloneReasoningConfig(options.reasoning);
    this.currentModelGateway = options.modelGateway;
    this.appPromptStore = options.appPromptStore ?? new InMemoryAppPromptStore();
    this.contextManager = options.contextManager
      ? new AppPromptContextManager(options.contextManager, this.appPromptStore)
      : new AppPromptContextManager(new DefaultContextManager(), this.appPromptStore);
  }

  forkForSession(sessionId?: string, resume = true): QueryEngine {
    return new QueryEngine({
      ...this.options,
      model: this.currentModel,
      reasoning: cloneReasoningConfig(this.currentReasoning),
      modelGateway: this.currentModelGateway,
      appPromptStore: this.appPromptStore,
      session: this.options.session
        ? { ...this.options.session, sessionId, resume }
        : undefined,
    });
  }

  onSessionTitleChange(listener: (snapshot: SessionStoreSnapshot | undefined) => void): () => void {
    this.sessionTitleListeners.add(listener);
    return () => this.sessionTitleListeners.delete(listener);
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

  async newSession(): Promise<SessionStoreSnapshot> {
    this.sessionInitialized = true;
    await this.openSession({ resume: false });
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

  async deleteSession(sessionId: string): Promise<boolean> {
    if (this.options.session?.enabled === false || !this.options.session) throw new Error("session transcripts are disabled");
    const activeSessionId = this.sessionStore?.sessionId;
    if (activeSessionId && activeSessionId === sessionId) {
      throw new Error("cannot delete the active session");
    }
    return SessionStore.delete({
      cwd: process.cwd(),
      sessionId,
      rootDir: this.options.session.rootDir,
    });
  }

  async *sendUserText(text: string, options: { abortSignal?: AbortSignal; blocks?: MessageBlock[]; displayText?: string } = {}): AsyncGenerator<AgentEvent> {
    await this.initialize();
    const userMessage = options.blocks
      ? await this.persistMessageImages({
          ...createTextMessage("user", options.displayText ?? text),
          blocks: options.blocks,
        })
      : createTextMessage("user", text);
    this.history.push(userMessage);
    this.sessionStore?.recordMessage(userMessage);
    this.scheduleSessionTitleCheck();

    const initMessage = createSystemInitMessage({
      agentId: this.agentId,
      tools: this.options.tools.names(),
      model: this.currentModel,
      commands: [...(this.options.commands ?? [])],
      agents: [...(this.options.agents ?? [])],
      skills: [...(this.options.skills ?? [])],
      plugins: [...(this.options.plugins ?? [])],
    });
    initMessage.metadata = {
      ...initMessage.metadata,
      reasoning: cloneReasoningConfig(this.currentReasoning),
    };
    yield {
      type: "message",
      message: initMessage,
    };
    this.sessionStore?.recordMessage(initMessage);

    const queryOptions: QueryOptions = {
      agentId: this.agentId,
      model: this.currentModel,
      reasoning: cloneReasoningConfig(this.currentReasoning),
      queryOrigin: this.options.queryOrigin ?? "repl",
      serviceTier: this.currentFastMode ? "priority" : undefined,
      maxOutputTokensOverride: this.options.maxOutputTokensOverride,
      maxTurns: this.options.maxTurns,
      abortSignal: options.abortSignal,
    };

    const stream = query(
      this.history,
      {
        ...this.options,
        contextManager: this.contextManager,
        modelGateway: this.currentModelGateway,
        taskNotificationSource: this.options.taskNotificationSource,
        toolResultMemory: this.sessionStore?.toolResultMemory,
        session: this.sessionStore ? { sessionId: this.sessionStore.sessionId, sessionDir: this.sessionStore.sessionDir, rootDir: this.options.session?.rootDir } : undefined,
        recordContentReplacements: (records) => this.sessionStore?.recordContentReplacements(records),
        exportToolCalls: (calls) => this.recordSyntheticToolCalls(calls),
      },
      queryOptions,
    );
    for await (const event of stream) {
      if (event.type === "message") {
        const message = await this.persistMessageImages(event.message);
        this.history.push(message);
        this.sessionStore?.recordMessage(message);
        yield { ...event, message };
        continue;
      }
      if (event.type === "terminal") this.lastTerminalReason = event.reason;
      yield event;
    }
  }

  setModel(model: string | undefined, reasoning?: ReasoningConfig | null, updateReasoning = false): void {
    this.currentModel = model?.trim() || undefined;
    if (updateReasoning) this.currentReasoning = reasoning === null ? null : cloneReasoningConfig(reasoning);
  }

  setModelProvider(settings: { modelGateway: ModelGateway; model?: string; reasoning?: ReasoningConfig | null }): void {
    this.currentModelGateway = settings.modelGateway;
    this.currentModel = settings.model?.trim() || undefined;
    this.currentReasoning = settings.reasoning === null ? null : cloneReasoningConfig(settings.reasoning);
  }

  getModelSettings(): { model?: string; reasoning?: ReasoningConfig | null } {
    return {
      model: this.currentModel,
      reasoning: cloneReasoningConfig(this.currentReasoning),
    };
  }

  isFastMode(): boolean {
    return this.currentFastMode;
  }

  async setFastMode(enabled: boolean): Promise<boolean> {
    await this.initialize();
    this.currentFastMode = enabled === true;
    this.sessionStore?.recordFastMode(this.currentFastMode);
    return this.currentFastMode;
  }

  getAppPrompt(): AppPromptSnapshot {
    return this.appPromptStore.snapshot();
  }

  setAppPrompt(prompt: AppPromptInput | null | undefined): AppPromptSnapshot {
    const activePrompt = this.appPromptStore.setAppPrompt(prompt);
    this.sessionStore?.recordAppPrompt(activePrompt ?? null);
    return this.appPromptStore.snapshot();
  }

  clearAppPrompt(): AppPromptSnapshot {
    this.appPromptStore.clearAppPrompt();
    this.sessionStore?.recordAppPrompt(null);
    return this.appPromptStore.snapshot();
  }

  reset(): void {
    this.history.length = 0;
    this.lastTerminalReason = undefined;
    this.cancelPendingTitleWork();
    this.sessionStore?.reset();
    this.notifySessionTitleChange(this.sessionStore?.snapshot());
  }

  async compact(options: { abortSignal?: AbortSignal } = {}): Promise<CompactionResult> {
    await this.initialize();
    if (options.abortSignal?.aborted) return { messages: this.getHistoryMessages(), changed: false, reason: "none" };

    const compactor = this.options.compactor ?? new ModelDrivenCompactor(this.currentModelGateway);
    const result = await (compactor.manualCompact?.(this.history, this.options.contextBudget) ?? compactor.compact(this.history, this.options.contextBudget));
    this.applyCompactionResult(result);
    return result;
  }

  async pureCompact(options: { abortSignal?: AbortSignal } = {}): Promise<CompactionResult> {
    await this.initialize();
    if (options.abortSignal?.aborted) return { messages: this.getHistoryMessages(), changed: false, reason: "none" };

    const compactor = this.options.compactor ?? new ModelDrivenCompactor(this.currentModelGateway);
    const result = await (compactor.pureCompact?.(this.history, this.options.contextBudget) ?? { messages: this.getHistoryMessages(), changed: false, reason: "none" as const });
    this.applyCompactionResult(result);
    return result;
  }

  snapshot(): { agentId: string; messages: number; model?: string; reasoning?: ReasoningConfig | null; fastMode: boolean; lastTerminalReason?: TerminalReason; session?: SessionStoreSnapshot } {
    return {
      agentId: this.agentId,
      messages: this.history.length,
      model: this.currentModel,
      reasoning: cloneReasoningConfig(this.currentReasoning),
      fastMode: this.currentFastMode,
      lastTerminalReason: this.lastTerminalReason,
      session: this.sessionStore?.snapshot(),
    };
  }

  getHistoryMessages(): Message[] {
    return this.history.map(cloneMessage);
  }

  private applyCompactionResult(result: CompactionResult): void {
    if (!result.changed) return;
    this.history.length = 0;
    this.history.push(...result.messages.map(cloneMessage));
    this.sessionStore?.recordCompactBoundary();
    for (const message of result.messages) {
      this.sessionStore?.recordMessage(message);
    }
  }

  async contextMetrics(): Promise<ContextMetrics> {
    await this.initialize();
    const messages = this.getHistoryMessages();
    const promptSnapshot = await this.buildPromptExportSnapshot(messages);
    const tools = Array.isArray(promptSnapshot.toolDefinitions) ? promptSnapshot.toolDefinitions : [];
    const promptSections = Array.isArray(promptSnapshot.promptSections) ? promptSnapshot.promptSections : [];
    const systemPrompt = promptSnapshot.systemPrompt ?? "";
    const messagesForMetrics = applyRuntimeContextForPromptCache(messages, promptSnapshot.userContext ?? {}, promptSnapshot.systemContext ?? {});
    return buildContextMetrics({
      model: this.currentModel,
      messages: messagesForMetrics,
      systemPrompt,
      tools,
      cachedToolsAndPromptTokens: computeStaticTokens(systemPrompt, tools),
      cacheDiagnostics: buildPromptCacheDiagnostics({
        model: this.currentModel,
        systemPrompt,
        promptSections,
        tools,
        messages: messagesForMetrics,
      }),
    });
  }

  async promptExportSnapshot(): Promise<SessionPromptExportSnapshot> {
    await this.initialize();
    return this.buildPromptExportSnapshot(this.getHistoryMessages());
  }

  private async buildPromptExportSnapshot(messages: Message[]): Promise<SessionPromptExportSnapshot> {
    const toolContext: ToolUseContext = {
      agentId: this.agentId,
      tools: this.options.tools,
      appState: new InMemoryAppState(this.agentId),
      toolResultMemory: this.sessionStore?.toolResultMemory,
      secrets: this.options.secrets,
      secretRedactions: this.options.secretRedactions,
      recordContentReplacements: (records) => this.sessionStore?.recordContentReplacements(records),
      messages,
      options: {
        mainLoopModel: this.currentModel,
        modelGateway: this.currentModelGateway,
        reasoning: cloneReasoningConfig(this.currentReasoning),
      },
      emit: () => undefined,
    };
    const initialToolDefinitions = this.options.tools.definitions(toolContext);
    const context = await this.contextManager.build({
      agentId: this.agentId,
      messages,
      enabledTools: initialToolDefinitions.map((tool) => tool.name),
      toolUseContext: toolContext,
    });
    const toolDefinitions = this.options.tools.definitions(toolContext);
    const messagesWithUserContext = applyRuntimeContextForPromptCache([], context.userContext, {});
    const userContextPrompt = messagesWithUserContext[0]?.blocks
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    return {
      model: this.currentModel,
      reasoning: cloneReasoningConfig(this.currentReasoning),
      systemPrompt: context.systemPrompt,
      baseSystemPrompt: context.systemPrompt,
      promptSections: context.promptSections,
      userContext: context.userContext,
      systemContext: context.systemContext,
      userContextPrompt,
      toolDefinitions,
      commands: [...(this.options.commands ?? [])],
      agents: [...(this.options.agents ?? [])],
      skills: [...(this.options.skills ?? [])],
      plugins: [...(this.options.plugins ?? [])],
      appPrompt: this.appPromptStore.getAppPrompt(),
    };
  }

  private recordSyntheticToolCalls(calls: Array<{ id: string; name: string; input: unknown }>): void {
    const missing = calls.filter((call) =>
      !this.history.some((message) =>
        message.blocks.some((block) => block.type === "tool_use" && block.id === call.id),
      ),
    );
    if (!missing.length) return;
    const message: Message = {
      id: `tool-use-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      role: "assistant",
      createdAt: new Date().toISOString(),
      blocks: missing.map((call) => ({ type: "tool_use", id: call.id, name: call.name, input: call.input })),
      isMeta: true,
      metadata: { syntheticToolUse: true },
    };
    this.history.push(message);
    this.sessionStore?.recordMessage(message);
    this.options.exportToolCalls?.(missing);
  }

  private async persistMessageImages(message: Message): Promise<Message> {
    if (!message.blocks.some((block) => block.type === "image")) return message;
    const persistedBlocks = await persistMessageImages(message.blocks, { sessionDir: this.sessionStore?.sessionDir, agentId: this.agentId });
    const hasRetention = typeof message.metadata?.imageRetention === "string";
    return {
      ...message,
      blocks: persistedBlocks,
      metadata: message.role === "user"
        ? { ...message.metadata, imageRetention: "pinned", imageTtlTurns: undefined }
        : hasRetention
        ? message.metadata
        : { ...message.metadata, imageRetention: "while_relevant", imageTtlTurns: 4 },
    };
  }

  private async openSession(options: { sessionId?: string; resume?: boolean }): Promise<void> {
    if (this.options.session?.enabled === false || !this.options.session) return;
    this.cancelPendingTitleWork();
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
    this.appPromptStore.setAppPrompt(this.sessionStore.getAppPrompt());
    this.currentFastMode = this.sessionStore.getFastMode();
    this.notifySessionTitleChange(this.sessionStore.snapshot());
  }

  private scheduleSessionTitleCheck(): void {
    const store = this.sessionStore;
    if (!store || titleWorkComplete(store)) return;
    const version = this.titleSchedulerVersion;
    const timer = setTimeout(() => {
      this.titleTimers.delete(timer);
      void this.runSessionTitleCheck(version).catch(() => undefined);
    }, resolveSessionTitleDelayMs());
    this.titleTimers.add(timer);
    timer.unref?.();
  }

  private async runSessionTitleCheck(version: number): Promise<void> {
    try {
      if (version !== this.titleSchedulerVersion) return;
      const store = this.sessionStore;
      if (!store || titleWorkComplete(store)) return;
      if (this.titleAgentRun?.version === version) return;

      const state = store.getTitleState();
      const kind: SessionTitleKind = state.hasInitialTitle ? "refinement" : "initial";
      if (kind === "refinement" && !state.title) return;

      const controller = new AbortController();
      this.titleAgentRun = { version, controller };
      const title = await generateSessionTitle({
        agentId: `${this.agentId}-session-title`,
        modelGateway: this.currentModelGateway,
        model: this.currentModel,
        kind,
        previousTitle: state.title,
        messages: this.history,
        abortSignal: controller.signal,
      });
      if (version !== this.titleSchedulerVersion || store !== this.sessionStore || !title) return;
      const latest = store.getTitleState();
      if (kind === "initial" && latest.hasInitialTitle) return;
      if (kind === "refinement" && latest.hasRefinement) return;
      store.recordTitle(title, kind);
      this.notifySessionTitleChange(store.snapshot());
    } finally {
      if (this.titleAgentRun?.version === version) this.titleAgentRun = undefined;
    }
  }

  private notifySessionTitleChange(snapshot: SessionStoreSnapshot | undefined): void {
    for (const listener of this.sessionTitleListeners) listener(snapshot);
  }

  private cancelPendingTitleWork(): void {
    this.titleSchedulerVersion += 1;
    for (const timer of this.titleTimers) clearTimeout(timer);
    this.titleTimers.clear();
    this.titleAgentRun?.controller.abort();
    this.titleAgentRun = undefined;
  }
}

async function generateSessionTitle(input: {
  agentId: string;
  modelGateway: ModelGateway;
  model?: string;
  kind: SessionTitleKind;
  previousTitle?: string;
  messages: readonly Message[];
  abortSignal?: AbortSignal;
}): Promise<string | undefined> {
  try {
    const prompt = buildSessionTitlePrompt(input.kind, input.messages, input.previousTitle);
    const stream = runAgent({
      agentId: input.agentId,
      agent: {
        ...GENERAL_PURPOSE_AGENT,
        agentType: "session-title",
        tools: [],
        maxTurns: 1,
        requiresReport: false,
        initialPrompt: "You generate concise conversation titles. Return only the title.",
      },
      prompt,
      dependencies: { modelGateway: input.modelGateway, tools: new ToolRegistry() },
      model: input.model,
      maxTurns: 1,
      abortSignal: input.abortSignal,
    });

    let completed = await stream.next();
    while (!completed.done) completed = await stream.next();
    return normalizeGeneratedTitle(completed.value.result.content);
  } catch {
    return undefined;
  }
}

function buildSessionTitlePrompt(kind: SessionTitleKind, messages: readonly Message[], previousTitle?: string): string {
  const instructions = kind === "initial"
    ? ["Summarize this session as a short title for a session list."]
    : [
        "Refine this existing session title using the updated conversation.",
        `Previous title: ${previousTitle ?? "<none>"}`,
      ];
  return [
    ...instructions,
    "Return only the title, without quotes or punctuation decoration.",
    "Keep it under 8 words and use the user's language when possible.",
    "",
    serializeMessagesForTitle(messages),
  ].join("\n");
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

function titleWorkComplete(store: SessionStore): boolean {
  const state = store.getTitleState();
  return state.hasInitialTitle && state.hasRefinement;
}

function normalizeGeneratedTitle(title: string): string | undefined {
  const normalized = title
    .replace(/[\r\n]+/g, " ")
    .replace(/^\s*["'“”‘’`]+|["'“”‘’`]+\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return normalized ? normalized.slice(0, 120) : undefined;
}

function resolveSessionTitleDelayMs(): number {
  const raw = process.env.AGENT_SESSION_TITLE_DELAY_MS;
  if (raw !== undefined && raw !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) return Math.floor(parsed);
  }
  return DEFAULT_SESSION_TITLE_DELAY_MS;
}

function cloneReasoningConfig(reasoning: ReasoningConfig | null | undefined): ReasoningConfig | null | undefined {
  if (reasoning === null) return null;
  if (!reasoning) return undefined;
  return { ...reasoning };
}

function cloneMessage(message: Message): Message {
  return JSON.parse(JSON.stringify(message)) as Message;
}
