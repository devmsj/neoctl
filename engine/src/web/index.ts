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
import type { Message, ToolUseRequest } from "../types/messages.js";

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
  format?: "markdown" | "ansi";
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
  return `Created default config file: ${dotEnvPath}\nSet MODEL_PROVIDER and the matching provider section (for example OPENAI_API_KEY), then restart neo.`;
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
      catalog: includeCatalog ? webCatalog(this.runtime) : undefined,
    };
  }

  async submit(text: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const trimmed = text.trim();
    if (!trimmed) return { ok: true };
    if (this.busy) {
      if (this.queuedInput !== undefined) return { ok: false, error: "A queued prompt is already waiting. Press Esc/Ctrl+C in the web UI to clear it." };
      this.queuedInput = text;
      this.broadcastSync();
      return { ok: true };
    }
    void this.handleCommandOrPrompt(text).catch((error) => {
      this.append({ kind: "error", text: error instanceof Error ? error.message : String(error) });
      this.setBusy(false);
      this.setStatus({ ...this.status, phase: "ready", detail: undefined });
    });
    return { ok: true };
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

  private async handleCommandOrPrompt(text: string): Promise<void> {
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
      const body = sessions.length === 0
        ? "No saved sessions found."
        : sessions.map((session, index) => `${String(index + 1).padStart(2)}. ${session.title || "untitled"}\n    ${session.sessionId} · ${session.messages} message(s) · ${session.updatedAt}`).join("\n");
      this.append(systemLine(body, EXPANDED_SUMMARY_MAX_LINES));
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
      this.append(systemLine(`Provider login is available in the terminal Ink UI. In neo web, edit ${this.runtime.envPath} or run neo /login in a terminal.`));
      return;
    }
    if (text.trimStart().startsWith("/")) {
      this.append({ kind: "error", text: `Unknown or incomplete command: ${text.trim()}\nType /help for commands.` });
      return;
    }

    this.append({ kind: "user", text });
    const abortController = new AbortController();
    this.activeAbortController = abortController;
    this.interruptArmed = false;
    this.setBusy(true);
    this.setStatus({ ...this.status, phase: "running", detail: "working", usage: undefined, streamedOutputTokens: 0, inputTokenUpdatedAt: undefined, outputTokenUpdatedAt: undefined, retryCooldownUntil: undefined });
    try {
      for await (const event of this.runtime.engine.sendUserText(command.text, { abortSignal: abortController.signal })) {
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
      const body = await readJsonBody<{ text?: string }>(req);
      return sendJson(res, await repl.submit(String(body.text ?? "")));
    }
    if (req.method === "POST" && url.pathname === "/api/interrupt") return sendJson(res, repl.interrupt());
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

function webCatalog(runtime: WebRuntime) {
  const modelIds = [...new Set(loadModelCatalog().models.flatMap((model) => model.modelIds.length ? model.modelIds : [model.id]))].sort((left, right) => left.localeCompare(right));
  return {
    commands: replCommandDefinitions,
    modelIds,
    reasoning: ["none", "minimal", "low", "medium", "high", "xhigh", "max", "default", "off"],
    envPath: runtime.envPath,
  };
}

function initialLines(runtime: WebRuntime, lineId: { current: number }): UiLine[] {
  const session = runtime.engine.snapshot().session;
  const suffix = session ? ` Session: ${session.sessionId}${session.resumedMessages > 0 ? ` (${session.resumedMessages} resumed messages)` : ""}.` : "";
  const lines: UiLine[] = [
    { id: 0, kind: "system", title: "System", text: `Interactive web UI enabled. Type /help for commands.${suffix}`, previewStyle: "summary" },
  ];
  lineId.current = 0;
  if (runtime.envNotice) lines.push({ id: ++lineId.current, kind: "system", title: "Config", text: runtime.envNotice, previewStyle: "summary" });
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
  if (value === "openai" || value === "deepseek") return value;
  return undefined;
}

function modelEnvKeyForProvider(provider: ModelProviderName): "OPENAI_MODEL" | "DEEPSEEK_MODEL" {
  return provider === "deepseek" ? "DEEPSEEK_MODEL" : "OPENAI_MODEL";
}

function envValueForReasoning(reasoning: ReasoningConfig | null | undefined): string | undefined {
  if (reasoning === null) return "off";
  return reasoning?.effort;
}

async function writeEnvUpdates(envPath: string, updates: Record<string, string | undefined>): Promise<void> {
  await fs.mkdir(path.dirname(envPath), { recursive: true });
  const existing = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  const next = updateEnvContent(existing, updates);
  await fs.writeFile(envPath, next, "utf8");
}

function updateEnvContent(existing: string, updates: Record<string, string | undefined>): string {
  const lines = existing.split(/\r?\n/);
  const seen = new Set<string>();
  const next = lines.map((line) => {
    const parsed = parseEnvLine(line);
    if (!parsed || !(parsed.key in updates)) return line;
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
  return { kind: ok ? "tool" : "error", title: toolTitle(toolUse.name, "finished"), titleStatus: ok ? "success" : "failure", text: inputText ? `${ok ? "finished" : "failed"}\n${inputText}` : ok ? "finished" : "failed", previewStyle: "summary", live: false, pendingReplacement: false, collapsible: true };
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

const WEB_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>neo web</title>
  <link rel="stylesheet" href="/vendor/highlight-theme.css" />
  <script defer src="/vendor/highlight.min.js"></script>
  <style>
    :root {
      color-scheme: dark;
      --bg: #07080b;
      --panel: #0b0d12;
      --text: #e5e7eb;
      --muted: #858b98;
      --cyan: #22d3ee;
      --green: #22c55e;
      --purple: #a855f7;
      --gold: #d4b04c;
      --red: #ef4444;
      --yellow: #eab308;
      --line: #161a23;
      --page-max-width: 1120px;
      --page-gutter: max(18px, calc((100vw - var(--page-max-width)) / 2));
      --topbar-gutter: max(14px, calc((100vw - var(--page-max-width)) / 2));
    }
    * { box-sizing: border-box; }
    html, body { height: 100%; margin: 0; }
    body { background: radial-gradient(circle at top, #101522 0, var(--bg) 42rem); color: var(--text); font: 14px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace; }
    #app { height: 100%; display: flex; flex-direction: column; }
    .topbar { height: 34px; display: flex; align-items: center; gap: 12px; padding: 0 var(--topbar-gutter); border-bottom: 1px solid var(--line); color: var(--muted); background: rgba(7, 8, 11, .75); backdrop-filter: blur(12px); }
    .brand { color: var(--cyan); font-weight: 700; letter-spacing: .08em; }
    .hint { margin-left: auto; font-size: 12px; }
    #transcriptWrap { position: relative; flex: 1; min-height: 0; }
    #transcript { height: 100%; overflow: auto; padding: 22px var(--page-gutter) 10px; scroll-behavior: smooth; }
    .scroll-bottom-zone { position: absolute; left: 0; right: 0; bottom: 0; height: 22px; padding: 0 var(--page-gutter); display: flex; align-items: flex-end; opacity: 0; pointer-events: none; transition: opacity .14s ease; z-index: 2; }
    .scroll-bottom-zone.available { opacity: 1; pointer-events: auto; }
    #scrollBottom { width: 100%; height: 12px; border: 1px solid rgba(34, 211, 238, .42); border-radius: 999px 999px 0 0; background: linear-gradient(90deg, rgba(34, 211, 238, .06), rgba(34, 211, 238, .22), rgba(34, 211, 238, .06)); color: var(--cyan); font: inherit; font-size: 10px; line-height: 10px; letter-spacing: .12em; text-transform: uppercase; cursor: pointer; box-shadow: 0 0 18px rgba(34, 211, 238, .2), inset 0 1px 0 rgba(255,255,255,.08); text-shadow: 0 0 10px currentColor; }
    #scrollBottom:hover, #scrollBottom:focus-visible { border-color: rgba(34, 211, 238, .82); box-shadow: 0 0 22px rgba(34, 211, 238, .42), inset 0 1px 0 rgba(255,255,255,.18); outline: none; }
    .block { display: flex; gap: 8px; margin-top: 16px; align-items: flex-start; }
    .block:first-child { margin-top: 0; }
    .marker { width: 18px; flex: 0 0 18px; user-select: none; line-height: 1.45; }
    .marker.circle { position: relative; overflow: hidden; text-indent: -999px; }
    .marker.circle::before { content: ""; position: absolute; left: 0; top: 5px; width: 9px; height: 9px; border-radius: 50%; background: currentColor; }
    .marker.diamond { font-size: 1em; }
    .content { position: relative; min-width: 0; max-width: 100%; overflow-wrap: anywhere; }
    .content.plain { white-space: pre-wrap; }
    .content.summary { color: #d7dce5; }
    .kind-tool.collapsible .content { padding-right: 78px; }
    .tool-body { position: relative; }
    .kind-tool.collapsed .tool-body { max-height: calc(1.45em * 6); overflow: hidden; opacity: .72; mask-image: linear-gradient(to bottom, rgba(0,0,0,1) 0%, rgba(0,0,0,.84) 42%, rgba(0,0,0,.42) 76%, rgba(0,0,0,0) 100%); -webkit-mask-image: linear-gradient(to bottom, rgba(0,0,0,1) 0%, rgba(0,0,0,.84) 42%, rgba(0,0,0,.42) 76%, rgba(0,0,0,0) 100%); }
    .tool-toggle { position: absolute; top: 0; right: 0; opacity: 0; pointer-events: none; border: 1px solid #263043; border-radius: 999px; padding: 1px 8px; background: rgba(15, 23, 42, .92); color: var(--muted); font: inherit; font-size: 11px; line-height: 17px; cursor: pointer; transition: opacity .12s ease, color .12s ease, border-color .12s ease; }
    .kind-tool.collapsible:hover .tool-toggle, .kind-tool.collapsible:focus-within .tool-toggle { opacity: 1; pointer-events: auto; }
    .tool-toggle:hover { color: var(--cyan); border-color: #31556b; }
    .markdown { color: var(--text); }
    .markdown > :first-child { margin-top: 0; }
    .markdown > :last-child { margin-bottom: 0; }
    .markdown p { margin: 0 0 .72em; }
    .markdown h1, .markdown h2, .markdown h3, .markdown h4 { margin: 1em 0 .45em; line-height: 1.25; color: #f3f4f6; font-weight: 700; }
    .markdown h1 { font-size: 1.34em; padding-bottom: .22em; border-bottom: 1px solid #222837; }
    .markdown h2 { font-size: 1.18em; }
    .markdown h3 { font-size: 1.06em; }
    .markdown ul, .markdown ol { margin: .35em 0 .78em; padding-left: 2.1em; }
    .markdown li { margin: .18em 0; }
    .markdown li > p { margin: .25em 0; }
    .markdown blockquote { margin: .75em 0; padding: .2em 0 .2em 1em; border-left: 3px solid #334155; color: #bac2cf; background: rgba(148, 163, 184, .05); }
    .markdown pre { position: relative; margin: .85em 0; padding: 12px 14px; overflow: auto; border: 1px solid #202635; border-radius: 8px; background: #0c1018; color: #d8dee9; white-space: pre; box-shadow: inset 0 1px 0 rgba(255,255,255,.025); }
    .markdown pre[data-lang]::before { content: attr(data-lang); position: sticky; left: 100%; float: right; margin: -5px -7px 4px 12px; padding: 1px 6px; border: 1px solid #263043; border-radius: 999px; background: rgba(15, 23, 42, .92); color: #94a3b8; font-size: 11px; line-height: 16px; text-transform: lowercase; }
    .markdown code { padding: .12em .34em; border: 1px solid #222838; border-radius: 5px; background: #0c1018; color: #facc15; font: .94em ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace; }
    .markdown pre code, .markdown pre code.hljs { display: block; padding: 0; border: 0; border-radius: 0; background: transparent; color: inherit; font-size: 1em; overflow: visible; }
    .markdown .hljs { background: transparent; color: inherit; }
    .markdown table { display: block; width: max-content; max-width: 100%; overflow: auto; margin: .85em 0; border-collapse: collapse; }
    .markdown th, .markdown td { padding: 6px 10px; border: 1px solid #263043; }
    .markdown th { background: #111827; color: #f3f4f6; font-weight: 700; }
    .markdown tr:nth-child(2n) td { background: rgba(148, 163, 184, .045); }
    .markdown hr { border: 0; border-top: 1px solid #222837; margin: 1em 0; }
    .markdown a { color: var(--cyan); text-decoration: none; }
    .markdown a:hover { text-decoration: underline; }
    .markdown strong { color: #f8fafc; }
    .markdown del { color: var(--muted); }
    .markdown input[type="checkbox"] { vertical-align: -2px; margin-right: .4em; accent-color: var(--cyan); }
    .title { color: var(--muted); font-weight: 700; margin-bottom: 2px; }
    .body-title { color: var(--text); font-weight: 700; margin-bottom: .35em; }
    .title.success::after { content: " ✓"; color: var(--green); }
    .title.failure::after { content: " ✕"; color: var(--red); }
    .kind-user .marker, .kind-user .content { color: var(--cyan); }
    .kind-assistant .marker { color: var(--green); }
    .kind-thinking .marker, .kind-thinking .title, .kind-thinking .content { color: var(--purple); }
    .kind-tool .marker, .kind-tool .title { color: var(--gold); }
    .kind-error .marker, .kind-error .title, .kind-error .content { color: var(--red); }
    .kind-system .marker { color: #fff; }
    .kind-meta .marker, .kind-meta .content { color: var(--muted); }
    .live .marker { animation: pulse 900ms ease-in-out infinite; }
    @keyframes pulse { 50% { opacity: .35; } }
    .ansi { color: #d1d5db; }
    #status { flex: 0 0 auto; min-height: 28px; padding: 4px var(--page-gutter); color: var(--muted); border-top: 1px solid var(--line); display: flex; align-items: center; gap: 0; overflow: hidden; white-space: nowrap; }
    .phase { font-weight: 700; color: var(--green); }
    .phase.active { color: var(--cyan); text-shadow: 0 0 12px currentColor; animation: shimmer 1.35s linear infinite; }
    .phase.thinking { color: var(--purple); }
    .phase.tools { color: var(--gold); }
    .phase.stopped { color: var(--yellow); }
    .sep { color: var(--muted); padding: 0 7px; }
    .ctx-stat { word-spacing: .35em; }
    .ctx-stat span { word-spacing: normal; }
    .token-hot { color: var(--cyan); font-weight: 700; }
    @keyframes shimmer { 0%, 100% { filter: brightness(.9); } 45% { filter: brightness(1.9); } }
    #queued { display: none; padding: 0 var(--page-gutter) 4px; color: var(--yellow); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    #composerWrap { flex: 0 0 auto; padding: 0 var(--page-gutter) 16px; background: rgba(7, 8, 11, .92); }
    #completions { display: none; margin-left: 26px; margin-bottom: 6px; color: var(--muted); max-width: calc(var(--page-max-width) - 26px); }
    .completion-title { color: var(--cyan); font-weight: 700; }
    .completion-row { display: grid; grid-template-columns: 4ch minmax(10ch, 32ch) 1fr; gap: 1ch; min-height: 20px; align-items: center; }
    .completion-row.selected .num { background: var(--cyan); color: #020617; }
    .completion-row .name { color: var(--cyan); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .completion-row.reasoning .name { color: var(--purple); }
    .completion-row .desc { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .completion-footer { color: var(--muted); }
    #composer { display: flex; gap: 8px; align-items: flex-start; }
    #prompt { color: var(--cyan); flex: 0 0 auto; padding-top: 7px; }
    #input { flex: 1; min-height: 32px; max-height: 35vh; resize: none; border: 0; outline: 0; padding: 7px 0; background: transparent; color: var(--text); font: inherit; line-height: 1.45; caret-color: var(--cyan); }
    #input.command { color: var(--cyan); }
    #input.locked { color: var(--muted); }
    .kbd { color: #aab2c0; border: 1px solid #303646; border-bottom-color: #222736; border-radius: 4px; padding: 0 4px; }
  </style>
</head>
<body>
<div id="app">
  <div class="topbar"><span class="brand">neo web</span><span id="connection">connecting…</span><span class="hint"><span class="kbd">Enter</span> send · <span class="kbd">Shift Enter</span> newline · <span class="kbd">Ctrl C</span> interrupt</span></div>
  <div id="transcriptWrap"><div id="transcript"></div><div id="scrollBottomZone" class="scroll-bottom-zone"><button id="scrollBottom" type="button" aria-label="Scroll to bottom">bottom</button></div></div>
  <div id="status"></div>
  <div id="queued"></div>
  <div id="composerWrap">
    <div id="completions"></div>
    <div id="composer"><div id="prompt">●</div><textarea id="input" spellcheck="false" autofocus></textarea></div>
  </div>
</div>
<script type="module">
import { marked } from '/vendor/marked.esm.js';
marked.setOptions({ gfm: true, breaks: false, async: false });
const TOOL_COLLAPSED_LINES = 6;
const STATUS_PHASE_MIN_DISPLAY_MS = 2000;
const state = { lines: [], status: { phase: 'ready', streamedOutputTokens: 0 }, busy: false, queuedInput: undefined, backgroundTaskCount: 0, catalog: { commands: [], modelIds: [], reasoning: [] }, history: [], historyIndex: undefined, completionIndex: 0, expandedToolLines: new Set() };
const renderedLineKeys = new Map();
const statusNodes = {};
const phaseDisplay = { value: state.status.phase, displayedAt: Date.now(), pending: undefined, timer: undefined };
let renderPending = false;
const transcript = document.getElementById('transcript');
const scrollBottomZone = document.getElementById('scrollBottomZone');
const scrollBottom = document.getElementById('scrollBottom');
const statusEl = document.getElementById('status');
const queuedEl = document.getElementById('queued');
const input = document.getElementById('input');
const completionsEl = document.getElementById('completions');
const connection = document.getElementById('connection');

const es = new EventSource('/events');
es.addEventListener('open', () => connection.textContent = 'connected');
es.addEventListener('error', () => connection.textContent = 'reconnecting…');
es.addEventListener('sync', (event) => {
  const payload = JSON.parse(event.data);
  state.lines = payload.lines || [];
  state.status = payload.status || state.status;
  state.busy = !!payload.busy;
  state.queuedInput = payload.queuedInput;
  state.backgroundTaskCount = payload.backgroundTaskCount || 0;
  if (payload.catalog) state.catalog = payload.catalog;
  scheduleRender();
});

function scheduleRender() {
  if (renderPending) return;
  renderPending = true;
  requestAnimationFrame(() => { renderPending = false; render(); });
}
function render() { renderTranscript(); renderStatus(); renderQueued(); renderCompletions(); updateScrollBottomAffordance(); input.classList.toggle('locked', state.busy && state.queuedInput !== undefined); }
function renderTranscript() {
  const atBottom = isTranscriptAtBottom();
  const seen = new Set();
  let cursor = transcript.firstElementChild;
  for (const line of state.lines) {
    const id = String(line.id);
    seen.add(id);
    let element = transcript.querySelector('[data-line-id="' + cssEscape(id) + '"]');
    const key = lineRenderKey(line);
    if (!element) {
      element = document.createElement('div');
      element.setAttribute('data-line-id', id);
      updateLineElement(element, line);
      renderedLineKeys.set(id, key);
    } else if (renderedLineKeys.get(id) !== key) {
      updateLineElement(element, line);
      renderedLineKeys.set(id, key);
    }
    if (element !== cursor) transcript.insertBefore(element, cursor);
    cursor = element.nextElementSibling;
  }
  for (const child of Array.from(transcript.children)) {
    const id = child.getAttribute('data-line-id');
    if (!seen.has(id)) { renderedLineKeys.delete(id); child.remove(); }
  }
  if (atBottom) transcript.scrollTop = transcript.scrollHeight;
}
function isTranscriptAtBottom() {
  return transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 80;
}
function updateScrollBottomAffordance() {
  scrollBottomZone.classList.toggle('available', !isTranscriptAtBottom());
}
function updateLineElement(element, line) {
  const kind = line.kind || 'system';
  const marker = markerForLine(line, kind);
  const markerCls = marker === '●' ? 'circle' : 'diamond';
  const expanded = state.expandedToolLines.has(line.id);
  const collapsible = kind === 'tool' && line.collapsible !== false && hasMoreThanLines(line.text || '', TOOL_COLLAPSED_LINES);
  const collapsed = collapsible && !expanded;
  const title = line.title ? '<div class="title ' + (line.titleStatus || '') + '">' + esc(line.title) + '</div>' : '';
  const bodyTitle = line.bodyTitle ? '<div class="body-title">' + esc(line.bodyTitle) + '</div>' : '';
  const markdown = shouldRenderMarkdown(line);
  const cls = ['block', 'kind-' + kind, line.live ? 'live' : '', line.previewStyle === 'summary' ? 'summary-block' : '', collapsible ? 'collapsible' : '', collapsed ? 'collapsed' : '', expanded ? 'expanded' : ''].filter(Boolean).join(' ');
  const contentCls = ['content', markdown ? 'markdown' : 'plain', line.previewStyle === 'summary' ? 'summary' : ''].filter(Boolean).join(' ');
  const body = '<div class="tool-body">' + bodyTitle + renderText(line.text || '', line.format, markdown) + '</div>';
  const toggle = collapsible ? '<button class="tool-toggle" type="button" data-line-id="' + String(line.id) + '" aria-expanded="' + (expanded ? 'true' : 'false') + '">' + (expanded ? 'collapse' : 'expand') + '</button>' : '';
  element.className = cls;
  element.innerHTML = '<div class="marker ' + markerCls + '">' + marker + '</div><div class="' + contentCls + '">' + title + body + toggle + '</div>';
}
function lineRenderKey(line) {
  const kind = line.kind || 'system';
  const expanded = state.expandedToolLines.has(line.id);
  const collapsible = kind === 'tool' && line.collapsible !== false && hasMoreThanLines(line.text || '', TOOL_COLLAPSED_LINES);
  return [kind, line.text || '', line.title || '', line.bodyTitle || '', line.titleStatus || '', line.format || '', line.previewStyle || '', line.summaryMaxLines || '', line.live ? '1' : '0', line.pendingReplacement ? '1' : '0', collapsible ? '1' : '0', expanded ? '1' : '0'].join('\u001f');
}
function markerForLine(line, kind) {
  if (kind === 'tool') return line.live || line.pendingReplacement ? '◇' : '◆';
  if (kind === 'thinking') return '◆';
  return '●';
}
function shouldRenderMarkdown(line) {
  if (line.format === 'ansi') return false;
  return line.kind === 'assistant' || line.kind === 'thinking' || line.kind === 'system' || line.kind === 'tool';
}
function hasMoreThanLines(text, maxLines) {
  if (!text) return false;
  let lines = 1;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10 && ++lines > maxLines) return true;
  }
  return false;
}
function renderText(text, format, markdown) {
  if (format === 'ansi') return '<span class="ansi">' + esc(stripAnsi(text)) + '</span>';
  if (!markdown) return linkify(esc(text));
  return sanitizeMarkdownHtml(marked.parse(text || ''));
}
function renderStatus() {
  ensureStatusNodes();
  const s = state.status || {};
  const displayPhase = minimumDisplayPhase(s.phase || 'ready');
  const phase = phaseLabel(displayPhase);
  const ctx = contextParts(s.metrics);
  const inputTokens = compactNumber((s.usage && s.usage.inputTokens) ?? (s.metrics && s.metrics.estimatedInputTokens));
  const outputTokens = compactNumber((s.usage && s.usage.outputTokens) ?? s.streamedOutputTokens);
  const model = truncateMiddle((s.metrics && s.metrics.model) || 'model?', window.innerWidth > 900 ? 26 : 14);
  const phaseActive = isActivePhase(displayPhase);
  const active = isActivePhase(s.phase);
  const phaseClass = ['phase', phaseActive ? 'active' : '', displayPhase === 'thinking' ? 'thinking' : '', displayPhase === 'running_tools' ? 'tools' : '', displayPhase === 'stopped' ? 'stopped' : ''].filter(Boolean).join(' ');
  setText(statusNodes.phase, phase);
  if (statusNodes.phase.className !== phaseClass) statusNodes.phase.className = phaseClass;
  setText(statusNodes.model, model);
  setText(statusNodes.ctxPercent, ctx.percent);
  const ctxColor = contextColor(s.metrics);
  if (statusNodes.ctxPercent.style.color !== ctxColor) statusNodes.ctxPercent.style.color = ctxColor;
  setText(statusNodes.ctxLimit, ctx.limit);
  setText(statusNodes.inputTokens, inputTokens);
  const outputArrowClass = active ? 'token-hot' : '';
  if (statusNodes.outputArrow.className !== outputArrowClass) statusNodes.outputArrow.className = outputArrowClass;
  setText(statusNodes.outputTokens, outputTokens);
  const tasks = state.backgroundTaskCount ? '◇'.repeat(Math.min(3, state.backgroundTaskCount)) + (state.backgroundTaskCount > 3 ? '×' + state.backgroundTaskCount : '') : '';
  const tasksDisplay = tasks ? '' : 'none';
  if (statusNodes.tasksWrap.style.display !== tasksDisplay) statusNodes.tasksWrap.style.display = tasksDisplay;
  setText(statusNodes.tasks, tasks);
}
function ensureStatusNodes() {
  if (statusNodes.phase) return;
  statusEl.innerHTML = '<span data-part="phase"></span><span class="sep">·</span><span data-part="model"></span><span class="sep">·</span><span class="ctx-stat">ctx <span data-part="ctxPercent"></span> of <span data-part="ctxLimit"></span></span><span class="sep">·</span><span>↑</span> <span data-part="inputTokens"></span><span class="sep">·</span><span data-part="outputArrow">↓</span> <span data-part="outputTokens"></span><span data-part="tasksWrap"><span class="sep">·</span><span data-part="tasks" style="color:var(--yellow)"></span></span>';
  for (const node of statusEl.querySelectorAll('[data-part]')) statusNodes[node.getAttribute('data-part')] = node;
}
function minimumDisplayPhase(target) {
  if (phaseDisplay.timer) {
    clearTimeout(phaseDisplay.timer);
    phaseDisplay.timer = undefined;
  }
  if (Object.is(target, phaseDisplay.value)) {
    phaseDisplay.pending = undefined;
    return phaseDisplay.value;
  }
  const applyPending = () => {
    const next = phaseDisplay.pending;
    if (next === undefined || Object.is(next, phaseDisplay.value)) {
      phaseDisplay.pending = undefined;
      return;
    }
    phaseDisplay.value = next;
    phaseDisplay.displayedAt = Date.now();
    phaseDisplay.pending = undefined;
    phaseDisplay.timer = undefined;
    scheduleRender();
  };
  phaseDisplay.pending = target;
  const remainingMs = STATUS_PHASE_MIN_DISPLAY_MS - (Date.now() - phaseDisplay.displayedAt);
  if (remainingMs <= 0) applyPending();
  else phaseDisplay.timer = setTimeout(applyPending, remainingMs);
  return phaseDisplay.value;
}
function setText(node, text) {
  text = String(text);
  if (node.textContent !== text) node.textContent = text;
}
function renderQueued() {
  if (!state.queuedInput) { if (queuedEl.style.display !== 'none') queuedEl.style.display = 'none'; return; }
  if (queuedEl.style.display !== 'block') queuedEl.style.display = 'block';
  setText(queuedEl, 'queued next: ' + state.queuedInput.replace(/\s+/g, ' ').trim() + '  (Esc/Ctrl+C to clear)');
}
function completions() {
  const text = input.value;
  const cursor = input.selectionStart || 0;
  const prefix = text.slice(0, cursor);
  const suffix = text.slice(cursor);
  if (!prefix.startsWith('/') || /\r|\n/.test(prefix) || /\S/.test(suffix)) return [];
  if (prefix.startsWith('/model') && (prefix.length === 6 || prefix[6] === ' ')) return modelCompletions(prefix);
  if (prefix.length > 1 && !/^\/[\w-]*$/.test(prefix)) return [];
  const normalized = prefix.toLowerCase();
  return (state.catalog.commands || []).flatMap(c => [c.name].concat(c.aliases || []).map(name => ({ value: name, insertText: name, description: c.description, arguments: c.arguments, kind: 'command' }))).filter(c => c.value.toLowerCase().startsWith(normalized));
}
function modelCompletions(prefix) {
  const hasTrailingSpace = /\s$/.test(prefix);
  const tokens = prefix.trim().split(/\s+/).filter(Boolean);
  const args = tokens.slice(1);
  if (args.length >= 2 && !hasTrailingSpace) return reasoningCompletions(args[0] || '', args[1] || '');
  if (args.length >= 2) return [];
  if (args.length === 1 && hasTrailingSpace) return reasoningCompletions(args[0] || '', '');
  const current = args[0] || '';
  const models = (state.catalog.modelIds || []).filter(id => id.toLowerCase().includes(current.toLowerCase())).slice(0, 80).map(id => ({ value: id, insertText: '/model ' + id, description: 'model id', arguments: 'optional', kind: 'model' }));
  const reasoning = reasoningCompletions('', current);
  return models.concat(reasoning);
}
function reasoningCompletions(modelId, current) { return (state.catalog.reasoning || []).filter(x => x.startsWith((current || '').toLowerCase())).map(x => ({ value: x, insertText: modelId ? '/model ' + modelId + ' ' + x : '/model ' + x, description: x === 'default' ? 'use env/provider default' : x === 'off' ? 'send no reasoning config' : 'reasoning effort: ' + x, arguments: 'optional', kind: 'reasoning' })); }
function renderCompletions() {
  const list = completions();
  input.classList.toggle('command', input.value.startsWith('/'));
  if (!list.length || state.busy && state.queuedInput !== undefined) { completionsEl.style.display = 'none'; return; }
  const selected = Math.max(0, Math.min(state.completionIndex, list.length - 1));
  state.completionIndex = selected;
  const pageSize = 10;
  const pageStart = Math.floor(selected / pageSize) * pageSize;
  const visible = list.slice(pageStart, pageStart + pageSize);
  const pageCount = Math.ceil(list.length / pageSize);
  const title = pageCount > 1 ? 'Completions (' + list.length + ') page ' + (Math.floor(pageStart / pageSize) + 1) + '/' + pageCount : 'Completions (' + list.length + ')';
  completionsEl.style.display = 'block';
  completionsEl.innerHTML = '<div class="completion-title">' + esc(title) + '</div>' + visible.map((c, i) => '<div class="completion-row ' + (c.kind || '') + ' ' + (i + pageStart === selected ? 'selected' : '') + '"><span class="num">' + (i + pageStart + 1) + '.</span><span class="name">' + esc(c.value) + '</span><span class="desc">' + esc(c.description || '') + '</span></div>').join('') + '<div class="completion-footer">↑/↓ select · ←/→ page · Tab complete</div>';
}
function selectedCompletion() { const list = completions(); return list.length ? list[Math.max(0, Math.min(state.completionIndex, list.length - 1))] : undefined; }
function completeSelection() { const c = selectedCompletion(); if (!c) return false; const cursor = input.selectionStart || 0; input.value = c.insertText + input.value.slice(cursor); input.selectionStart = input.selectionEnd = c.insertText.length; autosize(); renderCompletions(); return true; }
async function submit() {
  const text = input.value;
  if (!text.trim()) return;
  state.history = [text].concat(state.history.filter(x => x !== text)).slice(0, 100);
  state.historyIndex = undefined;
  input.value = '';
  autosize();
  renderCompletions();
  const res = await fetch('/api/submit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
  const body = await res.json();
  if (!body.ok && body.error) alert(body.error);
}
transcript.addEventListener('scroll', updateScrollBottomAffordance, { passive: true });
scrollBottom.addEventListener('click', () => { transcript.scrollTo({ top: transcript.scrollHeight, behavior: 'smooth' }); updateScrollBottomAffordance(); });
transcript.addEventListener('click', (e) => {
  const button = e.target.closest('.tool-toggle');
  if (!button) return;
  const id = Number(button.getAttribute('data-line-id'));
  if (!Number.isFinite(id)) return;
  if (state.expandedToolLines.has(id)) state.expandedToolLines.delete(id);
  else state.expandedToolLines.add(id);
  const line = state.lines.find(x => x.id === id);
  const element = transcript.querySelector('[data-line-id="' + cssEscape(String(id)) + '"]');
  if (line && element) {
    updateLineElement(element, line);
    renderedLineKeys.set(String(id), lineRenderKey(line));
  }
});
input.addEventListener('keydown', (e) => {
  const count = completions().length;
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); const c = selectedCompletion(); if (c && c.kind === 'command' && c.arguments !== 'none') { completeSelection(); input.value += ' '; input.selectionStart = input.selectionEnd = input.value.length; return; } submit(); return; }
  if (e.key === 'Tab') { if (completeSelection()) e.preventDefault(); return; }
  if (e.key === 'ArrowUp' && count) { e.preventDefault(); state.completionIndex = (state.completionIndex + count - 1) % count; renderCompletions(); return; }
  if (e.key === 'ArrowDown' && count) { e.preventDefault(); state.completionIndex = (state.completionIndex + 1) % count; renderCompletions(); return; }
  if (e.key === 'ArrowLeft' && count > 10) { e.preventDefault(); state.completionIndex = (state.completionIndex + count - 10) % count; renderCompletions(); return; }
  if (e.key === 'ArrowRight' && count > 10) { e.preventDefault(); state.completionIndex = (state.completionIndex + 10) % count; renderCompletions(); return; }
  if (e.key === 'ArrowUp' && !input.value && state.history.length) { e.preventDefault(); state.historyIndex = Math.min(state.history.length - 1, (state.historyIndex ?? -1) + 1); input.value = state.history[state.historyIndex] || ''; autosize(); return; }
  if (e.key === 'ArrowDown' && state.historyIndex !== undefined) { e.preventDefault(); state.historyIndex -= 1; if (state.historyIndex < 0) { state.historyIndex = undefined; input.value = ''; } else input.value = state.history[state.historyIndex] || ''; autosize(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') { if (input.value) { input.value = ''; autosize(); renderCompletions(); } else fetch('/api/interrupt', { method: 'POST' }); }
  if (e.key === 'Escape') { state.completionIndex = 0; if (state.queuedInput) fetch('/api/interrupt', { method: 'POST' }); else renderCompletions(); }
});
input.addEventListener('input', () => { state.completionIndex = 0; autosize(); renderCompletions(); });
function autosize() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, window.innerHeight * .35) + 'px'; updateScrollBottomAffordance(); }
function phaseLabel(phase) { if (phase === 'calling_model') return 'model'; if (phase === 'thinking') return 'think'; if (phase === 'running_tools') return 'tools'; if (phase === 'injecting_context') return 'context'; return phase || 'ready'; }
function isActivePhase(phase) { return ['running', 'preparing', 'calling_model', 'thinking', 'running_tools', 'compacting', 'injecting_context'].includes(phase); }
function contextParts(metrics) { if (!metrics) return { used: '?', limit: '?', percent: '?' }; return { used: compactNumber(metrics.estimatedInputTokens), limit: metrics.contextWindowTokens ? compactNumber(metrics.contextWindowTokens) : '?', percent: metrics.contextUsageRatio === undefined ? '?' : (metrics.contextUsageRatio * 100).toFixed(1) + '%' }; }
function contextColor(metrics) { const r = metrics && metrics.contextUsageRatio; if (r === undefined) return 'var(--muted)'; if (r >= .9) return 'var(--red)'; if (r >= .75) return 'var(--yellow)'; return 'var(--muted)'; }
function compactNumber(value) { if (value === undefined || value === null) return '?'; const n = Math.max(0, Math.round(value)); if (n >= 1000000) return trimFixed(n / 1000000) + 'm'; if (n >= 10000) return Math.round(n / 1000) + 'k'; if (n >= 1000) return trimFixed(n / 1000) + 'k'; return String(n); }
function trimFixed(v) { return v >= 10 ? v.toFixed(0) : v.toFixed(1).replace(/\.0$/, ''); }
function truncateMiddle(value, max) { value = String(value); if (value.length <= max) return value; if (max <= 3) return value.slice(0, max); const l = Math.ceil((max - 3) / 2), r = Math.floor((max - 3) / 2); return value.slice(0, l) + '...' + value.slice(value.length - r); }
function stripAnsi(value) { return String(value).replace(/\x1b\[[0-9;]*m/g, ''); }
function cssEscape(value) { return window.CSS && CSS.escape ? CSS.escape(value) : String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&'); }
function sanitizeMarkdownHtml(html) {
  const template = document.createElement('template');
  template.innerHTML = String(html);
  const allowed = new Set(['A', 'P', 'BR', 'STRONG', 'B', 'EM', 'I', 'CODE', 'PRE', 'BLOCKQUOTE', 'UL', 'OL', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HR', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'DEL', 'S', 'INPUT', 'TASK-LIST']);
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_ELEMENT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    if (!allowed.has(node.tagName)) {
      node.replaceWith(document.createTextNode(node.textContent || ''));
      continue;
    }
    for (const attr of Array.from(node.attributes)) {
      const name = attr.name.toLowerCase();
      const value = attr.value;
      const keep = (node.tagName === 'A' && name === 'href' && safeHref(value)) ||
        (node.tagName === 'A' && name === 'title') ||
        (node.tagName === 'CODE' && name === 'class' && /^language-[\w-]+$/.test(value)) ||
        (node.tagName === 'INPUT' && (name === 'type' || name === 'checked' || name === 'disabled'));
      if (!keep) node.removeAttribute(attr.name);
    }
    if (node.tagName === 'A') {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noreferrer noopener');
    }
    if (node.tagName === 'INPUT') {
      if (node.getAttribute('type') !== 'checkbox') node.remove();
      else node.setAttribute('disabled', '');
    }
  }
  highlightMarkdownCodeBlocks(template.content);
  return template.innerHTML;
}
function highlightMarkdownCodeBlocks(root) {
  const highlighter = window.hljs;
  for (const code of root.querySelectorAll('pre > code')) {
    const language = normalizeCodeLanguage(code.className);
    const pre = code.parentElement;
    if (pre && language) pre.setAttribute('data-lang', language);
    if (!highlighter) continue;
    try {
      const source = code.textContent || '';
      const canUseLanguage = language && highlighter.getLanguage(language);
      const result = canUseLanguage
        ? highlighter.highlight(source, { language, ignoreIllegals: true })
        : source.length <= 20000
          ? highlighter.highlightAuto(source)
          : undefined;
      if (!result) continue;
      code.innerHTML = result.value;
      code.className = ['hljs', result.language ? 'language-' + result.language : language ? 'language-' + language : ''].filter(Boolean).join(' ');
      if (pre && result.language && !pre.hasAttribute('data-lang')) pre.setAttribute('data-lang', result.language);
    } catch {
      code.textContent = code.textContent || '';
    }
  }
}
function normalizeCodeLanguage(className) {
  const match = /(?:^|\s)language-([\w-]+)/.exec(className || '') || /(?:^|\s)lang-([\w-]+)/.exec(className || '');
  if (!match) return '';
  const value = match[1].toLowerCase();
  const aliases = { cjs: 'javascript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', node: 'javascript', py: 'python', python3: 'python', sh: 'bash', shell: 'bash', ts: 'typescript', tsx: 'typescript', yml: 'yaml' };
  return aliases[value] || value;
}
function safeHref(value) {
  try {
    const url = new URL(value, window.location.href);
    return url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:';
  } catch { return false; }
}
function esc(value) { return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function linkify(value) { return value.replace(/(https?:\/\/[^\s<]+)/g, '<a style="color:var(--cyan)" target="_blank" href="$1">$1</a>'); }
autosize();
</script>
</body>
</html>`;

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runWebServer().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
