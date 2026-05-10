#!/usr/bin/env node
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { QueryEngine } from "../core/query-engine.js";
import { InMemoryAppState } from "../app/app-state.js";
import { loadDefaultDotEnvFiles } from "../model/env.js";
import { readModelProviderConfig, type ModelProviderName } from "../model/config.js";
import { findModelMetadata, loadModelCatalog, reasoningEffortsForModel, resolveContextWindowTokens } from "../model/context-window.js";
import { CommunicationLogger, LoggingModelGateway } from "../model/communication-logger.js";
import { createModelGatewayFromConfig, createModelGatewayFromProcessEnv } from "../model/provider-factory.js";
import type { ModelUsage, ReasoningConfig, ReasoningEffort } from "../model/model-gateway.js";
import { ToolRegistry } from "../tools/registry.js";
import { editTool, writeTool } from "../tools/builtins/edit-tool.js";
import { createExecTool } from "../tools/builtins/exec-tool.js";
import { listDirectoryTool, readFileTool } from "../tools/builtins/filesystem-tools.js";
import { grepTool } from "../tools/builtins/grep-tool.js";
import { searchTool } from "../tools/builtins/search-tool.js";
import { planTool } from "../tools/builtins/plan-tool.js";
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
import { appTips, formatTipLine, initialTipIndex, tipAt } from "../tips.js";
import { openDirectory } from "../open-directory.js";

interface WebRuntime {
  engine: QueryEngine;
  communicationLogger: CommunicationLogger;
  modelGateway: LoggingModelGateway;
  agentRuntime: AgentToolRuntime;
  usage: SessionUsageTracker;
  taskStore: TaskStore;
  initialMetrics: ContextMetrics;
  defaultReasoning?: ReasoningConfig | null;
  envPath: string;
  envNotice?: string;
}

interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  requests: number;
  computedTotalTokens: boolean;
}

