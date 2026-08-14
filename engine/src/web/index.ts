#!/usr/bin/env node
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { QueryEngine } from "../core/query-engine.js";
import { InMemoryAppPromptStore, type AppPromptInput, type AppPromptStore } from "../app/app-prompt.js";
import { InMemoryAppState } from "../app/app-state.js";
import { loadDefaultDotEnvFiles } from "../model/env.js";
import { readModelProviderConfig, type ModelProviderName } from "../model/config.js";
import { findModelMetadata, loadModelCatalog, reasoningEffortsForModel, resolveContextWindowTokens } from "../model/context-window.js";
import { CommunicationLogger, LoggingModelGateway } from "../model/communication-logger.js";
import { createModelGatewayFromConfig, createModelGatewayFromProcessEnv } from "../model/provider-factory.js";
import type { ModelUsage, ReasoningConfig, ReasoningEffort } from "../model/model-gateway.js";
import { ToolRegistry } from "../tools/registry.js";
import type { Tool } from "../tools/tool.js";
import { editTool, writeTool } from "../tools/builtins/edit-tool.js";
import { createExecTool } from "../tools/builtins/exec-tool.js";
import { listDirectoryTool, readFileTool } from "../tools/builtins/filesystem-tools.js";
import { grepTool } from "../tools/builtins/grep-tool.js";
import { searchTool } from "../tools/builtins/search-tool.js";
import { planTool } from "../tools/builtins/plan-tool.js";
import { createOpenAIImageGenerationTool } from "../tools/builtins/image-generation-tool.js";
import { createLoadImageTool } from "../tools/builtins/image-loader-tool.js";
import { createAgentTool, resumeAgentTask, type AgentToolRuntime } from "../agents/agent-tool.js";
import { createTaskTools, type TaskResumeHandler } from "../tasks/task-tools.js";
import { TaskStore } from "../tasks/task-store.js";
import type { TaskNotificationSource } from "../core/query.js";
import { isModelReasoningArgument, parseReplCommand, helpText, replCommandDefinitions, type ModelReasoningArgument } from "../repl/commands.js";
import { writeSessionMarkdownExport } from "../session/session-export.js";
import type { CompactionResult } from "../context/compaction.js";
import type { AgentEvent, ContextMetrics } from "../types/events.js";
import type { Message, MessageBlock, ToolUseRequest } from "../types/messages.js";
import { WEB_HTML } from "./html.js";
import { openDirectory } from "../open-directory.js";
import { resolveImageBlockDataSync } from "../core/image-storage.js";

const require = createRequire(import.meta.url);
const markedPackageDir = path.dirname(require.resolve("marked/package.json"));
const highlightPackageDir = path.dirname(require.resolve("@highlightjs/cdn-assets/package.json"));
const markedAssetPath = path.join(markedPackageDir, "lib", "marked.esm.js");
const highlightAssetPath = path.join(highlightPackageDir, "highlight.min.js");
const highlightThemeAssetPath = path.join(highlightPackageDir, "styles", "atom-one-dark.min.css");

export interface WebRuntime {
  engine: QueryEngine;
  appPromptStore: AppPromptStore;
  communicationLogger: CommunicationLogger;
  modelGateway: LoggingModelGateway;
  agentRuntime: AgentToolRuntime;
  usage: SessionUsageTracker;
  taskStore: TaskStore;
  tools: ToolRegistry;
  initialMetrics: ContextMetrics;
  defaultReasoning?: ReasoningConfig | null;
  envPath: string;
  envNotice?: string;
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  requests: number;
  computedTotalTokens: boolean;
}

export class SessionUsageTracker {
  private totals: UsageTotals = emptyUsageTotals();
  private lastUsage?: ModelUsage;

  add(usage: ModelUsage): void {
    if (usage === this.lastUsage) return;
    this.lastUsage = usage;
    const inputTokens = usageTokenValue(usage.inputTokens);
    const outputTokens = usageTokenValue(usage.outputTokens);
    const reportedTotalTokens = usageTokenValue(usage.totalTokens);
    const computedTotalTokens = reportedTotalTokens ?? sumUsageTokens(inputTokens, outputTokens);
    const reasoningTokens = usageTokenValue(usage.reasoningTokens);
    const cachedTokens = usageTokenValue(usage.cachedTokens);
    if (inputTokens === undefined && outputTokens === undefined && computedTotalTokens === undefined && reasoningTokens === undefined && cachedTokens === undefined) return;
    this.totals = {
      inputTokens: this.totals.inputTokens + (inputTokens ?? 0),
      outputTokens: this.totals.outputTokens + (outputTokens ?? 0),
      totalTokens: this.totals.totalTokens + (computedTotalTokens ?? 0),
      reasoningTokens: this.totals.reasoningTokens + (reasoningTokens ?? 0),
      cachedTokens: this.totals.cachedTokens + (cachedTokens ?? 0),
      requests: this.totals.requests + 1,
      computedTotalTokens: this.totals.computedTotalTokens || (reportedTotalTokens === undefined && computedTotalTokens !== undefined),
    };
  }

  reset(): void {
    this.totals = emptyUsageTotals();
    this.lastUsage = undefined;
  }

  snapshot(): UsageTotals {
    return { ...this.totals };
  }
}

function emptyUsageTotals(): UsageTotals {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0, reasoningTokens: 0, cachedTokens: 0, requests: 0, computedTotalTokens: false };
}

function usageTokenValue(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function sumUsageTokens(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined && right === undefined) return undefined;
  return (left ?? 0) + (right ?? 0);
}

interface UiLineImage {
  src: string;
  label?: string;
  mimeType: string;
}

interface UiLine {
  id: number;
  kind: "system" | "user" | "assistant" | "thinking" | "tool" | "error" | "meta";
  text: string;
  toolName?: string;
  parentToolName?: string;
  toolUseId?: string;
  parentToolUseId?: string;
  title?: string;
  bodyTitle?: string;
  titleStatus?: "success" | "failure";
  format?: "markdown" | "ansi" | "plain" | "diff";
  previewStyle?: "summary";
  summaryMaxLines?: number;
  live?: boolean;
  collapsible?: boolean;
  image?: UiLineImage;
}

interface UiStatus {
  phase: string;
  detail?: string;
  currentTool?: {
    id: string;
    name: string;
    input: unknown;
    startedAt: number;
  };
  metrics?: ContextMetrics;
  usage?: ModelUsage;
  streamedOutputTokens: number;
  activityTick: number;
  inputTokenUpdatedAt?: number;
  outputTokenUpdatedAt?: number;
  retryCooldownUntil?: number;
}

export interface WebServerOptions {
  host: string;
  port: number;
}

export interface RunWebServerOptions {
  createRuntime?: WebRuntimeRouterOptions["createRuntime"];
  createRepl?: WebRuntimeRouterOptions["createRepl"];
}

export interface CreateWebRuntimeOptions {
  /** Override the initial session id for this runtime. */
  sessionId?: string;
  /** Override whether the initial session should resume transcript history. */
  resume?: boolean;
  /** Override the QueryEngine agent id. Defaults to main. */
  agentId?: string;
  /** Additional tools to register in the web runtime. */
  externalTools?: readonly Tool[];
}

export interface WebRuntimeScope {
  /** Browser-tab or client-instance identifier. Omit for the legacy singleton runtime. */
  tabId?: string;
  /** Optional session id used when a scoped runtime is created after page refresh/process restart. */
  sessionId?: string;
}

export interface WebRuntimeRouterOptions {
  createRuntime?: (options?: CreateWebRuntimeOptions) => Promise<WebRuntime>;
  createRepl?: (runtime: WebRuntime) => WebRepl;
}

const DEFAULT_WEB_RUNTIME_KEY = "__default__";

type LoginProviderName = ModelProviderName;

interface LoginFieldDefinition {
  key: string;
  label: string;
  envKey: string;
  scope: "provider" | "shared";
  required?: boolean;
  secret?: boolean;
  placeholder?: string;
  options?: readonly string[];
}

interface LoginFormPayload {
  envPath: string;
  providers: LoginProviderName[];
  provider: LoginProviderName;
  fields: LoginFieldDefinition[];
  values: Record<string, string>;
}

interface WebAttachmentPayload {
  kind: "image";
  label: string;
  mimeType: string;
  data: string;
}

interface WebSetAppPromptPayload {
  content?: string;
  id?: string;
  title?: string;
  usage?: string;
  source?: string;
  clear?: boolean;
}

type WebLineOperation =
  | { type: "line.append"; line: UiLine }
  | { type: "line.text.append"; id: number; text: string }
  | { type: "line.patch"; id: number; patch: Partial<UiLine> };

interface WebDeltaPayload {
  protocolVersion: 2;
  sessionId?: string;
  operations: WebLineOperation[];
  status: UiStatus;
}

interface WebSubscriber {
  response: ServerResponse;
  blocked: boolean;
  needsSync: boolean;
}

interface WebBackgroundSessionRun {
  sessionId: string;
  title?: string;
  reason: string;
  startedAt: number;
  engine: QueryEngine;
  abortController: AbortController;
  promise: Promise<void>;
}

export async function runWebServer(argv = process.argv.slice(2), runtimeOptions: RunWebServerOptions = {}): Promise<void> {
  const options = parseWebArgs(argv);
  const router = await createWebRuntimeRouter(runtimeOptions);
  const server = http.createServer((req, res) => void route(req, res, router));
  await new Promise<void>((resolve) => server.listen(options.port, options.host, resolve));
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : options.port;
  console.log(`neo web listening on http://${options.host === "0.0.0.0" ? "localhost" : options.host}:${actualPort}`);
}

function parseWebArgs(argv: string[]): WebServerOptions {
  let host = process.env.NEO_WEB_HOST || "127.0.0.1";
  let port = Number(process.env.NEO_WEB_PORT || 3000);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--host" && argv[i + 1]) host = argv[++i];
    else if (arg.startsWith("--host=")) host = arg.slice("--host=".length);
    else if (arg === "--port" && argv[i + 1]) port = Number(argv[++i]);
    else if (arg.startsWith("--port=")) port = Number(arg.slice("--port=".length));
  }
  if (!Number.isFinite(port) || port <= 0) port = 3000;
  return { host, port: Math.round(port) };
}

export async function createWebRuntime(options: CreateWebRuntimeOptions = {}): Promise<WebRuntime> {
  const envLoad = loadDefaultDotEnvFiles({ override: true });
  const modelConfig = readModelProviderConfig(process.env);
  const communicationLogger = new CommunicationLogger();
  const modelGateway = new LoggingModelGateway(createModelGatewayFromProcessEnv(process.env), communicationLogger);
  const taskStore = new TaskStore();
  const tools = new ToolRegistry();
  tools.register(editTool);
  tools.register(writeTool);
  tools.register(createExecTool({ taskStore }));
  tools.register(listDirectoryTool);
  tools.register(readFileTool);
  tools.register(grepTool);
  tools.register(searchTool);
  tools.register(createLoadImageTool());
  if (modelConfig?.provider === "openai") tools.register(createOpenAIImageGenerationTool());
  tools.register(planTool);
  for (const tool of options.externalTools ?? []) tools.register(tool);

  const agentRuntime: AgentToolRuntime = { modelGateway, tools, taskStore };
  tools.register(createAgentTool(agentRuntime));

  const resumeHandler: TaskResumeHandler = async (taskId, directive) => {
    const dummyContext = {
      agentId: "main",
      tools,
      appState: new InMemoryAppState("main"),
      emit: () => undefined,
    };
    return resumeAgentTask(taskId, directive, agentRuntime, taskStore, dummyContext);
  };
  for (const tool of createTaskTools(taskStore, resumeHandler)) tools.register(tool);

  const appPromptStore = new InMemoryAppPromptStore();
  const engine = new QueryEngine({
    agentId: options.agentId ?? "main",
    model: modelConfig?.model,
    fallbackModel: modelConfig?.fallbackModel,
    reasoning: modelConfig?.defaultReasoning,
    queryOrigin: "web",
    modelGateway,
    tools,
    appPromptStore,
    taskNotificationSource: createTaskNotificationSource(taskStore),
    commands: replCommandDefinitions.map((command) => command.usage),
    session: {
      enabled: process.env.AGENT_SESSION_TRANSCRIPT !== "0",
      sessionId: options.sessionId ?? process.env.AGENT_SESSION_ID,
      rootDir: process.env.AGENT_SESSION_DIR,
      resume: options.resume ?? parseResumeFlag(process.env.AGENT_SESSION_RESUME),
      toolResultThresholdChars: process.env.AGENT_TOOL_RESULT_THRESHOLD_CHARS ? Number(process.env.AGENT_TOOL_RESULT_THRESHOLD_CHARS) : undefined,
    },
  });
  await engine.initialize();
  const initialMetrics = await engine.contextMetrics();
  return {
    engine,
    appPromptStore,
    communicationLogger,
    modelGateway,
    agentRuntime,
    usage: new SessionUsageTracker(),
    taskStore,
    tools,
    initialMetrics,
    defaultReasoning: modelConfig?.defaultReasoning,
    envPath: process.env.NEO_ENV_FILE?.trim() ? path.resolve(process.env.NEO_ENV_FILE.trim()) : envLoad.userDotEnvPath,
    envNotice: envLoad.createdUserDotEnv ? formatCreatedEnvNotice(envLoad.userDotEnvPath) : undefined,
  };
}