class SessionUsageTracker {
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

interface UiLine {
  id: number;
  kind: "system" | "user" | "assistant" | "thinking" | "tool" | "error" | "meta";
  text: string;
  title?: string;
  bodyTitle?: string;
  titleStatus?: "success" | "failure";
  format?: "markdown" | "ansi" | "plain";
  previewStyle?: "summary";
  summaryMaxLines?: number;
  live?: boolean;
  pendingReplacement?: boolean;
  collapsible?: boolean;
}

interface UiStatus {
  phase: string;
  detail?: string;
  metrics?: ContextMetrics;
  usage?: ModelUsage;
  streamedOutputTokens: number;
  activityTick: number;
  inputTokenUpdatedAt?: number;
  outputTokenUpdatedAt?: number;
  retryCooldownUntil?: number;
}

interface WebServerOptions {
  host: string;
  port: number;
}

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

export async function runWebServer(argv = process.argv.slice(2)): Promise<void> {
  const options = parseWebArgs(argv);
  const runtime = await createRuntime();
  const repl = new WebRepl(runtime);
  const server = http.createServer((req, res) => void route(req, res, repl));
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

async function createRuntime(): Promise<WebRuntime> {
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
  tools.register(planTool);

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

  const engine = new QueryEngine({
    agentId: "main",
    model: modelConfig?.model,
    fallbackModel: modelConfig?.fallbackModel,
    reasoning: modelConfig?.defaultReasoning,
    queryOrigin: "web",
    modelGateway,
    tools,
    taskNotificationSource: createTaskNotificationSource(taskStore),
    commands: replCommandDefinitions.map((command) => command.usage),
    session: {
      enabled: process.env.AGENT_SESSION_TRANSCRIPT !== "0",
      sessionId: process.env.AGENT_SESSION_ID,
      rootDir: process.env.AGENT_SESSION_DIR,
      resume: parseResumeFlag(process.env.AGENT_SESSION_RESUME),
      toolResultThresholdChars: process.env.AGENT_TOOL_RESULT_THRESHOLD_CHARS ? Number(process.env.AGENT_TOOL_RESULT_THRESHOLD_CHARS) : undefined,
    },
  });
  await engine.initialize();
  const initialMetrics = await engine.contextMetrics();
  return {
    engine,
    communicationLogger,
    modelGateway,
    agentRuntime,
    usage: new SessionUsageTracker(),
    taskStore,
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

function formatCreatedEnvNotice(dotEnvPath: string): string {
  return `Created default config file: ${dotEnvPath}\nSet MODEL_PROVIDER and the matching provider section (for example OPENAI_API_KEY or KIMI_API_KEY), then restart neo.`;
}

function parseResumeFlag(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "latest"].includes(value.toLowerCase());
}

class WebRepl {
  private readonly subscribers = new Set<ServerResponse>();
  private lineId = 0;
  private assistantLineId: number | undefined;
  private thinkingLineId: number | undefined;
  private finalizedThinkingLineId: number | undefined;
  private activeAbortController: AbortController | undefined;
  private interruptArmed = false;
  private readonly toolLineIds = new Map<string, number>();
  private lines: UiLine[];
  private status: UiStatus;
  private busy = false;
  private queuedInput: string | undefined;
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
    this.subscribers.add(res);
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    this.send(res, "sync", this.snapshot(true));
    reqKeepAlive(res);
    res.on("close", () => this.subscribers.delete(res));
  }

  snapshot(includeCatalog = false) {
    return {
      lines: this.lines,
      status: this.status,
      busy: this.busy,
      queuedInput: this.queuedInput,
      backgroundTaskCount: this.backgroundTaskCount,
      session: this.runtime.engine.snapshot().session,
      catalog: includeCatalog ? webCatalog(this.runtime) : undefined,
      interactive: includeCatalog ? webInteractiveCatalog(this.runtime) : undefined,
      tips: includeCatalog ? appTips : undefined,
      tipIndex: initialTipIndex(this.runtime.engine.snapshot().session?.sessionId ?? process.cwd()),
    };
  }

  async submit(text: string, attachments: WebAttachmentPayload[] = []): Promise<{ ok: true } | { ok: false; error: string }> {
    const trimmed = text.trim();
    if (!trimmed && attachments.length === 0) return { ok: true };
    if (this.busy) {
      if (this.queuedInput !== undefined) return { ok: false, error: "A queued prompt is already waiting. Press Esc/Ctrl+C in the web UI to clear it." };
      this.queuedInput = text;
      this.broadcastSync();
      return { ok: true };
    }
    void this.handleCommandOrPrompt(text, attachments).catch((error) => {
      this.append({ kind: "error", text: error instanceof Error ? error.message : String(error) });
      this.setBusy(false);
      this.setStatus({ ...this.status, phase: "ready", detail: undefined });
    });
    return { ok: true };
  }

  async listSessions() {
    return this.runtime.engine.listSessions(Number.POSITIVE_INFINITY);
  }

  async resumeSession(sessionId: string): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!sessionId) return { ok: false, error: "sessionId is required" };
    try {
      const snapshot = await this.runtime.engine.resumeSession(sessionId);
      const metrics = await this.runtime.engine.contextMetrics();
      this.runtime.usage.reset();
      this.status = initialStatus(this.runtime, metrics);
      const lineId = { current: 0 };
      this.lines = initialLines(this.runtime, lineId);
      this.lineId = lineId.current;
      this.assistantLineId = undefined;
      this.thinkingLineId = undefined;
      this.finalizedThinkingLineId = undefined;
      this.toolLineIds.clear();
      this.append(systemLine(formatResume(snapshot)));
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.append({ kind: "error", text: message });
      return { ok: false, error: message };
    }
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

  loginForm(providerValue?: string): LoginFormPayload {
    const provider = parseLoginProvider(providerValue);
    return createLoginFormPayload(this.runtime.envPath, provider);
  }

  async saveLogin(providerValue: string, values: Record<string, string>): Promise<{ ok: true } | { ok: false; error: string }> {
    const provider = parseLoginProvider(providerValue);
    if (!provider) return { ok: false, error: "provider must be openai, deepseek, or kimi" };
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
      this.runtime.defaultReasoning = config.defaultReasoning;
      this.status = { ...this.status, metrics: { ...initialContextMetrics(config.model, this.runtime.engine.snapshot().messages, this.runtime.initialMetrics.toolCount), messageCount: this.runtime.engine.snapshot().messages } };
      this.append(systemLine(`Saved ${provider} login to ${this.runtime.envPath}\n${formatModelSettings(this.runtime.engine.getModelSettings(), this.runtime.defaultReasoning)}`, EXPANDED_SUMMARY_MAX_LINES));
      return { ok: true };
    } catch (error) {
      const message = `Login save failed: ${error instanceof Error ? error.message : String(error)}`;
      this.append({ kind: "error", text: message });
      return { ok: false, error: message };
    }
  }

  interrupt(): { ok: true; interrupted: boolean } {
    if (this.queuedInput !== undefined) {
      this.queuedInput = undefined;
      this.broadcastSync();
      return { ok: true, interrupted: false };
    }
    const controller = this.activeAbortController;
    if (controller && !controller.signal.aborted && !this.interruptArmed) {
      this.interruptArmed = true;
      controller.abort("Interrupted from neo web");
      this.setStatus({ ...this.status, phase: "stopped", detail: "interrupt requested" });
      return { ok: true, interrupted: true };
    }
    return { ok: true, interrupted: false };
  }

  private append(line: Omit<UiLine, "id">): number {
    const id = ++this.lineId;
    this.lines.push({ id, ...line });
    this.broadcastSync();
    return id;
  }

  private updateLine(id: number, updater: (text: string) => string): void {
    this.lines = this.lines.map((line) => line.id === id ? { ...line, text: updater(line.text) } : line);
    this.broadcastSync();
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

  private reduce(event: AgentEvent): void {
    this.status = reduceStatus(this.status, event);
    if (event.type === "usage") this.runtime.usage.add(event.usage);
  }

  private finalizeLiveLine(id: number | undefined): void {
    if (id === undefined) return;
    this.lines = this.lines.map((line) => line.id === id ? { ...line, live: false } : line);
  }

  private finalizeThinkingLine(): void {
    const id = this.thinkingLineId;
    if (id === undefined) return;
    this.finalizeLiveLine(id);
    this.finalizedThinkingLineId = id;
    this.thinkingLineId = undefined;
  }

  private finalizeActiveToolLines(): void {
    for (const id of this.toolLineIds.values()) this.replaceLine(id, { live: false, pendingReplacement: false });
    this.toolLineIds.clear();
  }

  private handleEvent(event: AgentEvent): void {
    this.reduce(event);
    if (event.type === "state" || event.type === "context.metrics" || event.type === "usage" || event.type === "tool_call.delta" || event.type === "retrying") {
      this.broadcastSync();
      return;
    }
    if (event.type === "assistant.delta") {
      this.finalizeThinkingLine();
      const id = this.assistantLineId ?? this.append({ kind: "assistant", text: "", live: true });
      this.assistantLineId = id;
      this.updateLine(id, (text) => text + event.text);
      return;
    }
    if (event.type === "thinking.delta") {
      const id = this.thinkingLineId ?? this.finalizedThinkingLineId ?? this.append(thinkingLine("", true));
      this.thinkingLineId = id;
      this.finalizedThinkingLineId = undefined;
      this.updateLine(id, (text) => text + event.text);
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
        this.broadcastSync();
        return;
      }
      if (event.message.role === "tool_result") {
        renderToolResultMessage(event.message, (line) => this.append(line), (id, patch) => this.replaceLine(id, patch), this.toolLineIds);
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
      this.toolLineIds.set(event.toolUse.id, id);
      return;
    }
    if (event.type === "tool.finished") {
      const id = this.toolLineIds.get(event.toolUse.id);
      if (id !== undefined) {
        this.replaceLine(id, formatToolFinishedWithoutResult(event.toolUse, event.ok));
        this.toolLineIds.delete(event.toolUse.id);
      }
      return;
    }
    if (event.type === "terminal") {
      this.finalizeLiveLine(this.assistantLineId);
      this.finalizeThinkingLine();
      this.finalizeActiveToolLines();
      this.assistantLineId = undefined;
      this.broadcastSync();
      return;
    }
    if (event.type === "error") this.append({ kind: "error", text: event.error.message });
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
      this.status = resetStatus(this.runtime);
      this.append(systemLine("transcript reset"));
      return;
    }
    if (command.type === "state") {
      this.append(systemLine(formatReplData({ ...this.runtime.engine.snapshot(), communicationLog: this.runtime.communicationLogger.snapshot() }, 12000), EXPANDED_SUMMARY_MAX_LINES));
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
        this.append(systemLine(`Opened env directory: ${envDirectory}`));
      } catch (error) {
        this.append({ kind: "error", text: `Failed to open env directory ${envDirectory}: ${error instanceof Error ? error.message : String(error)}` });
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
    if (text.trimStart().startsWith("/")) {
      this.append({ kind: "error", text: `Unknown or incomplete command: ${text.trim()}\nType /help for commands.` });
      return;
    }

    const promptPayload = buildWebPromptPayload(command.text, attachments);
    if (promptPayload.blocks?.some((block) => block.type === "image") && !this.runtime.engine.canAcceptImageInput()) {
      this.append({ kind: "error", text: "Current model does not support image input; image attachments were not added to the conversation." });
      return;
    }
    this.append({ kind: "user", text: promptPayload.displayText });
    const abortController = new AbortController();
    this.activeAbortController = abortController;
    this.interruptArmed = false;
    this.setBusy(true);
    this.setStatus({ ...this.status, phase: "running", detail: "working", usage: undefined, streamedOutputTokens: 0, inputTokenUpdatedAt: undefined, outputTokenUpdatedAt: undefined, retryCooldownUntil: undefined });
    try {
      for await (const event of this.runtime.engine.sendUserText(promptPayload.text, { abortSignal: abortController.signal, blocks: promptPayload.blocks, displayText: promptPayload.displayText })) {
        this.handleEvent(event);
      }
    } catch (error) {
      this.finalizeLiveLine(this.assistantLineId);
      this.finalizeThinkingLine();
      this.finalizeActiveToolLines();
      this.assistantLineId = undefined;
      this.finalizedThinkingLineId = undefined;
      this.append({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      if (this.activeAbortController === abortController) this.activeAbortController = undefined;
      this.interruptArmed = false;
      this.finalizeLiveLine(this.assistantLineId);
      this.finalizeThinkingLine();
      this.finalizeActiveToolLines();
      this.assistantLineId = undefined;
      this.finalizedThinkingLineId = undefined;
      this.setBusy(false);
      this.setStatus({ ...this.status, phase: "ready", detail: undefined, inputTokenUpdatedAt: undefined, outputTokenUpdatedAt: undefined, retryCooldownUntil: undefined });
      const queued = this.queuedInput;
      this.queuedInput = undefined;
      if (queued !== undefined) void this.handleCommandOrPrompt(queued);
      this.broadcastSync();
    }
  }

  private async runCompaction(type: "compact" | "pure"): Promise<void> {
    const abortController = new AbortController();
    this.activeAbortController = abortController;
    this.interruptArmed = false;
    this.setBusy(true);
    this.setStatus({ ...this.status, phase: "compacting", detail: type === "compact" ? "manual compact" : "pure compact", activityTick: this.status.activityTick + 1 });
    try {
      const result = type === "compact"
        ? await this.runtime.engine.compact({ abortSignal: abortController.signal })
        : await this.runtime.engine.pureCompact({ abortSignal: abortController.signal });
      const metrics = await this.runtime.engine.contextMetrics();
      this.append(systemLine(type === "compact" ? formatManualCompaction(result) : formatPureCompaction(result)));
      this.handleEvent({ type: "context.metrics", metrics });
    } catch (error) {
      this.append({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      if (this.activeAbortController === abortController) this.activeAbortController = undefined;
      this.interruptArmed = false;
      this.setBusy(false);
      this.setStatus({ ...this.status, phase: "ready", detail: undefined, activityTick: this.status.activityTick + 1 });
      const queued = this.queuedInput;
      this.queuedInput = undefined;
      if (queued !== undefined) void this.handleCommandOrPrompt(queued);
    }
  }

  private send(res: ServerResponse, event: string, data: unknown): void {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  private broadcastSync(): void {
    const payload = this.snapshot(false);
    for (const res of this.subscribers) this.send(res, "sync", payload);
  }
}

function reqKeepAlive(res: ServerResponse): void {
  const timer = setInterval(() => res.write(": keep-alive\n\n"), 25_000);
  timer.unref?.();
  res.on("close", () => clearInterval(timer));
}

async function route(req: IncomingMessage, res: ServerResponse, repl: WebRepl): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  try {
    if (req.method === "GET" && url.pathname === "/") return sendHtml(res, WEB_HTML);
    if (req.method === "GET" && url.pathname === "/vendor/marked.esm.js") return sendFile(res, path.join(process.cwd(), "node_modules", "marked", "lib", "marked.esm.js"), "text/javascript; charset=utf-8");
    if (req.method === "GET" && url.pathname === "/vendor/highlight.min.js") return sendFile(res, path.join(process.cwd(), "node_modules", "@highlightjs", "cdn-assets", "highlight.min.js"), "text/javascript; charset=utf-8");
    if (req.method === "GET" && url.pathname === "/vendor/highlight-theme.css") return sendFile(res, path.join(process.cwd(), "node_modules", "@highlightjs", "cdn-assets", "styles", "atom-one-dark.min.css"), "text/css; charset=utf-8");
    if (req.method === "GET" && url.pathname === "/events") return repl.subscribe(res);
    if (req.method === "GET" && url.pathname === "/api/state") return sendJson(res, repl.snapshot(true));
    if (req.method === "POST" && url.pathname === "/api/submit") {
      const body = await readJsonBody<{ text?: string; attachments?: WebAttachmentPayload[] }>(req);
      return sendJson(res, await repl.submit(String(body.text ?? ""), sanitizeWebAttachments(body.attachments)));
    }
    if (req.method === "POST" && url.pathname === "/api/interrupt") return sendJson(res, repl.interrupt());
    if (req.method === "GET" && url.pathname === "/api/sessions") return sendJson(res, { sessions: await repl.listSessions() });
    if (req.method === "POST" && url.pathname === "/api/sessions/resume") {
      const body = await readJsonBody<{ sessionId?: string }>(req);
      return sendJson(res, await repl.resumeSession(String(body.sessionId ?? "")));
    }
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
  const session = runtime.engine.snapshot().session;
  const suffix = session ? ` Session: ${session.sessionId}${session.resumedMessages > 0 ? ` (${session.resumedMessages} resumed messages)` : ""}.` : "";
  const lines: UiLine[] = [
    { id: 0, kind: "system", title: "System", text: `Interactive web UI enabled. Type /help for commands.${suffix}\n${formatTipLine(tipAt(initialTipIndex(session?.sessionId ?? process.cwd())))}`, previewStyle: "summary" },
  ];
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
  for (const message of runtime.engine.getHistoryMessages()) renderMessage(message, append, undefined, { includeToolUseBlocks: true });
  return lines;
}

function initialStatus(runtime: WebRuntime, metrics = runtime.initialMetrics): UiStatus {
  return { phase: "ready", metrics: { ...metrics, messageCount: runtime.engine.snapshot().messages }, streamedOutputTokens: 0, activityTick: 0 };
}

function resetStatus(runtime: WebRuntime): UiStatus {
  return initialStatus(runtime, initialContextMetrics(runtime.engine.getModelSettings().model, runtime.engine.snapshot().messages, runtime.initialMetrics.toolCount));
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

function initialContextMetrics(model: string | undefined, messageCount: number, toolCount: number): ContextMetrics {
  const window = resolveContextWindowTokens(model);
  return {
    model,
    estimatedInputTokens: 0,
    estimatedChars: 0,
    messageCount,
    toolCount,
    contextWindowTokens: window.tokens,
    contextWindowSource: window.source,
    contextUsageRatio: window.tokens ? 0 : undefined,
    modelMetadata: window.model ? {
      id: window.model.id,
      provider: window.model.provider,
      maxOutputTokens: window.model.maxOutputTokens,
      knowledgeCutoff: window.model.knowledgeCutoff,
      reasoning: window.model.reasoning,
      imageInput: window.model.imageInput,
      source: window.model.source,
    } : undefined,
  };
}

function reduceStatus(status: UiStatus, event: AgentEvent): UiStatus {
  if (event.type === "state") return { ...status, phase: event.phase, detail: event.detail, usage: event.phase === "preparing" ? undefined : status.usage, streamedOutputTokens: event.phase === "preparing" ? 0 : status.streamedOutputTokens, inputTokenUpdatedAt: event.phase === "preparing" ? undefined : status.inputTokenUpdatedAt, outputTokenUpdatedAt: event.phase === "preparing" ? undefined : status.outputTokenUpdatedAt, retryCooldownUntil: event.phase === "preparing" ? undefined : status.retryCooldownUntil, activityTick: status.activityTick + 1 };
  if (event.type === "context.metrics") return { ...status, metrics: event.metrics, inputTokenUpdatedAt: event.metrics.estimatedInputTokens !== status.metrics?.estimatedInputTokens ? Date.now() : status.inputTokenUpdatedAt, activityTick: status.activityTick + 1 };
  if (event.type === "usage") return { ...status, usage: event.usage, inputTokenUpdatedAt: event.usage.inputTokens !== undefined ? Date.now() : status.inputTokenUpdatedAt, outputTokenUpdatedAt: event.usage.outputTokens !== undefined ? Date.now() : status.outputTokenUpdatedAt, activityTick: status.activityTick + 1 };
  if (event.type === "assistant.delta") return { ...status, phase: "calling_model", streamedOutputTokens: status.streamedOutputTokens + estimateTokens(event.text), outputTokenUpdatedAt: Date.now(), activityTick: status.activityTick + 1 };
  if (event.type === "thinking.delta") return { ...status, phase: "thinking", streamedOutputTokens: status.streamedOutputTokens + estimateTokens(event.text), outputTokenUpdatedAt: Date.now(), activityTick: status.activityTick + 1 };
  if (event.type === "tool_call.delta") return { ...status, phase: "calling_model", streamedOutputTokens: status.streamedOutputTokens + estimateTokens(event.argumentsDelta), outputTokenUpdatedAt: Date.now(), activityTick: status.activityTick + 1 };
  if (event.type === "retrying") return { ...status, phase: "calling_model", detail: `retrying in ${(event.delayMs / 1000).toFixed(1)}s`, retryCooldownUntil: Date.now() + event.delayMs, activityTick: status.activityTick + 1 };
  if (event.type === "terminal") return { ...status, phase: "stopped", detail: event.reason, inputTokenUpdatedAt: undefined, outputTokenUpdatedAt: undefined, retryCooldownUntil: undefined, activityTick: status.activityTick + 1 };
  if (event.type === "message" || event.type === "tool.started" || event.type === "tool.finished" || event.type === "error") return { ...status, activityTick: status.activityTick + 1 };
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
  return parseLoginProvider(process.env.MODEL_PROVIDER) ?? "openai";
}

function parseLoginProvider(value: string | undefined): ModelProviderName | undefined {
  if (value === "openai" || value === "deepseek" || value === "kimi") return value;
  return undefined;
}

const LOGIN_PROVIDERS: LoginProviderName[] = ["openai", "deepseek", "kimi"];

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
    { key: "model", label: "Model", envKey: "OPENAI_MODEL", scope: "provider", required: true, placeholder: "gpt-5.5" },
    { key: "fallbackModel", label: "Fallback model", envKey: "OPENAI_FALLBACK_MODEL", scope: "provider" },
    { key: "endpoint", label: "Endpoint", envKey: "OPENAI_ENDPOINT", scope: "provider", placeholder: "auto", options: ["auto", "responses", "chat"] },
    ...SHARED_LOGIN_FIELDS,
  ],
  deepseek: [
    { key: "apiKey", label: "API key", envKey: "DEEPSEEK_API_KEY", scope: "provider", required: true, secret: true, placeholder: "sk-..." },
    { key: "baseUrl", label: "Base URL", envKey: "DEEPSEEK_BASE_URL", scope: "provider", placeholder: "https://api.deepseek.com" },
    { key: "model", label: "Model", envKey: "DEEPSEEK_MODEL", scope: "provider", required: true, placeholder: "deepseek-chat" },
    { key: "fallbackModel", label: "Fallback model", envKey: "DEEPSEEK_FALLBACK_MODEL", scope: "provider" },
    ...SHARED_LOGIN_FIELDS,
  ],
  kimi: [
    { key: "apiKey", label: "API key", envKey: "KIMI_API_KEY", scope: "provider", required: true, secret: true, placeholder: "sk-..." },
    { key: "baseUrl", label: "Base URL", envKey: "KIMI_BASE_URL", scope: "provider", placeholder: "https://api.moonshot.cn/v1" },
    { key: "model", label: "Model", envKey: "KIMI_MODEL", scope: "provider", required: true, placeholder: "kimi-k2.6" },
    { key: "fallbackModel", label: "Fallback model", envKey: "KIMI_FALLBACK_MODEL", scope: "provider" },
    ...SHARED_LOGIN_FIELDS,
  ],
};

const DEPRECATED_MODEL_ENV_KEYS = [
  "MODEL_API_KEY", "MODEL_BASE_URL", "MODEL_ID", "MODEL_FALLBACK_ID", "MODEL_ENDPOINT", "OPENAI_PROVIDER",
  "OPENAI_REASONING_EFFORT", "OPENAI_REASONING_SUMMARY", "OPENAI_MAX_OUTPUT_TOKENS", "OPENAI_TIMEOUT_MS", "OPENAI_STREAM_IDLE_TIMEOUT_MS", "OPENAI_MAX_RETRIES",
  "DEEPSEEK_REASONING_EFFORT", "DEEPSEEK_REASONING_SUMMARY", "DEEPSEEK_MAX_OUTPUT_TOKENS", "DEEPSEEK_TIMEOUT_MS", "DEEPSEEK_STREAM_IDLE_TIMEOUT_MS", "DEEPSEEK_MAX_RETRIES",
  "KIMI_REASONING_EFFORT", "KIMI_REASONING_SUMMARY", "KIMI_MAX_OUTPUT_TOKENS", "KIMI_TIMEOUT_MS", "KIMI_STREAM_IDLE_TIMEOUT_MS", "KIMI_MAX_RETRIES",
  "MOONSHOT_REASONING_EFFORT", "MOONSHOT_REASONING_SUMMARY", "MOONSHOT_MAX_OUTPUT_TOKENS", "MOONSHOT_TIMEOUT_MS", "MOONSHOT_STREAM_IDLE_TIMEOUT_MS", "MOONSHOT_MAX_RETRIES",
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
  if (provider === "kimi") {
    values.apiKey ||= env.MOONSHOT_API_KEY ?? process.env.MOONSHOT_API_KEY ?? "";
    values.baseUrl ||= env.MOONSHOT_BASE_URL ?? process.env.MOONSHOT_BASE_URL ?? "";
    values.model ||= env.MOONSHOT_MODEL ?? process.env.MOONSHOT_MODEL ?? "";
    values.fallbackModel ||= env.MOONSHOT_FALLBACK_MODEL ?? process.env.MOONSHOT_FALLBACK_MODEL ?? "";
  }
  if (!values.baseUrl) values.baseUrl = defaultBaseUrlForLoginProvider(provider);
  if (!values.model) values.model = defaultModelForLoginProvider(provider);
  if (provider === "openai" && !values.endpoint) values.endpoint = "auto";
  return values;
}

function guessLoginProvider(env: Record<string, string>): LoginProviderName {
  if (env.KIMI_API_KEY ?? env.MOONSHOT_API_KEY ?? process.env.KIMI_API_KEY ?? process.env.MOONSHOT_API_KEY) return "kimi";
  if (env.DEEPSEEK_API_KEY ?? process.env.DEEPSEEK_API_KEY) return "deepseek";
  return currentModelProvider();
}

function defaultBaseUrlForLoginProvider(provider: LoginProviderName): string {
  if (provider === "deepseek") return "https://api.deepseek.com";
  if (provider === "kimi") return "https://api.moonshot.cn/v1";
  return "https://api.openai.com";
}

function defaultModelForLoginProvider(provider: LoginProviderName): string {
  if (provider === "deepseek") return "deepseek-chat";
  if (provider === "kimi") return "kimi-k2.6";
  return "gpt-5.5";
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
  if (payload.provider === "kimi") {
    entries.MOONSHOT_API_KEY = undefined;
    entries.MOONSHOT_BASE_URL = undefined;
    entries.MOONSHOT_MODEL = undefined;
    entries.MOONSHOT_FALLBACK_MODEL = undefined;
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

function modelEnvKeyForProvider(provider: ModelProviderName): "OPENAI_MODEL" | "DEEPSEEK_MODEL" | "KIMI_MODEL" {
  if (provider === "deepseek") return "DEEPSEEK_MODEL";
  if (provider === "kimi") return "KIMI_MODEL";
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

function renderMessage(message: Message, append: (line: Omit<UiLine, "id">) => number, activeAssistantId?: number, options: { includeToolUseBlocks?: boolean } = {}): boolean {
  if (message.metadata?.syntheticToolUse === true) return false;
  if (message.role === "progress" || message.isMeta) return false;
  if (message.role === "assistant" && activeAssistantId !== undefined && message.blocks.some((block) => block.type === "text")) return true;
  let rendered = false;
  for (const block of message.blocks) {
    if (block.type === "text") {
      const kind = kindForRole(message.role);
      if (kind === "meta") continue;
      if (kind === "system") append({ kind, title: titleForRole(message.role), text: block.text, previewStyle: "summary" });
      else append({ kind, text: block.text });
      rendered = true;
    } else if (block.type === "image") {
      const kind = kindForRole(message.role);
      if (kind === "meta") continue;
      append({ kind, text: block.label ?? `[image ${block.mimeType}]` });
      rendered = true;
    } else if (block.type === "thinking") {
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

function renderToolResultMessage(message: Message, append: (line: Omit<UiLine, "id">) => number, replaceLine: (id: number, patch: Partial<UiLine>) => void, activeToolLineIds: Map<string, number>): boolean {
  let rendered = false;
  for (const block of message.blocks) {
    if (block.type !== "tool_result") continue;
    const line = formatToolResultLine(block.name, block.output, block.ok);
    const id = activeToolLineIds.get(block.toolUseId);
    if (id === undefined) append(line);
    else {
      replaceLine(id, { ...line, title: toolTitle(block.name, "finished"), live: false, pendingReplacement: false });
      activeToolLineIds.delete(block.toolUseId);
    }
    rendered = true;
  }
  return rendered;
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
  if (toolUse.name === "plan" && isPlanToolPayload(toolUse.input)) return { kind: "tool", title: toolTitle(toolUse.name, "running"), bodyTitle: planToolBodyTitle(toolUse.input), text: formatPlanToolPayload(toolUse.input), collapsible: true };
  return { kind: "tool", title: toolTitle(toolUse.name, "running"), text: formatReplData(toolUse.input, 1200), previewStyle: "summary", collapsible: true };
}

function formatToolResultLine(toolName: string, output: unknown, ok: boolean): Omit<UiLine, "id"> {
  const formatted = formatToolResult(toolName, output, ok);
  return { kind: ok ? "tool" : "error", title: toolTitle(toolName, "finished"), bodyTitle: formatted.bodyTitle, titleStatus: ok ? "success" : "failure", text: formatted.text, format: formatted.format, live: false, previewStyle: formatted.full ? undefined : "summary", summaryMaxLines: formatted.summaryMaxLines, collapsible: true };
}

function formatToolFinishedWithoutResult(toolUse: ToolUseRequest, ok: boolean): Partial<UiLine> {
  const inputText = formatReplData(toolUse.input, 1200);
  return { kind: ok ? "tool" : "error", title: toolTitle(toolUse.name, "finished"), titleStatus: ok ? "success" : "failure", text: inputText ? `${ok ? "finished" : "failed"}\n${inputText}` : ok ? "finished" : "failed", previewStyle: "summary", live: true, pendingReplacement: true, collapsible: true };
}

function toolTitle(toolName: string, _phase: "running" | "finished"): string {
  return toolName;
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
  if (isExecOutput(output)) {
    const status = output.timedOut ? "timed out" : output.exitCode === 0 ? "exit 0" : `exit ${output.exitCode ?? output.signal ?? "unknown"}`;
    const sections = [`${status} · ${output.durationMs}ms`, `$ ${output.command}`];
    if (output.stdout) sections.push("stdout:", output.stdout.replace(/\s+$/u, ""));
    if (output.stderr) sections.push("stderr:", output.stderr.replace(/\s+$/u, ""));
    if (!output.stdout && !output.stderr) sections.push(ok ? "no output" : "no captured output");
    return { text: sections.join("\n"), format: "ansi" };
  }
  if (toolName === "plan" && isPlanToolPayload(output)) return { text: formatPlanToolPayload(output), full: true, bodyTitle: planToolBodyTitle(output) };
  if (typeof output === "string") return { text: output, format: hasAnsi(output) ? "ansi" : undefined, summaryMaxLines: EXPANDED_SUMMARY_MAX_LINES };
  return { text: `${ok ? "ok" : "failed"}\n${formatReplData(output, 6000)}`, summaryMaxLines: EXPANDED_SUMMARY_MAX_LINES };
}

interface ExecOutputLike extends Record<string, unknown> {
  command: string;
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
  return `context compacted: ${result.messages.length} message(s) retained, ${formatNumber(result.tokensFreed ?? 0)} chars removed`;
}

function formatPureCompaction(result: CompactionResult): string {
  if (!result.changed) return "No context available to purify.";
  return `pure context compacted: ${result.messages.length} sanitized message(s) retained, ${formatNumber(result.tokensFreed ?? 0)} chars removed; raw command/log/code details omitted`;
}

function formatNumber(value: number | undefined): string {
  return value === undefined ? "?" : new Intl.NumberFormat("en-US").format(Math.round(value));
}

const THINKING_SUMMARY_MAX_LINES = 1000;
const EXPANDED_SUMMARY_MAX_LINES = 1000;

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runWebServer().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