function createTaskNotificationSource(taskStore: TaskStore): TaskNotificationSource {
  return {
    collectUnnotifiedCompletions() {
      return taskStore.collectUnnotifiedCompletions().map((task) => ({
        taskId: task.taskId,
        agentId: task.agentId,
        status: task.status,
        type: task.type,
        content: task.result?.content ?? task.error ?? "",
      }));
    },
    markNotified(taskId: string) {
      taskStore.markNotified(taskId);
    },
  };
}

function syncImageGenerationTool(runtime: WebRuntime, provider: ModelProviderName | undefined): void {
  runtime.tools.unregister("image2");
  if (provider === "openai") runtime.tools.register(createOpenAIImageGenerationTool());
}


function formatCreatedEnvNotice(dotEnvPath: string): string {
  return `Created default config file: ${dotEnvPath}\nSet MODEL_PROVIDER and the matching provider section (OPENAI_API_KEY or ANTHROPIC_API_KEY), then restart neo.`;
}

function parseResumeFlag(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "latest"].includes(value.toLowerCase());
}

export class WebRuntimeRouter {
  private readonly repls = new Map<string, Promise<WebRepl>>();
  private readonly createRuntime: (options?: CreateWebRuntimeOptions) => Promise<WebRuntime>;
  private readonly createRepl: (runtime: WebRuntime) => WebRepl;

  constructor(options: WebRuntimeRouterOptions = {}) {
    this.createRuntime = options.createRuntime ?? createWebRuntime;
    this.createRepl = options.createRepl ?? ((runtime) => new WebRepl(runtime));
  }

  get(scope: WebRuntimeScope = {}): Promise<WebRepl> {
    const key = webRuntimeScopeKey(scope);
    let repl = this.repls.get(key);
    if (!repl) {
      repl = this.createRuntime({ sessionId: scope.sessionId, resume: scope.sessionId ? true : scope.tabId ? false : undefined }).then((runtime) => this.createRepl(runtime));
      this.repls.set(key, repl);
      repl.catch(() => this.repls.delete(key));
    }
    return repl;
  }

  async snapshot(scope: WebRuntimeScope = {}, includeCatalog = true): Promise<ReturnType<WebRepl["snapshot"]>> {
    return (await this.get(scope)).snapshot(includeCatalog);
  }

  activeScopes(): string[] {
    return [...this.repls.keys()];
  }
}

export async function createWebRuntimeRouter(options: WebRuntimeRouterOptions = {}): Promise<WebRuntimeRouter> {
  const router = new WebRuntimeRouter(options);
  await router.get();
  return router;
}

function webRuntimeScopeKey(scope: WebRuntimeScope): string {
  const tabId = scope.tabId?.trim();
  if (tabId) return `tab:${tabId}`;
  const sessionId = scope.sessionId?.trim();
  if (sessionId) return `session:${sessionId}`;
  return DEFAULT_WEB_RUNTIME_KEY;
}

export class WebRepl {
  private readonly subscribers = new Set<WebSubscriber>();
  private eventSequence = 0;
  private pendingDeltaOperations: WebLineOperation[] = [];
  private pendingDeltaStatus = false;
  private pendingDeltaTimer: NodeJS.Timeout | undefined;
  private lineId = 0;
  private assistantLineId: number | undefined;
  private thinkingLineId: number | undefined;
  private finalizedThinkingLineId: number | undefined;
  private readonly liveToolLineIds = new Map<string, number>();
  private activeAbortController: AbortController | undefined;
  private interruptArmed = false;
  private lines: UiLine[];
  private status: UiStatus;
  private busy = false;
  private queuedInput: string | undefined;
  private queuedAttachments: WebAttachmentPayload[] | undefined;
  private foregroundRun: Promise<void> | undefined;
  private foregroundRunToken = 0;
  private pendingUserImageEchoLabels: string[] | undefined;
  private readonly backgroundSessionRuns = new Map<string, WebBackgroundSessionRun>();
  private readonly suppressReattachedStreaming = new Set<QueryEngine>();
  private backgroundTaskCount: number;

  constructor(private runtime: WebRuntime) {
    this.lines = initialLines(runtime, { current: 0 });
    this.status = initialStatus(runtime);
    this.backgroundTaskCount = runtime.taskStore.activeCount();
    runtime.taskStore.subscribe(() => {
      this.backgroundTaskCount = runtime.taskStore.activeCount();
      this.broadcastSync();
    });
    runtime.engine.onSessionTitleChange(() => this.broadcastSync());
  }

  subscribe(res: ServerResponse): void {
    const subscriber: WebSubscriber = { response: res, blocked: false, needsSync: false };
    this.subscribers.add(subscriber);
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    this.send(subscriber, "sync", this.snapshot(true));
    reqKeepAlive(res);
    res.on("close", () => this.subscribers.delete(subscriber));
  }

  snapshot(includeCatalog = false) {
    return {
      lines: this.lines,
      status: this.status,
      busy: this.busy,
      queuedInput: this.queuedInput,
      backgroundTaskCount: this.backgroundTaskCount,
      backgroundTasks: this.backgroundTasks(),
      backgroundSessionRunCount: this.backgroundSessionRuns.size,
      runningSessionIds: [...this.backgroundSessionRuns.keys()],
      session: this.runtime.engine.snapshot().session,
      fastMode: this.runtime.engine.isFastMode(),
      appPrompt: this.runtime.engine.getAppPrompt(),
      catalog: includeCatalog ? webCatalog(this.runtime) : undefined,
      interactive: includeCatalog ? webInteractiveCatalog(this.runtime) : undefined,
    };
  }

  async submit(text: string, attachments: WebAttachmentPayload[] = []): Promise<{ ok: true } | { ok: false; error: string }> {
    const trimmed = text.trim();
    if (!trimmed && attachments.length === 0) return { ok: true };
    const command = parseReplCommand(text);
    if (this.busy && command.type === "new") {
      await this.detachRunningForeground("new session");
    } else if (this.busy && command.type === "sessions") {
      await this.detachRunningForeground("session browser");
    } else if (this.busy) {
      this.queuedInput = text;
      this.queuedAttachments = attachments;
      this.broadcastSync();
      return { ok: true };
    }
    this.startRun(text, attachments);
    return { ok: true };
  }

  private startRun(text: string, attachments: WebAttachmentPayload[] = []): void {
    const run = this.handleCommandOrPrompt(text, attachments).catch((error) => {
      this.append({ kind: "error", text: error instanceof Error ? error.message : String(error) });
      this.setBusy(false);
      this.setStatus({ ...this.status, phase: "ready", detail: undefined });
    });
    this.foregroundRun = run;
    run.finally(() => {
      if (this.foregroundRun === run) this.foregroundRun = undefined;
    }).catch(() => undefined);
  }

  async listSessions() {
    const sessions = await this.runtime.engine.listSessions(Number.POSITIVE_INFINITY);
    const runningSessionIds = [...this.backgroundSessionRuns.keys()];
    return { sessions, runningSessionIds };
  }

  async resumeSession(sessionId: string): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!sessionId) return { ok: false, error: "sessionId is required" };
    try {
      const running = this.backgroundSessionRuns.get(sessionId);
      if (running) {
        await this.reattachRunningSession(running);
        return { ok: true };
      }
      await this.detachRunningForeground("session switch");
      this.runtime.engine = this.runtime.engine.forkForSession(sessionId, true);
      await this.runtime.engine.initialize();
      const snapshot = this.runtime.engine.snapshot().session;
      if (!snapshot) throw new Error("session transcripts are disabled");
      await this.refreshSessionView(systemLine(formatResume(snapshot)));
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.append({ kind: "error", text: message });
      return { ok: false, error: message };
    }
  }

  async newSession(): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      await this.detachRunningForeground("new session");
      this.runtime.engine = this.runtime.engine.forkForSession(undefined, false);
      await this.runtime.engine.initialize();
      const snapshot = this.runtime.engine.snapshot().session;
      if (!snapshot) throw new Error("session transcripts are disabled");
      await this.refreshSessionView(systemLine(`new session ${snapshot.sessionId}`));
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.append({ kind: "error", text: message });
      return { ok: false, error: message };
    }
  }

  private async refreshSessionView(line?: Omit<UiLine, "id">): Promise<void> {
    const metrics = await this.runtime.engine.contextMetrics();
    this.runtime.usage.reset();
    this.status = initialStatus(this.runtime, metrics);
    const lineId = { current: 0 };
    this.lines = initialLines(this.runtime, lineId);
    this.lineId = lineId.current;
    this.assistantLineId = undefined;
    this.thinkingLineId = undefined;
    this.finalizedThinkingLineId = undefined;
    this.liveToolLineIds.clear();
    if (line) this.append(line);
    this.broadcastSync();
  }

  async deleteSession(sessionId: string): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!sessionId) return { ok: false, error: "sessionId is required" };
    try {
      const deleted = await this.runtime.engine.deleteSession(sessionId);
      if (!deleted) return { ok: false, error: `session not found: ${sessionId}` };
      this.append(systemLine(`deleted session ${sessionId}`));
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.append({ kind: "error", text: message });
      return { ok: false, error: message };
    }
  }

  appPrompt() {
    return this.runtime.engine.getAppPrompt();
  }

  setAppPrompt(payload: WebSetAppPromptPayload): { ok: true; appPrompt: ReturnType<QueryEngine["getAppPrompt"]> } | { ok: false; error: string } {
    try {
      const shouldClear = payload.clear === true || !payload.content?.trim();
      const appPrompt = shouldClear
        ? this.runtime.engine.clearAppPrompt()
        : this.runtime.engine.setAppPrompt({
            content: payload.content ?? "",
            id: payload.id,
            title: payload.title,
            usage: payload.usage,
            source: payload.source,
          } satisfies AppPromptInput);
      const usage = payload.usage?.trim();
      if (!shouldClear && usage) {
        this.append({
          kind: "meta",
          title: "提示词用法",
          text: usage,
          format: "markdown",
        });
      }
      this.broadcastSync();
      return { ok: true, appPrompt };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: message };
    }
  }

  imagePayload(messageId: string, blockIndex: number): { body: Buffer; mimeType: string } | undefined {
    if (!messageId || !Number.isInteger(blockIndex) || blockIndex < 0) return undefined;
    const message = this.runtime.engine.getHistoryMessages().find((item) => item.id === messageId);
    const block = message?.blocks[blockIndex];
    if (!block || block.type !== "image") return undefined;
    const resolved = resolveImageBlockDataSync(block)?.trim();
    if (!resolved) return undefined;
    const dataUrl = /^data:([^;,]+);base64,([\s\S]*)$/iu.exec(resolved);
    const mimeType = (dataUrl?.[1] ?? block.mimeType).toLowerCase();
    if (!mimeType.startsWith("image/")) return undefined;
    const base64 = (dataUrl?.[2] ?? resolved).replace(/\s+/gu, "");
    if (!base64 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(base64)) return undefined;
    const body = Buffer.from(base64, "base64");
    return body.length ? { body, mimeType } : undefined;
  }

  async setFastMode(enabled: boolean): Promise<{ ok: true; fastMode: boolean } | { ok: false; error: string }> {
    try {
      const fastMode = await this.runtime.engine.setFastMode(enabled);
      this.broadcastSync();
      return { ok: true, fastMode };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  loginForm(providerValue?: string): LoginFormPayload {
    const provider = parseLoginProvider(providerValue);
    return createLoginFormPayload(this.runtime.envPath, provider);
  }

  async saveLogin(providerValue: string, values: Record<string, string>): Promise<{ ok: true } | { ok: false; error: string }> {
    const provider = parseLoginProvider(providerValue);
    if (!provider) return { ok: false, error: "provider must be openai or anthropic" };
    const payload: LoginFormPayload = { ...createLoginFormPayload(this.runtime.envPath, provider), provider, values };
    const validationError = validateLoginFormPayload(payload);
    if (validationError) return { ok: false, error: validationError };
    try {
      await saveLoginPayloadToEnv(payload);
      applyLoginPayloadToProcessEnv(payload);
      const config = readModelProviderConfig(process.env);
      if (!config) throw new Error("Saved provider config could not be loaded from environment.");
      const innerGateway = createModelGatewayFromConfig(config);
      this.runtime.modelGateway.setInner(innerGateway);
      this.runtime.agentRuntime.modelGateway = this.runtime.modelGateway;
      this.runtime.engine.setModelProvider({ modelGateway: this.runtime.modelGateway, model: config.model, fallbackModel: config.fallbackModel, reasoning: config.defaultReasoning });
      syncImageGenerationTool(this.runtime, config.provider);
      this.runtime.defaultReasoning = config.defaultReasoning;
      const metrics = await this.runtime.engine.contextMetrics();
      this.setStatus({ ...this.status, metrics, activityTick: this.status.activityTick + 1 });
      this.append(systemLine(`Saved ${provider} login to ${this.runtime.envPath}\n${formatModelSettings(this.runtime.engine.getModelSettings(), this.runtime.defaultReasoning)}`, EXPANDED_SUMMARY_MAX_LINES));
      return { ok: true };
    } catch (error) {
      const message = `Login save failed: ${error instanceof Error ? error.message : String(error)}`;
      this.append({ kind: "error", text: message });
      return { ok: false, error: message };
    }
  }

  interrupt(): { ok: true; interrupted: boolean } {
    const interrupted = this.stopForegroundRun("Interrupted from neo web");
    return { ok: true, interrupted };
  }

  cancelQueue(): { ok: true; cancelled: boolean } {
    const had = this.queuedInput !== undefined;
    this.queuedInput = undefined;
    this.queuedAttachments = undefined;
    if (had) this.broadcastSync();
    return { ok: true, cancelled: had };
  }

  private append(line: Omit<UiLine, "id">, streaming = false): number {
    const id = ++this.lineId;
    const nextLine = { id, ...line };
    this.lines.push(nextLine);
    if (streaming) this.broadcastDelta({ type: "line.append", line: nextLine });
    else this.broadcastSync();
    return id;
  }

  private appendLineText(id: number, text: string): void {
    this.lines = this.lines.map((line) => line.id === id ? { ...line, text: line.text + text } : line);
    this.broadcastDelta({ type: "line.text.append", id, text });
  }

  private replaceLineText(id: number, text: string): void {
    this.lines = this.lines.map((line) => line.id === id ? { ...line, text } : line);
    this.broadcastSync();
  }

  private replaceLine(id: number, patch: Partial<UiLine>): void {
    this.lines = this.lines.map((line) => line.id === id ? { ...line, ...patch } : line);
    this.broadcastSync();
  }

  private setBusy(next: boolean): void {
    this.busy = next;
    this.broadcastSync();
  }

  private setStatus(next: UiStatus): void {
    this.status = next;
    this.broadcastSync();
  }

  private finalizeForegroundView(): void {
    this.finalizeLiveLine(this.assistantLineId);
    this.finalizeThinkingLine();
    this.assistantLineId = undefined;
    this.finalizedThinkingLineId = undefined;
  }

  private stopForegroundRun(reason: string): boolean {
    const controller = this.activeAbortController;
    const runWasActive = this.busy || Boolean(controller && !controller.signal.aborted);
    this.foregroundRunToken += 1;
    this.foregroundRun = undefined;
    this.runtime.usage.reset();
    if (controller && !controller.signal.aborted) controller.abort(reason);
    this.activeAbortController = undefined;
    this.interruptArmed = false;
    this.queuedInput = undefined;
    this.queuedAttachments = undefined;
    this.finalizeForegroundView();
    this.finalizeLiveToolLines();
    this.busy = false;
    this.status = { ...this.status, phase: "ready", detail: undefined, currentTool: undefined, inputTokenUpdatedAt: undefined, outputTokenUpdatedAt: undefined, retryCooldownUntil: undefined };
    this.broadcastSync();
    return runWasActive;
  }

  private backgroundTasks() {
    return this.runtime.taskStore.list()
      .filter((task) => !this.runtime.taskStore.isTerminal(task))
      .map((task) => ({
        taskId: task.taskId,
        agentId: task.agentId,
        type: task.type,
        status: task.status,
        description: task.description,
        createdAt: task.createdAt,
      }));
  }

  private async detachRunningForeground(reason: string): Promise<boolean> {
    if (!this.busy) return false;
    const snapshot = this.runtime.engine.snapshot().session;
    const sessionId = snapshot?.sessionId ?? `session-${Date.now().toString(36)}`;
    const run = this.foregroundRun;
    if (run && !this.backgroundSessionRuns.has(sessionId)) {
      const backgroundRun: WebBackgroundSessionRun = {
        sessionId,
        title: snapshot?.title,
        reason,
        startedAt: Date.now(),
        engine: this.runtime.engine,
        abortController: this.activeAbortController ?? new AbortController(),
        promise: run,
      };
      this.backgroundSessionRuns.set(sessionId, backgroundRun);
      run.finally(() => {
        this.backgroundSessionRuns.delete(sessionId);
        this.suppressReattachedStreaming.delete(backgroundRun.engine);
        this.broadcastSync();
      }).catch(() => undefined);
    }
    this.activeAbortController = undefined;
    this.interruptArmed = false;
    this.queuedInput = undefined;
    this.queuedAttachments = undefined;
    this.busy = false;
    this.status = { ...this.status, phase: "ready", detail: undefined };
    this.append(systemLine(`Detached running ${sessionId} to background for ${reason}.`));
    return true;
  }

  private async reattachRunningSession(run: WebBackgroundSessionRun): Promise<void> {
    await this.detachRunningForeground("session switch");
    this.backgroundSessionRuns.delete(run.sessionId);
    this.runtime.engine = run.engine;
    this.activeAbortController = run.abortController;
    this.interruptArmed = false;
    this.foregroundRun = run.promise;
    this.suppressReattachedStreaming.add(run.engine);
    await this.refreshSessionView(systemLine(`reattached running session ${run.sessionId}`));
    this.setBusy(true);
    this.setStatus({ ...this.status, phase: "running", detail: "working" });
  }

  private reduce(event: AgentEvent): void {
    this.status = reduceStatus(this.status, event);
    if (event.type === "usage") this.runtime.usage.add(event.usage);
  }

  private finalizeLiveLine(id: number | undefined): void {
    if (id === undefined) return;
    this.lines = this.lines.map((line) => line.id === id ? { ...line, live: false } : line);
    this.queueDeltaOperation({ type: "line.patch", id, patch: { live: false } });
  }

  private finalizeThinkingLine(): void {
    const id = this.thinkingLineId;
    if (id === undefined) return;
    this.finalizeLiveLine(id);
    this.finalizedThinkingLineId = id;
    this.thinkingLineId = undefined;
  }

  private finalizeLiveToolLines(): void {
    for (const id of this.liveToolLineIds.values()) this.finalizeLiveLine(id);
    this.liveToolLineIds.clear();
  }

  private handleEvent(event: AgentEvent): void {
    this.reduce(event);
    if (event.type === "message" && this.matchesPendingUserImageEcho(event.message)) {
      this.pendingUserImageEchoLabels = undefined;
      renderMessageImages(event.message, (line) => this.append(line));
      this.broadcastSync();
      return;
    }
    if (event.type === "tool_call.delta") {
      this.queueDeltaStatus();
      return;
    }
    if (event.type === "state" || event.type === "context.metrics" || event.type === "usage" || event.type === "retrying") {
      this.broadcastSync();
      return;
    }
    if (event.type === "assistant.delta") {
      this.finalizeThinkingLine();
      const id = this.assistantLineId ?? this.append({ kind: "assistant", text: "", live: true }, true);
      this.assistantLineId = id;
      this.appendLineText(id, event.text);
      return;
    }
    if (event.type === "thinking.delta") {
      const id = this.thinkingLineId ?? this.finalizedThinkingLineId ?? this.append(thinkingLine("", true), true);
      this.thinkingLineId = id;
      this.finalizedThinkingLineId = undefined;
      this.appendLineText(id, event.text);
      return;
    }
    if (event.type === "message") {
      let replacedStreamingContent = false;
      if (event.message.role === "assistant" && this.assistantLineId !== undefined) {
        const text = assistantText(event.message);
        if (text !== undefined) {
          this.replaceLineText(this.assistantLineId, text);
          this.finalizeLiveLine(this.assistantLineId);
          this.assistantLineId = undefined;
          replacedStreamingContent = true;
        }
      }
      const thinkingId = this.thinkingLineId ?? this.finalizedThinkingLineId;
      if (event.message.role === "assistant" && thinkingId !== undefined) {
        const text = thinkingText(event.message);
        if (text !== undefined) {
          this.replaceLineText(thinkingId, text);
          this.finalizeLiveLine(thinkingId);
          this.thinkingLineId = undefined;
          this.finalizedThinkingLineId = undefined;
          replacedStreamingContent = true;
        }
      }
      if (replacedStreamingContent) {
        renderMessageImages(event.message, (line) => this.append(line));
        this.broadcastSync();
        return;
      }
      if (event.message.role === "tool_result") {
        renderToolResultMessage(event.message, (line, toolUseId) => {
          const liveLineId = this.liveToolLineIds.get(toolUseId);
          if (liveLineId === undefined) return this.append(line);
          this.replaceLine(liveLineId, line);
          this.liveToolLineIds.delete(toolUseId);
          return liveLineId;
        });
        renderMessageImages(event.message, (line) => this.append(line));
        return;
      }
      if (event.message.role !== "assistant") {
        this.finalizeLiveLine(this.assistantLineId);
        this.finalizeThinkingLine();
        this.assistantLineId = undefined;
      }
      const rendered = renderMessage(event.message, (line) => this.append(line), this.assistantLineId);
      if (rendered && event.message.role === "assistant") {
        this.finalizeLiveLine(this.assistantLineId);
        this.finalizeThinkingLine();
        this.assistantLineId = undefined;
      }
      this.broadcastSync();
      return;
    }
    if (event.type === "tool.started") {
      this.finalizeLiveLine(this.assistantLineId);
      this.finalizeThinkingLine();
      const id = this.append({ ...formatToolUse(event.toolUse), live: true });
      this.liveToolLineIds.set(event.toolUse.id, id);
      return;
    }
    if (event.type === "tool.finished") {
      const id = this.liveToolLineIds.get(event.toolUse.id);
      if (id !== undefined) {
        this.finalizeLiveLine(id);
        this.liveToolLineIds.delete(event.toolUse.id);
      }
      return;
    }
    if (event.type === "terminal") {
      this.finalizeLiveLine(this.assistantLineId);
      this.finalizeThinkingLine();
      this.finalizeLiveToolLines();
      this.assistantLineId = undefined;
      this.broadcastSync();
      return;
    }
    if (event.type === "error") this.append({ kind: "error", text: event.error.message });
  }

  private matchesPendingUserImageEcho(message: Message): boolean {
    const pending = this.pendingUserImageEchoLabels;
    if (!pending?.length || message.role !== "user") return false;
    const labels = message.blocks
      .filter((block): block is Extract<MessageBlock, { type: "image" }> => block.type === "image" && typeof block.label === "string")
      .map((block) => block.label as string);
    return labels.length === pending.length && labels.every((label, index) => label === pending[index]);
  }

  private async handleCommandOrPrompt(text: string, attachments: WebAttachmentPayload[] = []): Promise<void> {
    const command = parseReplCommand(text);
    if (command.type === "exit") {
      this.append(systemLine("neo web server is still running. Close this tab or stop the server process with Ctrl+C."));
      return;
    }
    if (command.type === "help") return void this.append(systemLine(helpText, EXPANDED_SUMMARY_MAX_LINES));
    if (command.type === "cost") return void this.append({ kind: "system", text: formatUsageTotals(this.runtime.usage.snapshot()), previewStyle: "summary" });
    if (command.type === "reset") {
      this.runtime.engine.reset();
      this.runtime.usage.reset();
      this.status = await resetStatus(this.runtime);
      this.append(systemLine("transcript reset"));
      return;
    }
    if (command.type === "state") {
      const contextMetrics = await this.runtime.engine.contextMetrics();
      this.append(systemLine(formatReplData({ ...this.runtime.engine.snapshot(), contextMetrics, communicationLog: this.runtime.communicationLogger.snapshot() }, 12000), EXPANDED_SUMMARY_MAX_LINES));
      return;
    }
    if (command.type === "new") {
      await this.newSession();
      return;
    }
    if (command.type === "sessions") {
      const sessions = await this.runtime.engine.listSessions(30);
      void sessions;
      if (sessions.length === 0) this.append(systemLine("No saved sessions found."));
      this.broadcastSync();
      return;
    }
    if (command.type === "export") {
      this.setBusy(true);
      this.setStatus({ ...this.status, phase: "running", detail: "exporting session", activityTick: this.status.activityTick + 1 });
      try {
        this.append(await handleExportCommand(command.path, this.runtime));
      } finally {
        this.setBusy(false);
        this.setStatus({ ...this.status, phase: "ready", detail: undefined, activityTick: this.status.activityTick + 1 });
      }
      return;
    }
    if (command.type === "env") {
      const envDirectory = path.dirname(this.runtime.envPath);
      try {
        await fs.mkdir(envDirectory, { recursive: true });
        await openDirectory(envDirectory);
        this.append({ kind: "system", title: "System", text: `Opened env directory: ${envDirectory}`, format: "plain", previewStyle: "summary" });
      } catch (error) {
        this.append({ kind: "error", text: `Failed to open env directory ${envDirectory}: ${error instanceof Error ? error.message : String(error)}`, format: "plain" });
      }
      return;
    }
    if (command.type === "log") {
      await handleLogCommand(command, this.runtime, (line) => this.append(line));
      return;
    }
    if (command.type === "model") {
      this.setBusy(true);
      this.setStatus({ ...this.status, phase: "running", detail: "saving model settings", activityTick: this.status.activityTick + 1 });
      try {
        this.append(await handleModelCommand(command, this.runtime));
        const metrics = await this.runtime.engine.contextMetrics();
        this.setStatus({ ...this.status, phase: "ready", detail: undefined, metrics, activityTick: this.status.activityTick + 1 });
      } finally {
        this.setBusy(false);
      }
      return;
    }
    if (command.type === "compact" || command.type === "pure") {
      await this.runCompaction(command.type);
      return;
    }
    if (command.type === "login") {
      this.broadcastSync();
      return;
    }
    if (command.type === "skill") {
      this.append({ kind: "error", text: "/skill is currently available in the interactive REPL only." });
      return;
    }
    if (command.type === "secret") {
      this.append({ kind: "error", text: "/secret is currently available in the interactive REPL only." });
      return;
    }
    if (text.trimStart().startsWith("/")) {
      this.append({ kind: "error", text: `Unknown or incomplete command: ${text.trim()}\nType /help for commands.` });
      return;
    }

    const promptPayload = buildWebPromptPayload(command.text, attachments);
    this.append({ kind: "user", text: promptPayload.displayText });
    const optimisticImageLabels = (promptPayload.blocks ?? [])
      .filter((block): block is Extract<MessageBlock, { type: "image" }> => block.type === "image" && typeof block.label === "string")
      .map((block) => block.label as string);
    this.pendingUserImageEchoLabels = optimisticImageLabels.length ? optimisticImageLabels : undefined;
    const runToken = ++this.foregroundRunToken;
    const abortController = new AbortController();
    this.activeAbortController = abortController;
    this.interruptArmed = false;
    this.setBusy(true);
    this.setStatus({ ...this.status, phase: "running", detail: "working", usage: undefined, streamedOutputTokens: 0, inputTokenUpdatedAt: undefined, outputTokenUpdatedAt: undefined, retryCooldownUntil: undefined });
    const engine = this.runtime.engine;
    try {
      for await (const event of engine.sendUserText(promptPayload.text, { abortSignal: abortController.signal, blocks: promptPayload.blocks, displayText: promptPayload.displayText })) {
        if (this.foregroundRunToken !== runToken) continue;
        if (this.runtime.engine !== engine) continue;
        if (this.suppressReattachedStreaming.has(engine)) {
          if (event.type === "message" || event.type === "terminal" || event.type === "error" || event.type === "context.metrics" || event.type === "usage") {
            if (event.type === "message" || event.type === "terminal" || event.type === "error") this.suppressReattachedStreaming.delete(engine);
            this.handleEvent(event);
          }
          continue;
        }
        this.handleEvent(event);
      }
    } catch (error) {
      if (this.foregroundRunToken === runToken && this.runtime.engine === engine) {
        this.finalizeForegroundView();
        this.append({ kind: "error", text: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      if (this.foregroundRunToken !== runToken) return;
      if (this.runtime.engine !== engine) return;
      if (this.activeAbortController === abortController) this.activeAbortController = undefined;
      this.interruptArmed = false;
      this.finalizeForegroundView();
      this.pendingUserImageEchoLabels = undefined;
      const queuedText = this.queuedInput;
      const queuedAttach = this.queuedAttachments;
      this.queuedInput = undefined;
      this.queuedAttachments = undefined;
      if (queuedText !== undefined) {
        this.startRun(queuedText, queuedAttach ?? []);
        this.broadcastSync();
      } else {
        this.setBusy(false);
        this.setStatus({ ...this.status, phase: "ready", detail: undefined, inputTokenUpdatedAt: undefined, outputTokenUpdatedAt: undefined, retryCooldownUntil: undefined });
        this.broadcastSync();
      }
    }
  }

  private async runCompaction(type: "compact" | "pure"): Promise<void> {
    const runToken = ++this.foregroundRunToken;
    const abortController = new AbortController();
    this.activeAbortController = abortController;
    this.interruptArmed = false;
    this.setBusy(true);
    this.setStatus({ ...this.status, phase: "compacting", detail: type === "compact" ? "manual compact" : "pure compact", activityTick: this.status.activityTick + 1 });
    try {
      const result = type === "compact"
        ? await this.runtime.engine.compact({ abortSignal: abortController.signal })
        : await this.runtime.engine.pureCompact({ abortSignal: abortController.signal });
      if (this.foregroundRunToken !== runToken) return;
      const metrics = await this.runtime.engine.contextMetrics();
      if (this.foregroundRunToken !== runToken) return;
      this.append(systemLine(type === "compact" ? formatManualCompaction(result) : formatPureCompaction(result)));
      this.handleEvent({ type: "context.metrics", metrics });
    } catch (error) {
      if (this.foregroundRunToken === runToken) this.append({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      if (this.foregroundRunToken !== runToken) return;
      if (this.activeAbortController === abortController) this.activeAbortController = undefined;
      this.interruptArmed = false;
      this.setBusy(false);
      this.setStatus({ ...this.status, phase: "ready", detail: undefined, activityTick: this.status.activityTick + 1 });
    }
  }

  private send(subscriber: WebSubscriber, event: string, data: unknown): void {
    if (subscriber.blocked) {
      subscriber.needsSync = true;
      return;
    }
    const eventId = ++this.eventSequence;
    const frame = `id: ${eventId}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    if (subscriber.response.write(frame)) return;
    subscriber.blocked = true;
    subscriber.response.once("drain", () => {
      subscriber.blocked = false;
      if (!subscriber.needsSync || subscriber.response.destroyed) return;
      subscriber.needsSync = false;
      this.send(subscriber, "sync", this.snapshot(false));
    });
  }

  private broadcastDelta(operation: WebLineOperation): void {
    this.queueDeltaOperation(operation);
  }

  private queueDeltaOperation(operation: WebLineOperation): void {
    this.pendingDeltaOperations.push(operation);
    this.scheduleDeltaFlush();
  }

  private queueDeltaStatus(): void {
    this.pendingDeltaStatus = true;
    this.scheduleDeltaFlush();
  }

  private scheduleDeltaFlush(): void {
    if (this.pendingDeltaTimer) return;
    this.pendingDeltaTimer = setTimeout(() => this.flushDeltaOperations(), 25);
    this.pendingDeltaTimer.unref?.();
  }

  private flushDeltaOperations(): void {
    this.pendingDeltaTimer = undefined;
    if (this.pendingDeltaOperations.length === 0 && !this.pendingDeltaStatus) return;
    const operations = compactLineOperations(this.pendingDeltaOperations);
    this.pendingDeltaOperations = [];
    this.pendingDeltaStatus = false;
    const payload: WebDeltaPayload = {
      protocolVersion: 2,
      sessionId: this.runtime.engine.snapshot().session?.sessionId,
      operations,
      status: this.status,
    };
    for (const subscriber of this.subscribers) this.send(subscriber, "delta", payload);
  }

  private discardPendingDeltaOperations(): void {
    if (this.pendingDeltaTimer) clearTimeout(this.pendingDeltaTimer);
    this.pendingDeltaTimer = undefined;
    this.pendingDeltaOperations = [];
    this.pendingDeltaStatus = false;
  }

  private broadcastSync(): void {
    this.discardPendingDeltaOperations();
    const payload = this.snapshot(false);
    for (const subscriber of this.subscribers) this.send(subscriber, "sync", payload);
  }
}

export function compactLineOperations(operations: WebLineOperation[]): WebLineOperation[] {
  const compacted: WebLineOperation[] = [];
  for (const operation of operations) {
    const previous = compacted.at(-1);
    if (operation.type === "line.text.append" && previous?.type === "line.text.append" && previous.id === operation.id) {
      previous.text += operation.text;
      continue;
    }
    if (operation.type === "line.patch" && previous?.type === "line.patch" && previous.id === operation.id) {
      previous.patch = { ...previous.patch, ...operation.patch };
      continue;
    }
    compacted.push(operation.type === "line.patch" ? { ...operation, patch: { ...operation.patch } } : { ...operation });
  }
  return compacted;
}

function reqKeepAlive(res: ServerResponse): void {
  const timer = setInterval(() => res.write(": keep-alive\n\n"), 25_000);
  timer.unref?.();
  res.on("close", () => clearInterval(timer));
}

async function route(req: IncomingMessage, res: ServerResponse, router: WebRuntimeRouter): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  try {
    if (req.method === "GET" && url.pathname === "/") return sendHtml(res, WEB_HTML);
    if (req.method === "GET" && url.pathname === "/vendor/marked.esm.js") return sendFile(res, markedAssetPath, "text/javascript; charset=utf-8");
    if (req.method === "GET" && url.pathname === "/vendor/highlight.min.js") return sendFile(res, highlightAssetPath, "text/javascript; charset=utf-8");
    if (req.method === "GET" && url.pathname === "/vendor/highlight-theme.css") return sendFile(res, highlightThemeAssetPath, "text/css; charset=utf-8");
    const scope = webRuntimeScopeFromUrl(url);
    const repl = await router.get(scope);
    if (req.method === "GET" && url.pathname === "/events") return repl.subscribe(res);
    if (req.method === "GET" && url.pathname === "/api/state") return sendJson(res, repl.snapshot(true));
    const imageMatch = /^\/api\/images\/([^/]+)\/(\d+)$/u.exec(url.pathname);
    if (req.method === "GET" && imageMatch) {
      const payload = repl.imagePayload(decodeURIComponent(imageMatch[1]), Number(imageMatch[2]));
      return payload ? sendImage(res, payload) : sendJson(res, { error: "image not found" }, 404);
    }
    if (req.method === "GET" && url.pathname === "/api/app-prompt") return sendJson(res, repl.appPrompt());
    if (req.method === "POST" && url.pathname === "/api/app-prompt") {
      const body = await readJsonBody<WebSetAppPromptPayload>(req);
      return sendJson(res, repl.setAppPrompt(body));
    }
    if (req.method === "POST" && url.pathname === "/api/fast-mode") {
      const body = await readJsonBody<{ enabled?: boolean }>(req);
      return sendJson(res, await repl.setFastMode(body.enabled === true));
    }
    if (req.method === "POST" && url.pathname === "/api/submit") {
      const body = await readJsonBody<{ text?: string; attachments?: WebAttachmentPayload[] }>(req);
      return sendJson(res, await repl.submit(String(body.text ?? ""), sanitizeWebAttachments(body.attachments)));
    }
    if (req.method === "POST" && url.pathname === "/api/interrupt") return sendJson(res, repl.interrupt());
    if (req.method === "POST" && url.pathname === "/api/queue/cancel") return sendJson(res, repl.cancelQueue());
    if (req.method === "GET" && url.pathname === "/api/sessions") return sendJson(res, await repl.listSessions());
    if (req.method === "POST" && url.pathname === "/api/sessions/resume") {
      const body = await readJsonBody<{ sessionId?: string }>(req);
      return sendJson(res, await repl.resumeSession(String(body.sessionId ?? "")));
    }
    if (req.method === "POST" && url.pathname === "/api/sessions/new") return sendJson(res, await repl.newSession());
    if (req.method === "POST" && url.pathname === "/api/sessions/delete") {
      const body = await readJsonBody<{ sessionId?: string }>(req);
      return sendJson(res, await repl.deleteSession(String(body.sessionId ?? "")));
    }
    if (req.method === "GET" && url.pathname === "/api/login") return sendJson(res, repl.loginForm(url.searchParams.get("provider") ?? undefined));
    if (req.method === "POST" && url.pathname === "/api/login") {
      const body = await readJsonBody<{ provider?: string; values?: Record<string, string> }>(req);
      return sendJson(res, await repl.saveLogin(String(body.provider ?? ""), body.values ?? {}));
    }
    sendJson(res, { error: "not found" }, 404);
  } catch (error) {
    sendJson(res, { error: error instanceof Error ? error.message : String(error) }, 500);
  }
}

function webRuntimeScopeFromUrl(url: URL): WebRuntimeScope {
  return {
    tabId: optionalSearchParam(url, "tabId"),
    sessionId: optionalSearchParam(url, "sessionId"),
  };
}

function optionalSearchParam(url: URL, key: string): string | undefined {
  const value = url.searchParams.get(key)?.trim();
  return value ? value : undefined;
}

function sendHtml(res: ServerResponse, body: string): void {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}

async function sendFile(res: ServerResponse, filepath: string, contentType: string): Promise<void> {
  const body = await fs.readFile(filepath);
  res.writeHead(200, { "Content-Type": contentType, "Cache-Control": "public, max-age=3600" });
  res.end(body);
}

function sendJson(res: ServerResponse, value: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(value));
}

function sendImage(res: ServerResponse, payload: { body: Buffer; mimeType: string }): void {
  res.writeHead(200, {
    "Content-Type": payload.mimeType,
    "Content-Length": String(payload.body.length),
    "Cache-Control": "private, max-age=31536000, immutable",
  });
  res.end(payload.body);
}

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  if (chunks.length === 0) return {} as T;
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
}

function sanitizeWebAttachments(value: unknown): WebAttachmentPayload[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is WebAttachmentPayload => {
    if (!isRecord(item)) return false;
    return item.kind === "image" && typeof item.label === "string" && /^\[img#\d+\]$/.test(item.label) && typeof item.mimeType === "string" && item.mimeType.startsWith("image/") && typeof item.data === "string";
  });
}

function webCatalog(runtime: WebRuntime) {
  const modelIds = [...new Set(loadModelCatalog().models.flatMap((model) => model.modelIds.length ? model.modelIds : [model.id]))].sort((left, right) => left.localeCompare(right));
  return {
    commands: replCommandDefinitions,
    modelIds,
    reasoning: ["none", "minimal", "low", "medium", "high", "xhigh", "max", "default", "off"],
    envPath: runtime.envPath,
  };
}

function webInteractiveCatalog(runtime: WebRuntime) {
  return {
    sessions: true,
    login: createLoginFormPayload(runtime.envPath),
  };
}

function initialLines(runtime: WebRuntime, lineId: { current: number }): UiLine[] {
  const lines: UiLine[] = [];
  lineId.current = 0;
  if (runtime.envNotice) lines.push({ id: ++lineId.current, kind: "system", title: "Config", text: runtime.envNotice, format: "plain", previewStyle: "summary" });
  for (const line of restoredHistoryLines(runtime)) lines.push({ id: ++lineId.current, ...line });
  return lines;
}

function restoredHistoryLines(runtime: WebRuntime): Omit<UiLine, "id">[] {
  const lines: Omit<UiLine, "id">[] = [];
  const append = (line: Omit<UiLine, "id">) => {
    lines.push(line);
    return lines.length;
  };
  for (const message of runtime.engine.getHistoryMessages()) renderMessage(message, append, undefined, { includeToolUseBlocks: true, includeThinkingBlocks: false });
  return lines;
}

function initialStatus(runtime: WebRuntime, metrics = runtime.initialMetrics): UiStatus {
  return { phase: "ready", metrics: { ...metrics, messageCount: runtime.engine.snapshot().messages }, streamedOutputTokens: 0, activityTick: 0 };
}

async function resetStatus(runtime: WebRuntime): Promise<UiStatus> {
  return initialStatus(runtime, await runtime.engine.contextMetrics());
}

function buildWebPromptPayload(displayText: string, attachments: readonly WebAttachmentPayload[]): { text: string; displayText: string; blocks?: MessageBlock[] } {
  const activeAttachments = attachments.filter((attachment) => displayText.includes(attachment.label));
  if (activeAttachments.length === 0) return { text: displayText, displayText };
  const blocks: MessageBlock[] = [];
  let cursor = 0;
  while (cursor < displayText.length) {
    const next = nextWebAttachmentOccurrence(displayText, activeAttachments, cursor);
    if (!next) {
      pushTextBlock(blocks, displayText.slice(cursor));
      break;
    }
    pushTextBlock(blocks, displayText.slice(cursor, next.index));
    blocks.push({ type: "image", mimeType: next.attachment.mimeType, data: next.attachment.data, label: next.attachment.label });
    cursor = next.index + next.attachment.label.length;
  }
  const text = blocks.map((block) => block.type === "text" ? block.text : block.type === "image" ? block.label ?? "[image]" : "").join("");
  return { text, displayText: text, blocks };
}

function nextWebAttachmentOccurrence(text: string, attachments: readonly WebAttachmentPayload[], start: number): { index: number; attachment: WebAttachmentPayload } | undefined {
  let best: { index: number; attachment: WebAttachmentPayload } | undefined;
  for (const attachment of attachments) {
    const index = text.indexOf(attachment.label, start);
    if (index === -1) continue;
    if (!best || index < best.index) best = { index, attachment };
  }
  return best;
}

function pushTextBlock(blocks: MessageBlock[], text: string): void {
  if (!text) return;
  const previous = blocks[blocks.length - 1];
  if (previous?.type === "text") previous.text += text;
  else blocks.push({ type: "text", text });
}

function reduceStatus(status: UiStatus, event: AgentEvent): UiStatus {
  if (event.type === "state") return { ...status, phase: event.phase, detail: event.detail, currentTool: event.phase === "running_tools" ? status.currentTool : undefined, usage: event.phase === "preparing" ? undefined : status.usage, streamedOutputTokens: event.phase === "preparing" ? 0 : status.streamedOutputTokens, inputTokenUpdatedAt: event.phase === "preparing" ? undefined : status.inputTokenUpdatedAt, outputTokenUpdatedAt: event.phase === "preparing" ? undefined : status.outputTokenUpdatedAt, retryCooldownUntil: event.phase === "preparing" ? undefined : status.retryCooldownUntil, activityTick: status.activityTick + 1 };
  if (event.type === "context.metrics") return { ...status, metrics: event.metrics, inputTokenUpdatedAt: event.metrics.estimatedInputTokens !== status.metrics?.estimatedInputTokens ? Date.now() : status.inputTokenUpdatedAt, activityTick: status.activityTick + 1 };
  if (event.type === "usage") return { ...status, usage: event.usage, inputTokenUpdatedAt: event.usage.inputTokens !== undefined ? Date.now() : status.inputTokenUpdatedAt, outputTokenUpdatedAt: event.usage.outputTokens !== undefined ? Date.now() : status.outputTokenUpdatedAt, activityTick: status.activityTick + 1 };
  if (event.type === "assistant.delta") return { ...status, phase: "calling_model", streamedOutputTokens: status.streamedOutputTokens + estimateTokens(event.text), outputTokenUpdatedAt: Date.now(), activityTick: status.activityTick + 1 };
  if (event.type === "thinking.delta") return { ...status, phase: "thinking", streamedOutputTokens: status.streamedOutputTokens + estimateTokens(event.text), outputTokenUpdatedAt: Date.now(), activityTick: status.activityTick + 1 };
  if (event.type === "tool_call.delta") return { ...status, phase: "calling_model", streamedOutputTokens: status.streamedOutputTokens + estimateTokens(event.argumentsDelta), outputTokenUpdatedAt: Date.now(), activityTick: status.activityTick + 1 };
  if (event.type === "retrying") return { ...status, phase: "calling_model", detail: `retrying in ${(event.delayMs / 1000).toFixed(1)}s`, retryCooldownUntil: Date.now() + event.delayMs, activityTick: status.activityTick + 1 };
  if (event.type === "tool.started") return { ...status, phase: "running_tools", currentTool: { id: event.toolUse.id, name: event.toolUse.name, input: event.toolUse.input, startedAt: Date.now() }, activityTick: status.activityTick + 1 };
  if (event.type === "tool.finished") return { ...status, currentTool: status.currentTool?.id === event.toolUse.id ? undefined : status.currentTool, activityTick: status.activityTick + 1 };
  if (event.type === "terminal") return { ...status, phase: "stopped", detail: event.reason, currentTool: undefined, inputTokenUpdatedAt: undefined, outputTokenUpdatedAt: undefined, retryCooldownUntil: undefined, activityTick: status.activityTick + 1 };
  if (event.type === "message" || event.type === "error") return { ...status, activityTick: status.activityTick + 1 };
  return status;
}

async function handleExportCommand(outputPath: string, runtime: WebRuntime): Promise<Omit<UiLine, "id">> {
  const snapshot = runtime.engine.snapshot();
  if (!snapshot.session) throw new Error("session transcripts are disabled; cannot export current session");
  const promptSnapshot = await runtime.engine.promptExportSnapshot();
  const result = await writeSessionMarkdownExport({
    outputPath,
    session: snapshot.session,
    agentId: snapshot.agentId,
    promptSnapshot,
    engineSnapshot: { ...snapshot, communicationLog: runtime.communicationLogger.snapshot(), usage: runtime.usage.snapshot() },
  });
  return systemLine(`Exported current session to ${result.outputPath}\nEntries: ${result.entries}\nMessages: ${result.messages}\nBytes: ${result.bytes}`);
}

async function handleLogCommand(command: Extract<ReturnType<typeof parseReplCommand>, { type: "log" }>, runtime: WebRuntime, append: (line: Omit<UiLine, "id">) => number): Promise<void> {
  if (command.off) {
    runtime.communicationLogger.setDirectory(undefined);
    append(systemLine("model communication logging disabled"));
    return;
  }
  if (!command.path || !path.isAbsolute(command.path)) {
    append({ kind: "error", text: "usage: /log <absolute-directory> or /log off" });
    return;
  }
  await fs.mkdir(command.path, { recursive: true });
  runtime.communicationLogger.setDirectory(command.path);
  append(systemLine(`model communication logs: ${path.resolve(command.path)}`));
}

async function handleModelCommand(command: Extract<ReturnType<typeof parseReplCommand>, { type: "model" }>, runtime: WebRuntime): Promise<Omit<UiLine, "id">> {
  const current = runtime.engine.getModelSettings();
  const nextModel = command.model ?? current.model;
  const validationError = validateModelReasoningArgument(nextModel, command.reasoning);
  if (validationError) return { kind: "error", text: validationError };
  const reasoningUpdate = resolveModelReasoningUpdate(command.reasoning, current.reasoning, nextModel, command.model !== undefined);
  const changed = command.model !== undefined || command.reasoning !== undefined;
  if (changed) {
    runtime.engine.setModel(nextModel, reasoningUpdate.reasoning, reasoningUpdate.update);
    try {
      const { providerChanged } = await persistModelCommandSettings(runtime, command, reasoningUpdate);
      if (providerChanged) {
        const config = readModelProviderConfig(process.env);
        if (config) {
          const innerGateway = createModelGatewayFromConfig(config);
          runtime.modelGateway.setInner(innerGateway);
          runtime.agentRuntime.modelGateway = runtime.modelGateway;
          runtime.engine.setModelProvider({ modelGateway: runtime.modelGateway, model: config.model, fallbackModel: config.fallbackModel, reasoning: config.defaultReasoning });
          syncImageGenerationTool(runtime, config.provider);
          runtime.defaultReasoning = config.defaultReasoning;
        }
      }
    } catch (error) {
      return { kind: "error", text: `Model settings changed for this session, but saving to ${runtime.envPath} failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  const settings = formatModelSettings(runtime.engine.getModelSettings(), runtime.defaultReasoning);
  return systemLine(changed ? `${settings}\nSaved to ${runtime.envPath}` : settings);
}

function resolveModelReasoningUpdate(value: ModelReasoningArgument | undefined, current: ReasoningConfig | null | undefined, modelId: string | undefined, modelChanged: boolean): { reasoning: ReasoningConfig | null | undefined; update: boolean } {
  if (value === "off") return { reasoning: null, update: true };
  if (value === "default") return { reasoning: undefined, update: true };
  if (value !== undefined) return { reasoning: { effort: value as ReasoningEffort }, update: true };
  if (modelChanged && current?.effort && !reasoningEffortsForModel(modelId)?.includes(current.effort)) return { reasoning: undefined, update: true };
  return { reasoning: current, update: false };
}

async function persistModelCommandSettings(runtime: WebRuntime, command: Extract<ReturnType<typeof parseReplCommand>, { type: "model" }>, reasoningUpdate: { reasoning: ReasoningConfig | null | undefined; update: boolean }): Promise<{ providerChanged: boolean }> {
  const currentProvider = currentModelProvider();
  let targetProvider = currentProvider;
  const updates: Record<string, string | undefined> = {};
  if (command.model !== undefined) {
    const metadata = findModelMetadata(command.model);
    if (metadata) {
      const modelProvider = parseLoginProvider(metadata.provider);
      if (modelProvider) {
        targetProvider = modelProvider;
        if (targetProvider !== currentProvider) updates.MODEL_PROVIDER = targetProvider;
      }
    }
    updates[modelEnvKeyForProvider(targetProvider)] = command.model.trim() || undefined;
  }
  if (command.reasoning !== undefined || reasoningUpdate.update) {
    updates.MODEL_REASONING_EFFORT = envValueForReasoning(reasoningUpdate.reasoning);
    updates.MODEL_REASONING_SUMMARY = undefined;
  }
  if (Object.keys(updates).length === 0) return { providerChanged: false };
  await writeEnvUpdates(runtime.envPath, updates);
  applyEnvUpdatesToProcess(updates);
  runtime.defaultReasoning = reasoningUpdate.update ? reasoningUpdate.reasoning : runtime.defaultReasoning;
  return { providerChanged: targetProvider !== currentProvider };
}

function currentModelProvider(): ModelProviderName {
  return parseLoginProvider(process.env.MODEL_PROVIDER) ?? (process.env.ANTHROPIC_API_KEY ? "anthropic" : "openai");
}

function parseLoginProvider(value: string | undefined): ModelProviderName | undefined {
  if (value === "openai" || value === "anthropic") return value;
  return undefined;
}

const LOGIN_PROVIDERS: LoginProviderName[] = ["openai", "anthropic"];

const SHARED_LOGIN_FIELDS: LoginFieldDefinition[] = [
  { key: "reasoningEffort", label: "Reasoning effort", envKey: "MODEL_REASONING_EFFORT", scope: "shared", options: ["", "off", "none", "minimal", "low", "medium", "high", "xhigh", "max"] },
  { key: "reasoningSummary", label: "Reasoning summary", envKey: "MODEL_REASONING_SUMMARY", scope: "shared", options: ["", "auto", "concise", "detailed"] },
  { key: "maxOutputTokens", label: "Max output tokens", envKey: "MODEL_MAX_OUTPUT_TOKENS", scope: "shared", placeholder: "800" },
  { key: "timeoutMs", label: "Timeout ms", envKey: "MODEL_TIMEOUT_MS", scope: "shared", placeholder: "120000" },
  { key: "streamIdleTimeoutMs", label: "Stream idle timeout ms", envKey: "MODEL_STREAM_IDLE_TIMEOUT_MS", scope: "shared", placeholder: "120000" },
  { key: "maxRetries", label: "Max retries", envKey: "MODEL_MAX_RETRIES", scope: "shared", placeholder: "2" },
];

const LOGIN_FIELD_DEFINITIONS: Record<LoginProviderName, LoginFieldDefinition[]> = {
  openai: [
    { key: "apiKey", label: "API key", envKey: "OPENAI_API_KEY", scope: "provider", required: true, secret: true, placeholder: "sk-..." },
    { key: "baseUrl", label: "Base URL", envKey: "OPENAI_BASE_URL", scope: "provider", placeholder: "https://api.openai.com" },
    { key: "model", label: "Model", envKey: "OPENAI_MODEL", scope: "provider", required: true, placeholder: "gpt-5.6" },
    { key: "fallbackModel", label: "Fallback model", envKey: "OPENAI_FALLBACK_MODEL", scope: "provider" },
    { key: "endpoint", label: "Endpoint", envKey: "OPENAI_ENDPOINT", scope: "provider", placeholder: "auto", options: ["auto", "responses", "chat"] },
    ...SHARED_LOGIN_FIELDS,
  ],
  anthropic: [
    { key: "apiKey", label: "API key", envKey: "ANTHROPIC_API_KEY", scope: "provider", required: true, secret: true, placeholder: "sk-ant-..." },
    { key: "baseUrl", label: "Base URL", envKey: "ANTHROPIC_BASE_URL", scope: "provider", placeholder: "https://api.anthropic.com" },
    { key: "model", label: "Model", envKey: "ANTHROPIC_MODEL", scope: "provider", required: true, placeholder: "claude-sonnet-4-6" },
    { key: "fallbackModel", label: "Fallback model", envKey: "ANTHROPIC_FALLBACK_MODEL", scope: "provider" },
    { key: "version", label: "Anthropic version", envKey: "ANTHROPIC_VERSION", scope: "provider", placeholder: "2023-06-01" },
    ...SHARED_LOGIN_FIELDS,
  ],
};

const DEPRECATED_MODEL_ENV_KEYS = [
  "MODEL_API_KEY", "MODEL_BASE_URL", "MODEL_ID", "MODEL_FALLBACK_ID", "MODEL_ENDPOINT", "OPENAI_PROVIDER",
  "OPENAI_REASONING_EFFORT", "OPENAI_REASONING_SUMMARY", "OPENAI_MAX_OUTPUT_TOKENS", "OPENAI_TIMEOUT_MS", "OPENAI_STREAM_IDLE_TIMEOUT_MS", "OPENAI_MAX_RETRIES",
  "ANTHROPIC_REASONING_EFFORT", "ANTHROPIC_REASONING_SUMMARY", "ANTHROPIC_MAX_OUTPUT_TOKENS", "ANTHROPIC_TIMEOUT_MS", "ANTHROPIC_STREAM_IDLE_TIMEOUT_MS", "ANTHROPIC_MAX_RETRIES",
];

function createLoginFormPayload(envPath: string, provider?: LoginProviderName): LoginFormPayload {
  const env = parseEnvFileSafe(envPath);
  const selectedProvider = provider ?? parseLoginProvider(env.MODEL_PROVIDER ?? process.env.MODEL_PROVIDER) ?? guessLoginProvider(env);
  return {
    envPath,
    providers: LOGIN_PROVIDERS,
    provider: selectedProvider,
    fields: LOGIN_FIELD_DEFINITIONS[selectedProvider],
    values: loginValuesForProvider(selectedProvider, env),
  };
}

function loginValuesForProvider(provider: LoginProviderName, env: Record<string, string>): Record<string, string> {
  const values: Record<string, string> = {};
  for (const field of LOGIN_FIELD_DEFINITIONS[provider]) values[field.key] = env[field.envKey] ?? "";
  if (!values.baseUrl) values.baseUrl = defaultBaseUrlForLoginProvider(provider);
  if (!values.model) values.model = defaultModelForLoginProvider(provider);
  if (provider === "openai" && !values.endpoint) values.endpoint = "auto";
  return values;
}

function guessLoginProvider(env: Record<string, string>): LoginProviderName {
  if (env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY) return "anthropic";
  return currentModelProvider();
}

function defaultBaseUrlForLoginProvider(provider: LoginProviderName): string {
  if (provider === "anthropic") return "https://api.anthropic.com";
  return "https://api.openai.com";
}

function defaultModelForLoginProvider(provider: LoginProviderName): string {
  if (provider === "anthropic") return "claude-sonnet-4-6";
  return "gpt-5.6";
}

function validateLoginFormPayload(payload: LoginFormPayload): string | undefined {
  for (const field of LOGIN_FIELD_DEFINITIONS[payload.provider]) {
    const value = (payload.values[field.key] ?? "").trim();
    if (field.required && !value) return `${field.label} is required.`;
    if (field.options?.length && value && !field.options.includes(value)) return `${field.label} must be one of: ${field.options.filter(Boolean).join(", ")}`;
  }
  for (const fieldKey of ["maxOutputTokens", "timeoutMs", "streamIdleTimeoutMs", "maxRetries"]) {
    const value = payload.values[fieldKey]?.trim();
    if (value && !Number.isFinite(Number(value))) return `${fieldKey} must be a number.`;
  }
  return undefined;
}

async function saveLoginPayloadToEnv(payload: LoginFormPayload): Promise<void> {
  await writeEnvUpdates(payload.envPath, envEntriesForLoginPayload(payload), DEPRECATED_MODEL_ENV_KEYS);
}

function applyLoginPayloadToProcessEnv(payload: LoginFormPayload): void {
  applyEnvUpdatesToProcess(envEntriesForLoginPayload(payload));
  for (const key of DEPRECATED_MODEL_ENV_KEYS) delete process.env[key];
}

function envEntriesForLoginPayload(payload: LoginFormPayload): Record<string, string | undefined> {
  const entries: Record<string, string | undefined> = { MODEL_PROVIDER: payload.provider };
  for (const field of LOGIN_FIELD_DEFINITIONS[payload.provider]) {
    const value = (payload.values[field.key] ?? "").trim();
    entries[field.envKey] = value || undefined;
  }
  return entries;
}

function parseEnvFileSafe(envPath: string): Record<string, string> {
  if (!existsSync(envPath)) return {};
  const env: Record<string, string> = {};
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const parsed = parseEnvLine(line);
    if (parsed) env[parsed.key] = stripEnvQuotes(parsed.value.trim());
  }
  return env;
}

function stripEnvQuotes(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1);
  return value;
}

function modelEnvKeyForProvider(provider: ModelProviderName): "OPENAI_MODEL" | "ANTHROPIC_MODEL" {
  if (provider === "anthropic") return "ANTHROPIC_MODEL";
  return "OPENAI_MODEL";
}

function envValueForReasoning(reasoning: ReasoningConfig | null | undefined): string | undefined {
  if (reasoning === null) return "off";
  return reasoning?.effort;
}

async function writeEnvUpdates(envPath: string, updates: Record<string, string | undefined>, removeKeys: string[] = []): Promise<void> {
  await fs.mkdir(path.dirname(envPath), { recursive: true });
  const existing = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  const next = updateEnvContent(existing, updates, removeKeys);
  await fs.writeFile(envPath, next, "utf8");
}

function updateEnvContent(existing: string, updates: Record<string, string | undefined>, removeKeys: string[] = []): string {
  const keys = new Set(Object.keys(updates));
  const removals = new Set(removeKeys);
  const seen = new Set<string>();
  const lines = existing ? existing.split(/\r?\n/) : [];
  const next = lines.map((line) => {
    const parsed = parseEnvLine(line);
    if (!parsed) return line;
    if (removals.has(parsed.key) && !keys.has(parsed.key)) return undefined;
    if (!keys.has(parsed.key)) return line;
    seen.add(parsed.key);
    const value = updates[parsed.key];
    return value === undefined ? undefined : `${parsed.key}=${formatEnvValue(value)}`;
  }).filter((line): line is string => line !== undefined);
  for (const [key, value] of Object.entries(updates)) {
    if (seen.has(key) || value === undefined) continue;
    next.push(`${key}=${formatEnvValue(value)}`);
  }
  return `${next.join("\n").replace(/\n*$/u, "")}\n`;
}

function parseEnvLine(line: string): { key: string; value: string } | undefined {
  const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
  if (!match) return undefined;
  return { key: match[1], value: match[2] };
}

function formatEnvValue(value: string): string {
  if (/^[A-Za-z0-9_./:@-]*$/.test(value)) return value;
  return JSON.stringify(value);
}

function formatResume(snapshot: { sessionId: string; resumedMessages: number; transcriptPath: string }): string {
  return `resumed session ${snapshot.sessionId}: ${snapshot.resumedMessages} messages from ${snapshot.transcriptPath}`;
}

function applyEnvUpdatesToProcess(updates: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function validateModelReasoningArgument(modelId: string | undefined, reasoning: ModelReasoningArgument | undefined): string | undefined {
  if (!reasoning || reasoning === "default" || reasoning === "off") return undefined;
  if (!modelId) return `Cannot set reasoning effort '${reasoning}' without a configured model. Choose a model first.`;
  const efforts = reasoningEffortsForModel(modelId);
  if (!efforts?.length) return `Model ${modelId} has no configured reasoning effort support; not setting '${reasoning}'.`;
  if (!efforts.includes(reasoning as ReasoningEffort)) return `Model ${modelId} supports reasoning efforts: ${efforts.join(", ")}; not '${reasoning}'.`;
  return undefined;
}

function formatModelSettings(settings: { model?: string; fallbackModel?: string; reasoning?: ReasoningConfig | null }, defaultReasoning: ReasoningConfig | null | undefined): string {
  const window = resolveContextWindowTokens(settings.model);
  const lines = ["Model settings:", `  Model: ${settings.model ?? "<provider default>"}`];
  if (settings.fallbackModel) lines.push(`  Fallback: ${settings.fallbackModel}`);
  lines.push(`  Reasoning effort: ${formatReasoningSetting(settings.reasoning)}`);
  if (defaultReasoning?.effort) lines.push(`  Env default reasoning: ${defaultReasoning.effort}`);
  if (window.model) {
    const efforts = reasoningEffortsForModel(settings.model);
    lines.push(`  Context window: ${window.tokens ? formatNumber(window.tokens) : "?"} tokens`);
    lines.push(`  Supports reasoning: ${window.model.reasoning ? "yes" : "no"}`);
    lines.push(`  Reasoning efforts: ${efforts?.length ? efforts.join(", ") : "<not configurable>"}`);
    lines.push(`  Image input: ${window.model.imageInput ? "yes" : "no"}`);
  }
  return lines.join("\n");
}

function formatReasoningSetting(reasoning: ReasoningConfig | null | undefined): string {
  if (reasoning === null) return "off";
  return reasoning?.effort ?? "default";
}

function renderMessage(message: Message, append: (line: Omit<UiLine, "id">) => number, activeAssistantId?: number, options: { includeToolUseBlocks?: boolean; includeThinkingBlocks?: boolean } = {}): boolean {
  if (message.metadata?.syntheticToolUse === true) return false;
  if (message.role === "progress" || message.isMeta) return false;
  if (message.role === "assistant" && activeAssistantId !== undefined && message.blocks.some((block) => block.type === "text")) return true;
  const parentToolName = typeof message.metadata?.tool === "string" ? message.metadata.tool : undefined;
  let rendered = false;
  for (const [blockIndex, block] of message.blocks.entries()) {
    if (block.type === "text") {
      const kind = kindForRole(message.role);
      if (kind === "meta") continue;
      if (kind === "system") append({ kind, title: titleForRole(message.role), text: block.text, previewStyle: "summary" });
      else append({ kind, text: block.text });
      rendered = true;
    } else if (block.type === "image") {
      const line = imageLineForBlock(message.role, block, message.id, blockIndex);
      if (!line) continue;
      append({ ...line, parentToolName });
      rendered = true;
    } else if (block.type === "thinking") {
      if (options.includeThinkingBlocks === false) continue;
      append(thinkingLine(block.text));
      rendered = true;
    } else if (block.type === "tool_use" && options.includeToolUseBlocks) {
      append({ ...formatToolUse(block), live: false });
      rendered = true;
    } else if (block.type === "tool_result") {
      append(formatToolResultLine(block.name, block.output, block.ok));
      rendered = true;
    }
  }
  return rendered;
}

function renderToolResultMessage(message: Message, append: (line: Omit<UiLine, "id">, toolUseId: string) => number): boolean {
  let rendered = false;
  for (const block of message.blocks) {
    if (block.type !== "tool_result") continue;
    append({ ...formatToolResultLine(block.name, block.output, block.ok), toolUseId: block.toolUseId }, block.toolUseId);
    rendered = true;
  }
  return rendered;
}

function renderMessageImages(message: Message, append: (line: Omit<UiLine, "id">) => number): boolean {
  let rendered = false;
  const parentToolName = typeof message.metadata?.tool === "string" ? message.metadata.tool : undefined;
  const parentToolUseId = message.blocks.find((block) => block.type === "tool_result")?.toolUseId;
  for (const [blockIndex, block] of message.blocks.entries()) {
    if (block.type !== "image") continue;
    const line = imageLineForBlock(message.role, block, message.id, blockIndex);
    if (!line) continue;
    append({ ...line, parentToolName, parentToolUseId });
    rendered = true;
  }
  return rendered;
}

function imageLineForBlock(role: Message["role"], block: Extract<MessageBlock, { type: "image" }>, messageId: string, blockIndex: number): Omit<UiLine, "id"> | undefined {
  const kind = kindForRole(role);
  if (kind === "meta") return undefined;
  return {
    kind,
    text: block.label ?? `[image ${block.mimeType}]`,
    image: {
      src: `/api/images/${encodeURIComponent(messageId)}/${blockIndex}`,
      label: block.label,
      mimeType: block.mimeType,
    },
  };
}

function assistantText(message: Message): string | undefined {
  const text = message.blocks.filter((block) => block.type === "text").map((block) => block.text).join("");
  return text.length > 0 ? text : undefined;
}

function thinkingText(message: Message): string | undefined {
  const text = message.blocks.filter((block) => block.type === "thinking").map((block) => block.text).join("");
  return text.length > 0 ? text : undefined;
}

function kindForRole(role: Message["role"]): UiLine["kind"] {
  if (role === "user") return "user";
  if (role === "assistant") return "assistant";
  if (role === "tool_result") return "tool";
  if (role === "progress") return "meta";
  if (role === "system") return "meta";
  return "system";
}

function titleForRole(role: Message["role"]): string {
  if (role === "progress") return "Meta";
  if (role === "system") return "System";
  if (role === "tool_result") return "Tool result";
  return titleForKind(kindForRole(role));
}

function titleForKind(kind: UiLine["kind"]): string {
  if (kind === "thinking") return "think";
  if (kind === "tool") return "Tool";
  if (kind === "error") return "Error";
  if (kind === "meta") return "Meta";
  if (kind === "system") return "System";
  if (kind === "user") return "User";
  return "Assistant";
}

function systemLine(text: string, summaryMaxLines?: number): Omit<UiLine, "id"> {
  return { kind: "system", title: "System", text, previewStyle: "summary", summaryMaxLines };
}

function thinkingLine(text: string, live = false): Omit<UiLine, "id"> {
  return { kind: "thinking", title: titleForKind("thinking"), text, previewStyle: "summary", summaryMaxLines: THINKING_SUMMARY_MAX_LINES, live };
}

function formatToolUse(toolUse: ToolUseRequest): Omit<UiLine, "id"> {
  if (toolUse.name === "plan" && isPlanToolPayload(toolUse.input)) return { kind: "tool", toolName: toolUse.name, title: toolTitle(toolUse.name, "running"), bodyTitle: planToolBodyTitle(toolUse.input), text: formatPlanToolPayload(toolUse.input), collapsible: true };
  if (toolUse.name === "image2") return { kind: "tool", toolName: toolUse.name, toolUseId: toolUse.id, title: toolTitle(toolUse.name, "running"), bodyTitle: "图片模型处理中", text: JSON.stringify(toolUse.input ?? {}, null, 2), format: "plain", previewStyle: "summary", collapsible: true };
  const summary = summarizeToolUse(toolUse.name, toolUse.input);
  return { kind: "tool", toolName: toolUse.name, title: toolTitle(toolUse.name, "running"), bodyTitle: summary.bodyTitle, text: summary.text, previewStyle: "summary", collapsible: true };
}

function formatToolResultLine(toolName: string, output: unknown, ok: boolean): Omit<UiLine, "id"> {
  const formatted = formatToolResult(toolName, output, ok);
  return { kind: ok ? "tool" : "error", toolName, title: toolTitle(toolName, "finished"), bodyTitle: formatted.bodyTitle, titleStatus: ok ? "success" : "failure", text: formatted.text, format: formatted.format, live: false, previewStyle: formatted.full ? undefined : "summary", summaryMaxLines: formatted.summaryMaxLines, collapsible: true };
}


function toolTitle(toolName: string, _phase: "running" | "finished"): string {
  const labels: Record<string, string> = {
    agent: "子任务",
    edit: "编辑文件",
    exec: "执行命令",
    expose_downloads: "文件下载",
    grep: "搜索文本",
    image2: "图片生成",
    image_note: "记录图片说明",
    list: "列出文件",
    load_image: "读取图片",
    plan: "任务计划",
    read: "读取文件",
    search: "网络搜索",
    write: "写入文件",
  };
  return labels[toolName] ?? toolName;
}

function summarizeToolUse(toolName: string, input: unknown): { text: string; bodyTitle?: string } {
  const purpose = toolUsePurpose(toolName, input);
  return {
    bodyTitle: purpose,
    text: purpose ? `目的：${purpose}` : "正在执行工具…",
  };
}

function toolUsePurpose(toolName: string, input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
  const description = typeof input.description === "string" ? input.description.trim() : "";
  if (description) return description;
  if (toolName === "expose_downloads") return "准备网页下载链接";
  if (toolName === "read" && typeof input.path === "string") return `读取 ${path.basename(input.path)}`;
  if (toolName === "list" && typeof input.path === "string") return `查看 ${input.path}`;
  if (toolName === "grep" && typeof input.query === "string") return `搜索 ${input.query}`;
  if (toolName === "write" && typeof input.path === "string") return `写入 ${path.basename(input.path)}`;
  if (toolName === "edit" && typeof input.path === "string") return `修改 ${path.basename(input.path)}`;
  return undefined;
}

interface PlanToolPayloadLike extends Record<string, unknown> {
  title?: string;
  note?: string;
  summary?: string;
  items: PlanItemLike[];
}

interface PlanItemLike {
  description: string;
  status: "pending" | "in_progress" | "completed";
}

function isPlanToolPayload(value: unknown): value is PlanToolPayloadLike {
  if (!isRecord(value) || !Array.isArray(value.items)) return false;
  return value.items.every((item) => isRecord(item) && typeof item.description === "string" && (item.status === "pending" || item.status === "in_progress" || item.status === "completed"));
}

function planToolBodyTitle(payload: PlanToolPayloadLike): string | undefined {
  const title = payload.title?.trim();
  return title ? title : undefined;
}

function formatPlanToolPayload(payload: PlanToolPayloadLike): string {
  const sections: string[] = [];
  if (payload.summary?.trim()) sections.push(payload.summary.trim());
  if (payload.note?.trim()) sections.push(payload.note.trim());
  sections.push(payload.items.map((item) => item.status === "completed" ? `- ~~${item.description.trim()}~~` : item.status === "in_progress" ? `- ▶ ${item.description.trim()}` : `- ${item.description.trim()}`).join("\n"));
  return sections.filter(Boolean).join("\n");
}

function formatToolResult(toolName: string, output: unknown, ok: boolean): { text: string; bodyTitle?: string; format?: UiLine["format"]; full?: boolean; summaryMaxLines?: number } {
  if ((toolName === "edit" || toolName === "write") && isRecord(output) && isEditToolOutput(output)) return { text: formatEditToolDiff(output, ok), format: "diff", summaryMaxLines: EDIT_TOOL_SUMMARY_MAX_LINES };
  if (isExecOutput(output)) return { text: formatExecToolResult(output, ok), format: "plain", summaryMaxLines: EXPANDED_SUMMARY_MAX_LINES };
  if (toolName === "list" && isRecord(output)) return { text: formatListToolResult(output, ok) };
  if (toolName === "read" && isRecord(output)) return { text: formatReadToolResult(output, ok) };
  if (toolName === "grep" && isRecord(output)) return { text: formatGrepToolResult(output, ok) };
  if (toolName === "search" && isRecord(output)) return { text: formatWebSearchToolResult(output, ok), summaryMaxLines: EXPANDED_SUMMARY_MAX_LINES };
  if (toolName === "image2" && isRecord(output)) return { text: formatImageGenerationToolResult(output, ok), format: "plain", summaryMaxLines: 4 };
  if (toolName === "expose_downloads") return { text: formatExposeDownloadsToolResult(output, ok), full: true, bodyTitle: ok ? "请点击下载" : "下载准备失败" };
  if (toolName === "plan" && isPlanToolPayload(output)) return { text: formatPlanToolPayload(output), full: true, bodyTitle: planToolBodyTitle(output) };
  if (typeof output === "string") return { text: output, format: hasAnsi(output) ? "ansi" : undefined, summaryMaxLines: EXPANDED_SUMMARY_MAX_LINES };
  return { text: `${ok ? "ok" : "failed"}\n${formatReplData(output, 6000)}`, summaryMaxLines: EXPANDED_SUMMARY_MAX_LINES };
}

function formatExposeDownloadsToolResult(output: unknown, ok: boolean): string {
  const downloads = extractDownloadEntries(output);
  if (!ok) return downloads.length ? `下载准备失败\n${formatDownloadEntries(downloads)}` : "下载准备失败";
  if (!downloads.length) return "文件已准备好，请点击下载。";
  return `文件已准备好，请点击下载。\n${formatDownloadEntries(downloads)}`;
}

function formatDownloadEntries(downloads: DownloadEntryLike[]): string {
  return downloads.map((entry) => {
    const filename = entry.filename || entry.name || "下载文件";
    const url = entry.url || (entry.id ? `/api/downloads/${encodeURIComponent(entry.id)}` : "");
    return url ? `- ${filename}: ${url}` : `- ${filename}`;
  }).join("\n");
}

interface DownloadEntryLike extends Record<string, unknown> {
  id?: string;
  filename?: string;
  name?: string;
  url?: string;
}

function extractDownloadEntries(output: unknown): DownloadEntryLike[] {
  if (!isRecord(output)) return [];
  const candidates = [output.downloads, isRecord(output.output) ? output.output.downloads : undefined, isRecord(output.result) ? output.result.downloads : undefined];
  const downloads = candidates.find(Array.isArray);
  return Array.isArray(downloads) ? downloads.filter(isRecord).map((entry) => ({ ...entry })) : [];
}

interface EditToolOutputLike extends Record<string, unknown> {
  path: string;
  operation: string;
  replacements: number;
  patch: EditPatchHunkLike[];
}

interface EditPatchHunkLike {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

function isEditToolOutput(value: Record<string, unknown>): value is EditToolOutputLike {
  return typeof value.path === "string" && typeof value.operation === "string" && typeof value.replacements === "number" && Array.isArray(value.patch) && value.patch.every(isEditPatchHunk);
}

function isEditPatchHunk(value: unknown): value is EditPatchHunkLike {
  return isRecord(value) && typeof value.oldStart === "number" && typeof value.oldLines === "number" && typeof value.newStart === "number" && typeof value.newLines === "number" && Array.isArray(value.lines) && value.lines.every((line) => typeof line === "string");
}

function formatEditToolDiff(output: EditToolOutputLike, ok: boolean): string {
  const lines = [
    `${ok ? output.operation : "failed"} ${output.path}, ${output.replacements} replacement(s)`,
    `--- ${output.path}`,
    `+++ ${output.path}`,
  ];
  for (const hunk of output.patch) {
    lines.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
    lines.push(...formatEditPatchHunkLines(hunk));
  }
  if (output.patch.length === 0) lines.push("no changes");
  return lines.join("\n");
}

function formatEditPatchHunkLines(hunk: EditPatchHunkLike): string[] {
  const oldLineWidth = diffLineNumberWidth(hunk.oldStart, hunk.oldLines);
  const newLineWidth = diffLineNumberWidth(hunk.newStart, hunk.newLines);
  let oldLineNumber = hunk.oldStart;
  let newLineNumber = hunk.newStart;
  return hunk.lines.map((rawLine) => {
    const marker = diffLineMarker(rawLine);
    if (!marker) return rawLine;
    const showOldLineNumber = marker !== "+";
    const showNewLineNumber = marker !== "-";
    const oldLineLabel = showOldLineNumber ? String(oldLineNumber).padStart(oldLineWidth) : " ".repeat(oldLineWidth);
    const newLineLabel = showNewLineNumber ? String(newLineNumber).padStart(newLineWidth) : " ".repeat(newLineWidth);
    if (showOldLineNumber) oldLineNumber += 1;
    if (showNewLineNumber) newLineNumber += 1;
    return `${oldLineLabel} ${newLineLabel} │ ${marker}${rawLine.slice(1)}`;
  });
}

function diffLineNumberWidth(start: number, lineCount: number): number {
  const end = lineCount > 0 ? start + lineCount - 1 : start;
  return Math.max(String(start).length, String(end).length, 2);
}

function diffLineMarker(line: string): "+" | "-" | " " | undefined {
  const marker = line[0];
  return marker === "+" || marker === "-" || marker === " " ? marker : undefined;
}

interface ExecOutputLike extends Record<string, unknown> {
  command: string;
  description?: string;
  exitCode?: number;
  signal?: string;
  durationMs: number;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
}

function isExecOutput(value: unknown): value is ExecOutputLike {
  return isRecord(value) && typeof value.command === "string" && typeof value.durationMs === "number";
}

function formatExecToolResult(output: ExecOutputLike, ok: boolean): string {
  const status = output.timedOut ? "已超时" : ok ? "已完成" : "执行失败";
  const description = typeof output.description === "string" ? output.description.trim() : "";
  const lines = [description ? `目的：${description}` : "执行命令", `状态：${status}`, `耗时：${output.durationMs}ms`];
  const stdout = typeof output.stdout === "string" ? output.stdout.replace(/\s+$/u, "") : "";
  const stderr = typeof output.stderr === "string" ? output.stderr.replace(/\s+$/u, "") : "";
  if (stdout) lines.push("输出：", stdout);
  if (stderr) lines.push("错误：", stderr);
  if (!stdout && !stderr) lines.push(ok ? "无输出。" : "没有捕获到输出。");
  return lines.join("\n");
}

function formatImageGenerationToolResult(output: Record<string, unknown>, ok: boolean): string {
  const error = typeof output.error === "string" ? output.error : undefined;
  const mode = output.mode === "edit" ? "edit" : "generate";
  if (!ok || error) return [`image ${mode} failed`, error ?? formatReplData(output, 1200)].join("\n");
  const provider = typeof output.provider === "string" ? output.provider : "openai";
  const model = typeof output.model === "string" ? output.model : undefined;
  const returnedImages = typeof output.returnedImages === "number" ? output.returnedImages : Array.isArray(output.images) ? output.images.length : undefined;
  const size = typeof output.size === "string" ? output.size : undefined;
  const quality = typeof output.quality === "string" ? output.quality : undefined;
  const format = typeof output.outputFormat === "string" ? output.outputFormat : undefined;
  const sourceImages = typeof output.sourceImages === "number" ? output.sourceImages : undefined;
  const prompt = typeof output.prompt === "string" ? output.prompt.trim() : "";
  const semanticName = typeof output.semanticName === "string" ? output.semanticName.trim() : "";
  const background = typeof output.background === "string" ? output.background : undefined;
  const startedAtIso = typeof output.startedAtIso === "string" ? output.startedAtIso : undefined;
  const finishedAtIso = typeof output.finishedAtIso === "string" ? output.finishedAtIso : undefined;
  const revisedPrompt = Array.isArray(output.images)
    ? output.images
      .filter(isRecord)
      .map((image) => typeof image.revisedPrompt === "string" ? image.revisedPrompt.trim() : "")
      .find((value) => Boolean(value))
    : undefined;
  const lines = [`${mode === "edit" ? "edited" : "generated"} ${returnedImages ?? 0} image${returnedImages === 1 ? "" : "s"}`];
  const details = [provider, model, size, quality && quality !== "auto" ? quality : undefined, format].filter((value): value is string => Boolean(value));
  if (details.length > 0) lines.push(details.join(" · "));
  if (sourceImages !== undefined) lines.push(`source images: ${sourceImages}`);
  const duration = imageGenerationDuration(output);
  if (duration !== undefined) lines.push(`duration: ${duration}ms`);
  if (prompt) lines.push(`prompt: ${prompt}`);
  if (revisedPrompt && revisedPrompt !== prompt) lines.push(`revisedPrompt: ${revisedPrompt}`);
  lines.push(`mode: ${mode}`);
  if (semanticName) lines.push(`semanticName: ${semanticName}`);
  if (background) lines.push(`background: ${background}`);
  if (startedAtIso) lines.push(`startedAt: ${startedAtIso}`);
  if (finishedAtIso) lines.push(`finishedAt: ${finishedAtIso}`);
  return lines.join("\n");
}

function imageGenerationDuration(output: Record<string, unknown>): number | undefined {
  const value = output.duration ?? output.elapsed ?? output.durationMs ?? output.elapsedMs;
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : undefined;
}

function formatListToolResult(output: Record<string, unknown>, ok: boolean): string {
  const pathValue = typeof output.path === "string" ? output.path : "";
  const typeValue = typeof output.type === "string" ? output.type : "result";
  const returnedEntries = typeof output.returnedEntries === "number" ? output.returnedEntries : undefined;
  const totalFiles = typeof output.totalFiles === "number" ? output.totalFiles : undefined;
  const totalDirectories = typeof output.totalDirectories === "number" ? output.totalDirectories : undefined;
  const entries = Array.isArray(output.entries) ? output.entries : [];
  const names = entries.map((entry) => (isRecord(entry) && typeof entry.name === "string" ? entry.name : undefined)).filter((name): name is string => Boolean(name)).slice(0, 5);
  const lines = [ok ? "list result" : "failed"];
  if (pathValue) lines.push(`path: ${pathValue}`);
  lines.push(`type: ${typeValue}`);
  const counts = [returnedEntries !== undefined ? `${returnedEntries} shown` : undefined, totalFiles !== undefined ? `${totalFiles} files` : undefined, totalDirectories !== undefined ? `${totalDirectories} dirs` : undefined].filter((value): value is string => Boolean(value));
  if (counts.length > 0) lines.push(`entries: ${counts.join(" · ")}`);
  if (names.length > 0) lines.push("sample:", ...names.map((name) => `  ${name}`));
  return lines.join("\n");
}

function formatReadToolResult(output: Record<string, unknown>, ok: boolean): string {
  const error = typeof output.error === "string" ? output.error : undefined;
  if (!ok || error) return ["failed", error ?? formatReplData(output, 1200)].join("\n");
  const pathValue = typeof output.path === "string" ? output.path : undefined;
  const startLine = typeof output.startLine === "number" ? output.startLine : undefined;
  const endLine = typeof output.endLine === "number" ? output.endLine : undefined;
  const totalLines = typeof output.totalLines === "number" ? output.totalLines : undefined;
  const hasMoreBefore = output.hasMoreBefore === true;
  const hasMoreAfter = output.hasMoreAfter === true;
  const content = typeof output.content === "string" ? output.content.trimEnd() : "";
  const lines = ["read result"];
  if (pathValue) lines.push(`file: ${pathValue}`);
  if (startLine !== undefined && endLine !== undefined && totalLines !== undefined) {
    const more = [hasMoreBefore ? "more before" : undefined, hasMoreAfter ? "more after" : undefined].filter((value): value is string => Boolean(value)).join(", ");
    lines.push(`range: lines ${startLine}-${endLine} of ${totalLines}${more ? ` (${more})` : ""}`);
  }
  lines.push("content:", content || "(empty range)");
  return lines.join("\n");
}

function formatWebSearchToolResult(output: Record<string, unknown>, ok: boolean): string {
  const error = typeof output.error === "string" ? output.error : undefined;
  if (!ok || error) return ["failed", error ?? formatReplData(output, 1200)].join("\n");
  const provider = typeof output.provider === "string" ? output.provider : "unknown";
  const query = typeof output.query === "string" ? output.query : "";
  const returnedResults = typeof output.returnedResults === "number" ? output.returnedResults : undefined;
  const results = Array.isArray(output.results) ? output.results : [];
  const lines = [`${returnedResults ?? results.length} web result(s) via ${provider}`];
  if (query) lines.push(`query: ${query}`);
  if (output.truncated === true) lines.push("truncated");
  if (results.length === 0) return [...lines, "no results"].join("\n");
  results.slice(0, 8).forEach((item, index) => {
    if (!isRecord(item)) return;
    const title = typeof item.title === "string" && item.title.trim() ? item.title.trim() : "Untitled";
    const url = typeof item.url === "string" ? item.url : "";
    const published = typeof item.published === "string" ? ` · ${item.published}` : "";
    lines.push(`[${index + 1}] ${title}${published}`);
    if (url) lines.push(url);
    const highlights = Array.isArray(item.highlights) ? item.highlights.filter((value): value is string => typeof value === "string" && value.trim().length > 0) : [];
    const snippet = highlights[0] ?? (typeof item.text === "string" ? item.text : undefined);
    if (snippet) lines.push(truncate(snippet.replace(/\s+/gu, " "), 400));
  });
  return lines.join("\n");
}

function formatGrepToolResult(output: Record<string, unknown>, ok: boolean): string {
  const error = typeof output.error === "string" ? output.error : undefined;
  if (!ok || error) return ["failed", error ?? formatReplData(output, 1200)].join("\n");
  const query = typeof output.query === "string" ? output.query : undefined;
  const grepPath = typeof output.grepPath === "string" ? output.grepPath : typeof output.path === "string" ? output.path : undefined;
  const returnedMatches = typeof output.returnedMatches === "number" ? output.returnedMatches : undefined;
  const totalMatchesKnown = typeof output.totalMatchesKnown === "number" ? output.totalMatchesKnown : undefined;
  const truncated = output.truncated === true;
  const matches = Array.isArray(output.matches) ? output.matches.filter(isGrepMatchLike) : [];
  const lines = ["grep result"];
  if (query !== undefined) lines.push(`query: ${query}`);
  if (grepPath !== undefined) lines.push(`path: ${grepPath}`);
  const countParts = [`${returnedMatches ?? matches.length} shown`, totalMatchesKnown !== undefined ? `${totalMatchesKnown} known` : undefined, truncated ? "truncated" : undefined].filter((value): value is string => Boolean(value));
  lines.push(`matches: ${countParts.join(" · ")}`);
  if (matches.length === 0) return [...lines, "no matches"].join("\n");
  lines.push("results:");
  for (const match of matches) lines.push(formatGrepMatchLine(match));
  return lines.join("\n");
}

interface GrepMatchLike {
  file: string;
  line: number;
  column?: number;
  text: string;
}

function isGrepMatchLike(value: unknown): value is GrepMatchLike {
  return isRecord(value) && typeof value.file === "string" && typeof value.line === "number" && typeof value.text === "string" && (value.column === undefined || typeof value.column === "number");
}

function formatGrepMatchLine(match: GrepMatchLike): string {
  const column = match.column !== undefined ? `:${match.column}` : "";
  return `  ${match.file}:${match.line}${column}: ${match.text}`;
}

function formatReplData(value: unknown, maxLength: number): string {
  return truncate(formatReplValue(value), maxLength);
}

function formatReplValue(value: unknown, indent = 0, seen = new WeakSet<object>()): string {
  if (typeof value === "string") return value;
  if (value === null || typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  if (value === undefined) return "undefined";
  if (typeof value === "function") return `[Function${value.name ? `: ${value.name}` : ""}]`;
  if (typeof value === "symbol") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return formatReplValue({ name: value.name, message: value.message, stack: value.stack }, indent, seen);
  if (Array.isArray(value)) return formatReplArray(value, indent, seen);
  if (isRecord(value)) return formatReplObject(value, indent, seen);
  return String(value);
}

function formatReplArray(value: unknown[], indent: number, seen: WeakSet<object>): string {
  if (value.length === 0) return "[]";
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  const pad = " ".repeat(indent);
  const childIndent = indent + 2;
  const lines = value.map((item) => isReplScalar(item) ? `${pad}- ${formatReplValue(item, childIndent, seen)}` : `${pad}-\n${formatReplValue(item, childIndent, seen)}`);
  seen.delete(value);
  return lines.join("\n");
}

function formatReplObject(value: Record<string, unknown>, indent: number, seen: WeakSet<object>): string {
  const entries = Object.entries(value).filter(([, entryValue]) => entryValue !== undefined);
  if (entries.length === 0) return "{}";
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  const pad = " ".repeat(indent);
  const childIndent = indent + 2;
  const lines = entries.map(([key, entryValue]) => {
    const label = `${pad}${key}:`;
    if (isReplScalar(entryValue)) return `${label} ${formatReplValue(entryValue, childIndent, seen)}`;
    const formatted = formatReplValue(entryValue, childIndent, seen);
    return formatted === "[]" || formatted === "{}" || formatted === "[Circular]" ? `${label} ${formatted}` : `${label}\n${formatted}`;
  });
  seen.delete(value);
  return lines.join("\n");
}

function isReplScalar(value: unknown): boolean {
  return value === null || value === undefined || typeof value !== "object" || value instanceof Date;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasAnsi(value: string): boolean {
  return /\x1b\[[0-9;]*m/.test(value);
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function estimateTokens(text: string): number {
  return text ? Math.max(1, Math.ceil(text.length / 4)) : 0;
}

function formatUsageTotals(totals: UsageTotals): string {
  const totalLabel = totals.computedTotalTokens ? "Total tokens (computed)" : "Total tokens";
  return [
    "Session usage:",
    `  Requests: ${formatNumber(totals.requests)}`,
    `  Input tokens: ${formatNumber(totals.inputTokens)}`,
    `  Output tokens: ${formatNumber(totals.outputTokens)}`,
    `  ${totalLabel}: ${formatNumber(totals.totalTokens)}`,
    `  Reasoning tokens: ${formatNumber(totals.reasoningTokens)}`,
    `  Cached input tokens: ${formatNumber(totals.cachedTokens)}`,
  ].join("\n");
}

function formatManualCompaction(result: CompactionResult): string {
  if (!result.changed) return "No context compaction was needed.";
  return `context compacted: ${result.messages.length} message(s) retained, ${formatNumber(result.charsFreed ?? result.tokensFreed ?? 0)} chars removed`;
}

function formatPureCompaction(result: CompactionResult): string {
  if (!result.changed) return "No context available to purify.";
  return `pure context compacted: ${result.messages.length} sanitized message(s) retained, ${formatNumber(result.charsFreed ?? result.tokensFreed ?? 0)} chars removed; raw command/log/code details omitted`;
}

function formatNumber(value: number | undefined): string {
  return value === undefined ? "?" : new Intl.NumberFormat("en-US").format(Math.round(value));
}

const THINKING_SUMMARY_MAX_LINES = 1000;
const EXPANDED_SUMMARY_MAX_LINES = 1000;
const EDIT_TOOL_SUMMARY_MAX_LINES = EXPANDED_SUMMARY_MAX_LINES;

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runWebServer().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
