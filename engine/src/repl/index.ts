#!/usr/bin/env node
import fs from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { stdin, stdout } from "node:process";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, Static, Text, render, useApp, useInput } from "ink";
import stripAnsi from "strip-ansi";
import wrapAnsi from "wrap-ansi";
import { QueryEngine } from "../core/query-engine.js";
import type { SessionStoreSnapshot, SessionSummary } from "../session/session-store.js";
import { getUserDotEnvPath, loadDefaultDotEnvFiles } from "../model/env.js";
import { readModelProviderConfig, type ModelProviderName } from "../model/config.js";
import { loadModelCatalog, reasoningEffortsForModel, resolveContextWindowTokens } from "../model/context-window.js";
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
import { isModelReasoningArgument, isValidReplCommandLine, parseReplCommand, helpText, replCommandDefinitions, type ModelReasoningArgument, type ReplCommandArgumentSpec } from "./commands.js";
import { estimateMarkdownLineCount, markdownRenderKey, MarkdownText } from "./markdown-renderer.js";
import type { CompactionResult } from "../context/compaction.js";
import { writeSessionMarkdownExport } from "../session/session-export.js";
import type { AgentEvent, ContextMetrics } from "../types/events.js";
import type { Message, MessageBlock, ToolUseRequest } from "../types/messages.js";
import { readClipboard, type ClipboardImagePayload } from "./clipboard.js";

const e = React.createElement;
interface ReplRuntime {
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

    if (
      inputTokens === undefined &&
      outputTokens === undefined &&
      computedTotalTokens === undefined &&
      reasoningTokens === undefined &&
      cachedTokens === undefined
    ) return;

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
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    reasoningTokens: 0,
    cachedTokens: 0,
    requests: 0,
    computedTotalTokens: false,
  };
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
  titleStatus?: "success" | "failure";
  format?: "markdown" | "ansi";
  previewStyle?: "summary";
  summaryMaxLines?: number;
  live?: boolean;
  pendingReplacement?: boolean;
  renderedKey?: string;
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

interface SessionsBrowserState {
  sessions: SessionSummary[];
  pageSize: number;
  pageIndex: number;
  selectedIndex: number;
}

interface ClipboardAttachment {
  id: number;
  kind: "image" | "text";
  label: string;
  text?: string;
  image?: ClipboardImagePayload;
}

type LoginProviderName = ModelProviderName;
type LoginStep = "provider" | "fields";

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

interface LoginFormState {
  step: LoginStep;
  providers: LoginProviderName[];
  selectedProviderIndex: number;
  provider: LoginProviderName;
  selectedFieldIndex: number;
  cursor: number;
  values: Record<string, string>;
  envPath: string;
  legacyProvider?: LoginProviderName;
}

async function main(): Promise<void> {
  const runtime = await createRuntime();
  const instance = render(e(InkRepl, { runtime }), {
    exitOnCtrlC: false,
  });
  await instance.waitUntilExit();
  console.log("bye.");
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

async function createRuntime(): Promise<ReplRuntime> {
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
      appState: new (await import("../app/app-state.js")).InMemoryAppState("main"),
      emit: () => undefined,
    };
    return resumeAgentTask(taskId, directive, agentRuntime, taskStore, dummyContext);
  };

  for (const tool of createTaskTools(taskStore, resumeHandler)) tools.register(tool);

  const taskNotificationSource = createTaskNotificationSource(taskStore);

  const engine = new QueryEngine({
    agentId: "main",
    model: modelConfig?.model,
    fallbackModel: modelConfig?.fallbackModel,
    reasoning: modelConfig?.defaultReasoning,
    modelGateway,
    tools,
    taskNotificationSource,
    commands: replCommandDefinitions.map((command) => command.usage),
    session: {
      enabled: process.env.AGENT_SESSION_TRANSCRIPT !== "0",
      sessionId: process.env.AGENT_SESSION_ID,
      rootDir: process.env.AGENT_SESSION_DIR,
      resume: parseResumeFlag(process.env.AGENT_SESSION_RESUME),
      toolResultThresholdChars: process.env.AGENT_TOOL_RESULT_THRESHOLD_CHARS
        ? Number(process.env.AGENT_TOOL_RESULT_THRESHOLD_CHARS)
        : undefined,
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

function formatCreatedEnvNotice(path: string): string {
  return `Created default config file: ${path}\nSet MODEL_PROVIDER and the matching provider section (for example OPENAI_API_KEY), then restart neo.`;
}

function parseResumeFlag(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "latest"].includes(value.toLowerCase());
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
    modelMetadata: window.model
      ? {
          id: window.model.id,
          provider: window.model.provider,
          maxOutputTokens: window.model.maxOutputTokens,
          knowledgeCutoff: window.model.knowledgeCutoff,
          reasoning: window.model.reasoning,
          imageInput: window.model.imageInput,
          source: window.model.source,
        }
      : undefined,
  };
}

function initialStatus(runtime: ReplRuntime, metrics = runtime.initialMetrics): UiStatus {
  return {
    phase: "ready",
    metrics: {
      ...metrics,
      messageCount: runtime.engine.snapshot().messages,
    },
    streamedOutputTokens: 0,
    activityTick: 0,
  };
}

function resetStatus(runtime: ReplRuntime): UiStatus {
  return initialStatus(runtime, initialContextMetrics(runtime.engine.getModelSettings().model, runtime.engine.snapshot().messages, runtime.initialMetrics.toolCount));
}

function setTerminalTitle(title: string, dotFilled = true): void {
  if (!stdout.isTTY) return;
  const safeTitle = title.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  const dotPrefix = dotFilled ? TERMINAL_TITLE_DOT_FILLED_PREFIX : TERMINAL_TITLE_DOT_BLANK_PREFIX;
  const decoratedTitle = `${dotPrefix}${safeTitle || "neo"}`.slice(0, 120);
  stdout.write(`\u001b]0;${decoratedTitle}\u0007`);
}

function playReadySound(): void {
  if (!stdout.isTTY) return;
  stdout.write("\u0007");
}

function enableTerminalFocusReporting(): void {
  if (!stdout.isTTY) return;
  stdout.write("\u001b[?1004h");
}

function enableTerminalMouseReporting(): void {
  if (!stdout.isTTY || !stdin.isTTY) return;
  // Only enable SGR extended coordinates; no tracking mode (?1000h etc.)
  // is activated so the terminal keeps handling scroll-wheel natively.
  // Right-click paste is handled via Ctrl+V / Cmd+V instead.
  stdout.write("\u001b[?1006h");
}

function disableTerminalFocusReporting(): void {
  if (!stdout.isTTY) return;
  stdout.write("\u001b[?1004l");
}

function disableTerminalMouseReporting(): void {
  if (!stdout.isTTY) return;
  stdout.write("\u001b[?1006l");
}

function isTerminalFocusInSequence(value: string): boolean {
  return value === "\u001b[I";
}

function isTerminalFocusOutSequence(value: string): boolean {
  return value === "\u001b[O";
}

function sessionTerminalTitle(snapshot: SessionStoreSnapshot | undefined): string {
  return snapshot?.title?.trim() || "neo";
}

function isPasteShortcut(value: string, key: { ctrl?: boolean; meta?: boolean }): boolean {
  return (key.ctrl === true && value === "v") || (key.meta === true && value === "v") || value === "\u0016" || value === "\u001bv";
}

function isRightClickPasteSequence(value: string): boolean {
  const match = /^\u001b\[<(\d+);\d+;\d+M$/u.exec(value);
  if (!match) return false;
  const button = Number(match[1]);
  return button % 4 === 2;
}

function mouseScrollDirection(value: string): "up" | "down" | undefined {
  const match = /^\u001b\[<(\d+);\d+;\d+[Mm]$/u.exec(value);
  if (!match) return undefined;
  const button = Number(match[1]);
  if (button === 64) return "up";
  if (button === 65) return "down";
  return undefined;
}

function shouldFoldClipboardText(text: string): boolean {
  return text.length >= LONG_CLIPBOARD_TEXT_THRESHOLD;
}

function attachmentsForText(text: string, attachments: readonly ClipboardAttachment[]): ClipboardAttachment[] {
  return attachments.filter((attachment) => text.includes(attachment.label));
}

function buildPromptPayload(displayText: string, attachments: readonly ClipboardAttachment[]): { text: string; blocks?: MessageBlock[] } {
  const activeAttachments = attachmentsForText(displayText, attachments);
  if (activeAttachments.length === 0) return { text: displayText };

  const blocks: MessageBlock[] = [];
  let cursor = 0;
  while (cursor < displayText.length) {
    const next = nextAttachmentOccurrence(displayText, activeAttachments, cursor);
    if (!next) {
      pushTextBlock(blocks, displayText.slice(cursor));
      break;
    }
    pushTextBlock(blocks, displayText.slice(cursor, next.index));
    if (next.attachment.kind === "text" && next.attachment.text !== undefined) {
      pushTextBlock(blocks, next.attachment.text);
    } else if (next.attachment.kind === "image" && next.attachment.image) {
      blocks.push({ type: "image", mimeType: next.attachment.image.mimeType, data: next.attachment.image.data, label: next.attachment.label });
    }
    cursor = next.index + next.attachment.label.length;
  }

  const text = blocks
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "image") return block.label ?? "[image]";
      return "";
    })
    .join("");
  return { text, blocks };
}

function nextAttachmentOccurrence(text: string, attachments: readonly ClipboardAttachment[], start: number): { index: number; attachment: ClipboardAttachment } | undefined {
  let best: { index: number; attachment: ClipboardAttachment } | undefined;
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
  if (previous?.type === "text") {
    previous.text += text;
    return;
  }
  blocks.push({ type: "text", text });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function InkRepl({ runtime }: { runtime: ReplRuntime }) {
  const app = useApp();
  const lineId = useRef(0);
  const assistantLineId = useRef<number | undefined>(undefined);
  const thinkingLineId = useRef<number | undefined>(undefined);
  const finalizedThinkingLineId = useRef<number | undefined>(undefined);
  const activeAbortController = useRef<AbortController | undefined>(undefined);
  const interruptArmed = useRef(false);
  const history = useRef<string[]>([]);
  const toolLineIds = useRef(new Map<string, number>());
  const pendingToolResultTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const [lines, setLines] = useState<UiLine[]>(() => initialLines(runtime, lineId));
  const [input, setInput] = useState("");
  const [queuedInput, setQueuedInput] = useState<string | undefined>(undefined);
  const queuedAttachmentsRef = useRef<ClipboardAttachment[] | undefined>(undefined);
  const [cursor, setCursor] = useState(0);
  const [promptPlaceholder, setPromptPlaceholder] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<UiStatus>(() => initialStatus(runtime));
  const sessionTitleRef = useRef(sessionTerminalTitle(runtime.engine.snapshot().session));
  const [backgroundTaskCount, setBackgroundTaskCount] = useState(() => runtime.taskStore.activeCount());
  const [animationTick, setAnimationTick] = useState(0);
  const [terminalTitleDotVisible, setTerminalTitleDotVisible] = useState(true);
  const terminalTitleWorking = isActivePhase(status.phase) || backgroundTaskCount > 0;
  const [sessionsBrowser, setSessionsBrowser] = useState<SessionsBrowserState | undefined>(undefined);
  const inputRef = useRef(input);
  const queuedInputRef = useRef<string | undefined>(undefined);
  const cursorRef = useRef(cursor);
  const busyRef = useRef(busy);
  const exitOnNextEmptyCtrlCRef = useRef(false);
  const terminalFocusedRef = useRef(true);
  const historyIndexRef = useRef<number | undefined>(undefined);
  const slashCompletionIndexRef = useRef(0);
  const imageAttachmentCounterRef = useRef(0);
  const textAttachmentCounterRef = useRef(0);
  const attachmentsRef = useRef<ClipboardAttachment[]>([]);
  const [attachments, setAttachments] = useState<ClipboardAttachment[]>([]);
  const [pasteStatus, setPasteStatus] = useState<string | undefined>(undefined);
  const pasteStatusTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [slashCompletionIndex, setSlashCompletionIndex] = useState(0);
  const [loginForm, setLoginForm] = useState<LoginFormState | undefined>(undefined);
  const loginFormRef = useRef<LoginFormState | undefined>(undefined);

  useEffect(() => {
    enableTerminalFocusReporting();
    enableTerminalMouseReporting();
    return () => {
      disableTerminalMouseReporting();
      disableTerminalFocusReporting();
    };
  }, []);

  useEffect(() => {
    if (!busy && backgroundTaskCount === 0) return undefined;
    const interval = setInterval(() => setAnimationTick((current) => current + 1), REPL_ANIMATION_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [busy, backgroundTaskCount]);

  useEffect(() => {
    const updateBackgroundTaskCount = () => setBackgroundTaskCount(runtime.taskStore.activeCount());
    updateBackgroundTaskCount();
    return runtime.taskStore.subscribe(updateBackgroundTaskCount);
  }, [runtime]);

  useEffect(() => {
    if (!terminalTitleWorking) {
      setTerminalTitleDotVisible(true);
      return undefined;
    }
    setTerminalTitleDotVisible(true);
    const interval = setInterval(() => setTerminalTitleDotVisible((visible) => !visible), TERMINAL_TITLE_BLINK_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [terminalTitleWorking]);

  useEffect(() => {
    const updateTitle = (snapshot: SessionStoreSnapshot | undefined) => {
      sessionTitleRef.current = sessionTerminalTitle(snapshot);
      setTerminalTitle(sessionTitleRef.current, terminalTitleDotVisible);
    };
    updateTitle(runtime.engine.snapshot().session);
    return runtime.engine.onSessionTitleChange(updateTitle);
  }, [runtime, terminalTitleDotVisible]);

  useEffect(() => {
    setTerminalTitle(sessionTitleRef.current, terminalTitleDotVisible);
  }, [terminalTitleDotVisible]);

  const setPromptState = (text: string, nextCursor: number, options?: { preserveSlashCompletionSelection?: boolean }) => {
    const safeCursor = Math.max(0, Math.min(nextCursor, text.length));
    inputRef.current = text;
    cursorRef.current = safeCursor;
    exitOnNextEmptyCtrlCRef.current = false;
    setPromptPlaceholder(undefined);
    syncAttachmentsForText(text);
    if (!options?.preserveSlashCompletionSelection) resetSlashCompletionSelection();
    setInput(text);
    setCursor(safeCursor);
  };

  const setQueuedPromptState = (text: string | undefined, queuedAttachments?: ClipboardAttachment[]) => {
    queuedInputRef.current = text;
    queuedAttachmentsRef.current = text === undefined ? undefined : (queuedAttachments ?? attachmentsForText(text, attachmentsRef.current));
    setQueuedInput(text);
  };

  const setHistorySelection = (next: number | undefined) => {
    historyIndexRef.current = next;
  };

  const setSlashCompletionSelection = (next: number) => {
    const safeIndex = Math.max(0, next);
    slashCompletionIndexRef.current = safeIndex;
    setSlashCompletionIndex(safeIndex);
  };

  const resetSlashCompletionSelection = () => setSlashCompletionSelection(0);

  const setLoginFormState = (next: LoginFormState | undefined) => {
    loginFormRef.current = next;
    setLoginForm(next);
  };

  const syncAttachmentsForText = (text: string) => {
    const next = attachmentsRef.current.filter((attachment) => text.includes(attachment.label));
    if (next.length === attachmentsRef.current.length) return;
    attachmentsRef.current = next;
    setAttachments(next);
  };

  const clearAttachments = () => {
    if (attachmentsRef.current.length === 0) return;
    attachmentsRef.current = [];
    setAttachments([]);
  };

  const setPasteStatusMessage = (message: string | undefined) => {
    if (pasteStatusTimerRef.current) clearTimeout(pasteStatusTimerRef.current);
    setPasteStatus(message);
    if (!message) return;
    const timer = setTimeout(() => {
      if (pasteStatusTimerRef.current === timer) pasteStatusTimerRef.current = undefined;
      setPasteStatus(undefined);
    }, PASTE_STATUS_DISPLAY_MS);
    pasteStatusTimerRef.current = timer;
  };

  const insertAtCursor = (value: string) => {
    const currentText = inputRef.current;
    const currentCursor = cursorRef.current;
    setPromptState(`${currentText.slice(0, currentCursor)}${value}${currentText.slice(currentCursor)}`, currentCursor + value.length);
  };

  const insertAttachmentLabel = (attachment: ClipboardAttachment) => {
    attachmentsRef.current = [...attachmentsRef.current, attachment];
    setAttachments(attachmentsRef.current);
    insertAtCursor(attachment.label);
  };

  const handleClipboardPaste = async () => {
    try {
      const payload = await readClipboard();
      if (payload.type === "empty") {
        setPasteStatusMessage("clipboard is empty");
        return;
      }
      if (payload.type === "image") {
        if (!runtime.engine.canAcceptImageInput()) {
          setPasteStatusMessage("current model does not support image input; image was not added");
          return;
        }
        const id = ++imageAttachmentCounterRef.current;
        insertAttachmentLabel({ id, kind: "image", label: `[img#${id}]`, image: payload.image });
        setPasteStatusMessage(undefined);
        return;
      }
      const text = payload.text;
      if (shouldFoldClipboardText(text)) {
        const id = ++textAttachmentCounterRef.current;
        insertAttachmentLabel({ id, kind: "text", label: `[text_${text.length}#${id}]`, text });
      } else {
        insertAtCursor(text);
      }
      setPasteStatusMessage(undefined);
    } catch (error) {
      setPasteStatusMessage(`paste failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const setBusyState = (next: boolean) => {
    busyRef.current = next;
    setBusy(next);
  };

  const append = (line: Omit<UiLine, "id">) => {
    const id = ++lineId.current;
    const next: UiLine = { id, ...line };
    setLines((current) => [...current, next]);
    return id;
  };

  const updateLine = (id: number, updater: (text: string) => string) => {
    setLines((current) => current.map((line) => line.id === id ? { ...line, text: updater(line.text), renderedKey: undefined } : line));
  };

  const replaceLineText = (id: number, text: string) => {
    setLines((current) => current.map((line) => line.id === id ? { ...line, text, renderedKey: undefined } : line));
  };

  const markLineRendered = useCallback((id: number, renderKey: string) => {
    setLines((current) => {
      let changed = false;
      const next = current.map((line) => {
        if (line.id !== id) return line;
        if (line.renderedKey === renderKey) return line;
        changed = true;
        return { ...line, renderedKey: renderKey };
      });
      return changed ? next : current;
    });
  }, []);

  const replaceLine = (id: number, patch: Partial<UiLine>) => {
    setLines((current) => current.map((line) => line.id === id ? { ...line, ...patch, renderedKey: undefined } : line));
  };

  const resumeSnapshot = (snapshot: SessionStoreSnapshot, metrics?: ContextMetrics) => {
    runtime.usage.reset();
    setStatus(initialStatus(runtime, metrics));
    resetLinesToHistory(runtime, setLines, lineId);
    assistantLineId.current = undefined;
    thinkingLineId.current = undefined;
    finalizedThinkingLineId.current = undefined;
    toolLineIds.current.clear();
    clearPendingToolResultTimers();
    append(systemLine(formatResume(snapshot)));
  };

  const finalizeLiveLine = (id: number | undefined) => {
    if (id === undefined) return;
    setLines((current) => current.map((line) => line.id === id ? { ...line, live: false } : line));
  };

  const finalizeThinkingLine = () => {
    const id = thinkingLineId.current;
    if (id === undefined) return;
    finalizeLiveLine(id);
    finalizedThinkingLineId.current = id;
    thinkingLineId.current = undefined;
  };

  const finalizeToolLine = (id: number | undefined) => {
    if (id === undefined) return;
    setLines((current) => current.map((line) => line.id === id ? { ...line, live: false, pendingReplacement: false } : line));
  };

  const cancelPendingToolResultTimer = (toolUseId: string) => {
    const timer = pendingToolResultTimers.current.get(toolUseId);
    if (timer === undefined) return;
    clearTimeout(timer);
    pendingToolResultTimers.current.delete(toolUseId);
  };

  const scheduleToolResultReplacement = (toolUseId: string, lineId: number, line: Omit<UiLine, "id">) => {
    cancelPendingToolResultTimer(toolUseId);
    const timer = setTimeout(() => {
      pendingToolResultTimers.current.delete(toolUseId);
      replaceLine(lineId, { ...line, pendingReplacement: false });
    }, TOOL_RESULT_REPLACEMENT_DELAY_MS);
    pendingToolResultTimers.current.set(toolUseId, timer);
  };

  const clearPendingToolResultTimers = () => {
    for (const timer of pendingToolResultTimers.current.values()) clearTimeout(timer);
    pendingToolResultTimers.current.clear();
  };

  useEffect(() => {
    return () => {
      clearPendingToolResultTimers();
      if (pasteStatusTimerRef.current) clearTimeout(pasteStatusTimerRef.current);
    };
  }, []);

  const finalizeActiveToolLines = () => {
    for (const id of toolLineIds.current.values()) finalizeToolLine(id);
    toolLineIds.current.clear();
  };

  const handleEvent = (event: AgentEvent) => {
    setStatus((current) => reduceStatus(current, event));
    if (event.type === "usage") runtime.usage.add(event.usage);
    if (event.type === "state") return;
    if (event.type === "context.metrics" || event.type === "usage" || event.type === "tool_call.delta") return;
    if (event.type === "assistant.delta") {
      finalizeThinkingLine();
      const id = assistantLineId.current ?? append({ kind: "assistant", text: "", live: true });
      assistantLineId.current = id;
      updateLine(id, (text) => text + event.text);
      return;
    }
    if (event.type === "thinking.delta") {
      const id = thinkingLineId.current ?? finalizedThinkingLineId.current ?? append(thinkingLine("", true));
      thinkingLineId.current = id;
      finalizedThinkingLineId.current = undefined;
      updateLine(id, (text) => text + event.text);
      return;
    }
    if (event.type === "message") {
      let replacedStreamingContent = false;
      if (event.message.role === "assistant" && assistantLineId.current !== undefined) {
        const text = assistantText(event.message);
        if (text !== undefined) {
          replaceLineText(assistantLineId.current, text);
          finalizeLiveLine(assistantLineId.current);
          assistantLineId.current = undefined;
          replacedStreamingContent = true;
        }
      }
      const existingThinkingLineId = thinkingLineId.current ?? finalizedThinkingLineId.current;
      if (event.message.role === "assistant" && existingThinkingLineId !== undefined) {
        const text = thinkingText(event.message);
        if (text !== undefined) {
          replaceLineText(existingThinkingLineId, text);
          finalizeLiveLine(existingThinkingLineId);
          thinkingLineId.current = undefined;
          finalizedThinkingLineId.current = undefined;
          replacedStreamingContent = true;
        }
      }
      if (replacedStreamingContent) return;
      if (event.message.role === "tool_result") {
        renderToolResultMessage(event.message, append, replaceLine, toolLineIds.current, scheduleToolResultReplacement);
        return;
      }
      if (event.message.role !== "assistant") {
        finalizeLiveLine(assistantLineId.current);
        finalizeThinkingLine();
        assistantLineId.current = undefined;
      }
      const rendered = renderMessage(event.message, append, assistantLineId.current);
      if (rendered && event.message.role === "assistant") {
        finalizeLiveLine(assistantLineId.current);
        finalizeThinkingLine();
        assistantLineId.current = undefined;
      }
      return;
    }
    if (event.type === "tool.started") {
      finalizeLiveLine(assistantLineId.current);
      finalizeThinkingLine();
      const id = append({ ...formatToolUse(event.toolUse), live: true });
      toolLineIds.current.set(event.toolUse.id, id);
      return;
    }
    if (event.type === "tool.finished") {
      const id = toolLineIds.current.get(event.toolUse.id);
      if (id !== undefined) {
        replaceLine(id, formatToolFinishedWithoutResult(event.toolUse, event.ok));
      }
      return;
    }
    if (event.type === "retrying") return;
    if (event.type === "terminal") {
      finalizeLiveLine(assistantLineId.current);
      finalizeThinkingLine();
      finalizeActiveToolLines();
      assistantLineId.current = undefined;
      return;
    }
    if (event.type === "error") {
      append({ kind: "error", text: event.error.message });
    }
  };

  const submitLine = async (text: string, submitAttachments = attachmentsForText(text, attachmentsRef.current)) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (submitAttachments.some((attachment) => attachment.kind === "image") && !runtime.engine.canAcceptImageInput()) {
      append({ kind: "error", text: "Current model does not support image input; image attachments were not added to the conversation." });
      return;
    }
    if (busyRef.current) {
      if (queuedInputRef.current !== undefined) return;
      setQueuedPromptState(text, submitAttachments);
      setHistorySelection(undefined);
      setPromptState("", 0);
      clearAttachments();
      return;
    }
    history.current = [text, ...history.current.filter((entry) => entry !== text)].slice(0, 100);
    setHistorySelection(undefined);
    setPromptState("", 0);
    clearAttachments();
    await handleCommandOrPrompt(text, submitAttachments);
  };

  const takeQueuedPromptState = () => {
    const text = queuedInputRef.current;
    if (text === undefined) return undefined;
    const queuedAttachments = queuedAttachmentsRef.current ?? [];
    setQueuedPromptState(undefined);
    return { text, attachments: queuedAttachments };
  };

  const restoreQueuedPromptToEditor = () => {
    const queued = takeQueuedPromptState();
    if (queued === undefined) return false;
    attachmentsRef.current = attachmentsForText(queued.text, queued.attachments);
    setAttachments(attachmentsRef.current);
    setPromptState(queued.text, queued.text.length);
    return true;
  };

  const handleCommandOrPrompt = async (text: string, submitAttachments: ClipboardAttachment[] = []) => {
    const command = parseReplCommand(text);
    if (command.type === "exit") {
      app.exit();
      return;
    }
    if (command.type === "help") {
      append(systemLine(helpText, EXPANDED_SUMMARY_MAX_LINES));
      return;
    }
    if (command.type === "cost") {
      append({ kind: "system", text: formatUsageTotals(runtime.usage.snapshot()) });
      return;
    }
    if (command.type === "compact") {
      const abortController = new AbortController();
      activeAbortController.current = abortController;
      interruptArmed.current = false;
      setBusyState(true);
      setStatus((current) => ({ ...current, phase: "compacting", detail: "manual compact", activityTick: current.activityTick + 1 }));
      try {
        const result = await runtime.engine.compact({ abortSignal: abortController.signal });
        const metrics = await runtime.engine.contextMetrics();
        append(systemLine(formatManualCompaction(result)));
        setStatus((current) => reduceStatus(current, { type: "context.metrics", metrics }));
      } catch (error) {
        append({ kind: "error", text: error instanceof Error ? error.message : String(error) });
      } finally {
        if (activeAbortController.current === abortController) activeAbortController.current = undefined;
        interruptArmed.current = false;
        setBusyState(false);
        setStatus((current) => ({ ...current, phase: "ready", detail: undefined, activityTick: current.activityTick + 1 }));
        const queued = takeQueuedPromptState();
        if (queued !== undefined) {
          void submitLine(queued.text, queued.attachments);
        }
      }
      return;
    }
    if (command.type === "pure") {
      const abortController = new AbortController();
      activeAbortController.current = abortController;
      interruptArmed.current = false;
      setBusyState(true);
      setStatus((current) => ({ ...current, phase: "compacting", detail: "pure compact", activityTick: current.activityTick + 1 }));
      try {
        const result = await runtime.engine.pureCompact({ abortSignal: abortController.signal });
        const metrics = await runtime.engine.contextMetrics();
        append(systemLine(formatPureCompaction(result)));
        setStatus((current) => reduceStatus(current, { type: "context.metrics", metrics }));
      } catch (error) {
        append({ kind: "error", text: error instanceof Error ? error.message : String(error) });
      } finally {
        if (activeAbortController.current === abortController) activeAbortController.current = undefined;
        interruptArmed.current = false;
        setBusyState(false);
        setStatus((current) => ({ ...current, phase: "ready", detail: undefined, activityTick: current.activityTick + 1 }));
        const queued = takeQueuedPromptState();
        if (queued !== undefined) {
          void submitLine(queued.text, queued.attachments);
        }
      }
      return;
    }
    if (command.type === "reset") {
      runtime.engine.reset();
      runtime.usage.reset();
      setStatus(resetStatus(runtime));
      append(systemLine("transcript reset"));
      return;
    }
    if (command.type === "state") {
      append(systemLine(formatReplData({ ...runtime.engine.snapshot(), communicationLog: runtime.communicationLogger.snapshot() }, 12000), EXPANDED_SUMMARY_MAX_LINES));
      return;
    }
    if (command.type === "export") {
      setBusyState(true);
      setStatus((current) => ({ ...current, phase: "running", detail: "exporting session", activityTick: current.activityTick + 1 }));
      try {
        const line = await handleExportCommand(command, runtime);
        append(line);
      } catch (error) {
        append({ kind: "error", text: error instanceof Error ? error.message : String(error) });
      } finally {
        setBusyState(false);
        setStatus((current) => ({ ...current, phase: "ready", detail: undefined, activityTick: current.activityTick + 1 }));
      }
      return;
    }
    if (command.type === "sessions") {
      await handleSessionsCommand(runtime, setSessionsBrowser, (line) => append(line));
      return;
    }
    if (command.type === "login") {
      setSessionsBrowser(undefined);
      setLoginFormState(createLoginFormState(runtime.envPath));
      append(systemLine("Opening provider login. Use ↑/↓ to choose, Enter to continue/save, Esc to cancel."));
      return;
    }
    if (command.type === "log") {
      await handleLogCommand(command, runtime, append);
      return;
    }
    if (command.type === "model") {
      setBusyState(true);
      setStatus((current) => ({ ...current, phase: "running", detail: "saving model settings", activityTick: current.activityTick + 1 }));
      try {
        const line = await handleModelCommand(command, runtime);
        setStatus((current) => ({
          ...current,
          phase: "ready",
          detail: undefined,
          metrics: { ...initialContextMetrics(runtime.engine.getModelSettings().model, runtime.engine.snapshot().messages, runtime.initialMetrics.toolCount), messageCount: runtime.engine.snapshot().messages },
          activityTick: current.activityTick + 1,
        }));
        append(line);
      } finally {
        setBusyState(false);
      }
      return;
    }

    if (text.trimStart().startsWith("/")) {
      append({ kind: "error", text: `Unknown or incomplete command: ${text.trim()}\nType /help for commands.` });
      return;
    }

    const promptPayload = buildPromptPayload(command.text, submitAttachments);
    if (promptPayload.blocks?.some((block) => block.type === "image") && !runtime.engine.canAcceptImageInput()) {
      append({ kind: "error", text: "Current model does not support image input; image attachments were not added to the conversation." });
      return;
    }
    append({ kind: "user", text });
    const abortController = new AbortController();
    activeAbortController.current = abortController;
    interruptArmed.current = false;
    setBusyState(true);
    setStatus((current) => ({
      ...current,
      phase: "running",
      detail: "working",
      usage: undefined,
      streamedOutputTokens: 0,
      inputTokenUpdatedAt: undefined,
      outputTokenUpdatedAt: undefined,
      retryCooldownUntil: undefined,
    }));
    try {
      for await (const event of runtime.engine.sendUserText(promptPayload.text, { abortSignal: abortController.signal, blocks: promptPayload.blocks, displayText: text })) {
        handleEvent(event);
      }
    } catch (error) {
      finalizeLiveLine(assistantLineId.current);
      finalizeThinkingLine();
      finalizeActiveToolLines();
      assistantLineId.current = undefined;
      finalizedThinkingLineId.current = undefined;
      append({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      if (activeAbortController.current === abortController) activeAbortController.current = undefined;
      interruptArmed.current = false;
      finalizeLiveLine(assistantLineId.current);
      finalizeThinkingLine();
      finalizeActiveToolLines();
      assistantLineId.current = undefined;
      finalizedThinkingLineId.current = undefined;
      setBusyState(false);
      setStatus((current) => ({
        ...current,
        phase: "ready",
        detail: undefined,
        inputTokenUpdatedAt: undefined,
        outputTokenUpdatedAt: undefined,
        retryCooldownUntil: undefined,
      }));
      if (!terminalFocusedRef.current) playReadySound();
      const queued = takeQueuedPromptState();
      if (queued !== undefined) {
        void submitLine(queued.text, queued.attachments);
      }
    }
  };

  useEffect(() => {
    setLines(initialLines(runtime, lineId));
    assistantLineId.current = undefined;
    thinkingLineId.current = undefined;
    finalizedThinkingLineId.current = undefined;
    toolLineIds.current.clear();
    clearPendingToolResultTimers();
    setStatus(initialStatus(runtime));
    setSessionsBrowser(undefined);
    setLoginFormState(undefined);
    setQueuedPromptState(undefined);
    setPromptState("", 0);
  }, [runtime]);

  const terminalSize = useTerminalSize();
  const width = terminalSize.columns;
  const inputLockedByQueue = busy && queuedInput !== undefined;
  const prompt = promptPrefix(busy);
  const promptDisplayText = input.length === 0 && promptPlaceholder ? promptPlaceholder : input;
  const promptDisplayCursor = input.length === 0 && promptPlaceholder ? promptPlaceholder.length : cursor;
  const slashCompletions = inputLockedByQueue || promptPlaceholder || loginForm ? [] : slashCommandCompletions(input, cursor);
  const visibleSlashCompletionCount = slashCompletions.length;
  const selectedSlashCompletionIndex = visibleSlashCompletionCount === 0
    ? 0
    : Math.min(slashCompletionIndex, visibleSlashCompletionCount - 1);
  if (selectedSlashCompletionIndex !== slashCompletionIndexRef.current) {
    slashCompletionIndexRef.current = selectedSlashCompletionIndex;
  }
  const promptHeight = promptTextView(promptDisplayText, promptDisplayCursor, width, prompt).length + slashCompletionViewHeight(slashCompletions) + (queuedInput !== undefined ? QUEUED_INPUT_RENDER_ROWS : 0) + (pasteStatus ? 1 : 0);
  const firstDynamicLineIndex = lines.findIndex((line) => lineNeedsDynamicRender(line, messageContentWidth(width)));
  const staticLines = firstDynamicLineIndex === -1 ? lines : lines.slice(0, firstDynamicLineIndex);
  const dynamicLines = firstDynamicLineIndex === -1 ? [] : lines.slice(firstDynamicLineIndex);
  const dynamicMarginOverhead = dynamicLines.reduce((sum, _, i) => {
    const blockIndex = staticLines.length + i;
    return sum + (blockIndex > 0 ? MESSAGE_BLOCK_SPACING_LINES : 0);
  }, 0);
  const statusRenderRows = STATUS_BAR_RENDER_ROWS + (backgroundTaskCount > 0 ? BACKGROUND_TASK_STATUS_RENDER_ROWS : 0);
  const sessionsBrowserHeight = sessionsBrowser ? sessionsBrowserViewHeight(sessionsBrowser) : 0;
  const loginFormHeight = loginForm ? loginFormViewHeight(loginForm) : 0;
  const liveViewportLines = Math.max(MIN_LIVE_VIEWPORT_LINES, terminalSize.rows - promptHeight - statusRenderRows - sessionsBrowserHeight - loginFormHeight - dynamicMarginOverhead - 1);

  useInput((value, key) => {
    if (isTerminalFocusInSequence(value)) {
      terminalFocusedRef.current = true;
      return;
    }
    if (isTerminalFocusOutSequence(value)) {
      terminalFocusedRef.current = false;
      return;
    }
    if (isRightClickPasteSequence(value)) {
      void handleClipboardPaste();
      return;
    }
    if (mouseScrollDirection(value) !== undefined) {
      return;
    }
    if (isPasteShortcut(value, key)) {
      void handleClipboardPaste();
      return;
    }
    if (key.ctrl && value === "c") {
      if (inputRef.current.length > 0) {
        setPromptState("", 0);
        return;
      }
      if (!exitOnNextEmptyCtrlCRef.current) {
        exitOnNextEmptyCtrlCRef.current = true;
        setPromptPlaceholder(EMPTY_CTRL_C_EXIT_PLACEHOLDER);
        resetSlashCompletionSelection();
        if (busyRef.current) {
          const controller = activeAbortController.current;
          if (controller && !controller.signal.aborted && !interruptArmed.current) {
            interruptArmed.current = true;
            controller.abort("Interrupted by Ctrl+C");
            setStatus((current) => ({ ...current, phase: "stopped", detail: "interrupt requested" }));
          }
        }
        return;
      }
      app.exit();
      return;
    }
    if (busyRef.current && queuedInputRef.current !== undefined) {
      if (key.escape) restoreQueuedPromptToEditor();
      return;
    }
    if (loginFormRef.current) {
      handleLoginFormInput(value, key, loginFormRef.current, setLoginFormState, runtime, append, setStatus);
      return;
    }
    if (sessionsBrowser) {
      if (key.escape) {
        setSessionsBrowser(undefined);
        return;
      }
      if (key.upArrow) {
        setSessionsBrowser((current) => current ? moveSessionsSelection(current, -1) : current);
        return;
      }
      if (key.downArrow) {
        setSessionsBrowser((current) => current ? moveSessionsSelection(current, 1) : current);
        return;
      }
      if (key.leftArrow || key.pageUp) {
        setSessionsBrowser((current) => current ? moveSessionsPage(current, -1) : current);
        return;
      }
      if (key.rightArrow || key.pageDown) {
        setSessionsBrowser((current) => current ? moveSessionsPage(current, 1) : current);
        return;
      }
      if (key.return) {
        const selected = sessionsBrowser.sessions[sessionAbsoluteIndex(sessionsBrowser)];
        if (selected) {
          setSessionsBrowser(undefined);
          void handleResumeCommand(selected.sessionId, runtime, (line) => append(line)).then((result) => {
            if (result) resumeSnapshot(result.snapshot, result.metrics);
          });
        }
        return;
      }
      if (key.delete || key.backspace || value.toLowerCase() === "d") {
        const selected = sessionsBrowser.sessions[sessionAbsoluteIndex(sessionsBrowser)];
        if (selected) {
          void handleDeleteSessionCommand(selected.sessionId, sessionsBrowser, runtime, setSessionsBrowser, (line) => append(line));
        }
        return;
      }
      return;
    }
    if (key.return) {
      const currentText = inputRef.current;
      const currentCursor = cursorRef.current;
      const completion = selectedSlashCommandCompletion(currentText, currentCursor, slashCompletionIndexRef.current);
      if (completion !== undefined && completion.kind === "command" && completion.arguments !== "none") {
        const nextText = `${completion.insertText} ${currentText.slice(currentCursor)}`;
        setPromptState(nextText, completion.insertText.length + 1);
        return;
      }
      if (currentText.trimEnd() === "/model" && completion?.kind !== "command") {
        void submitLine(currentText);
        return;
      }
      void submitLine(completion?.insertText ?? currentText);
      return;
    }
    if (key.backspace || key.delete) {
      const currentText = inputRef.current;
      const currentCursor = cursorRef.current;
      if (currentCursor > 0) {
        setPromptState(`${currentText.slice(0, currentCursor - 1)}${currentText.slice(currentCursor)}`, currentCursor - 1);
      }
      return;
    }
    if (key.leftArrow) {
      const completionCount = slashCompletionSelectableCount(inputRef.current, cursorRef.current);
      if (completionCount > SLASH_COMPLETION_PAGE_SIZE) {
        setSlashCompletionSelection((slashCompletionIndexRef.current + completionCount - SLASH_COMPLETION_PAGE_SIZE) % completionCount);
        return;
      }
      setPromptState(inputRef.current, cursorRef.current - 1);
      return;
    }
    if (key.rightArrow) {
      const completionCount = slashCompletionSelectableCount(inputRef.current, cursorRef.current);
      if (completionCount > SLASH_COMPLETION_PAGE_SIZE) {
        setSlashCompletionSelection((slashCompletionIndexRef.current + SLASH_COMPLETION_PAGE_SIZE) % completionCount);
        return;
      }
      setPromptState(inputRef.current, cursorRef.current + 1);
      return;
    }
    if (key.home) {
      setPromptState(inputRef.current, 0);
      return;
    }
    if (key.end) {
      setPromptState(inputRef.current, inputRef.current.length);
      return;
    }
    if (key.upArrow) {
      const completionCount = slashCompletionSelectableCount(inputRef.current, cursorRef.current);
      if (completionCount > 0) {
        setSlashCompletionSelection((slashCompletionIndexRef.current + completionCount - 1) % completionCount);
        return;
      }
      const next = Math.min(history.current.length - 1, (historyIndexRef.current ?? -1) + 1);
      if (next >= 0 && history.current[next] !== undefined) {
        setHistorySelection(next);
        setPromptState(history.current[next], history.current[next].length);
      }
      return;
    }
    if (key.downArrow) {
      const completionCount = slashCompletionSelectableCount(inputRef.current, cursorRef.current);
      if (completionCount > 0) {
        setSlashCompletionSelection((slashCompletionIndexRef.current + 1) % completionCount);
        return;
      }
      if (historyIndexRef.current === undefined) return;
      const next = historyIndexRef.current - 1;
      if (next < 0) {
        setHistorySelection(undefined);
        setPromptState("", 0);
      } else {
        const historyText = history.current[next] ?? "";
        setHistorySelection(next);
        setPromptState(historyText, historyText.length);
      }
      return;
    }
    if (key.tab) {
      const currentText = inputRef.current;
      const currentCursor = cursorRef.current;
      const completions = slashCommandCompletions(currentText, currentCursor);
      const completion = completions[Math.min(slashCompletionIndexRef.current, completions.length - 1)];
      if (completion !== undefined) {
        const nextText = `${completion.insertText}${currentText.slice(currentCursor)}`;
        setPromptState(nextText, completion.insertText.length);
      }
      return;
    }
    if (value && !key.ctrl && !key.meta) {
      insertAtCursor(value);
    }
  });

  return e(
    Box,
    { flexDirection: "column" },
    e(Static<UiLine>, { items: staticLines, children: (line, index) => e(MessageBlock, { key: line.id, line, width, blockIndex: index }) }),
    e(MessageList, { lines: dynamicLines, width, liveMaxLines: liveViewportLines, lineIndexOffset: staticLines.length, onMarkdownRenderComplete: markLineRendered }),
    sessionsBrowser ? e(SessionsBrowser, { state: sessionsBrowser, width }) : null,
    loginForm ? e(LoginFormView, { state: loginForm, width }) : null,
    e(StatusBar, { status, animationTick, width }),
    backgroundTaskCount > 0 ? e(BackgroundTaskStatusLine, { count: backgroundTaskCount, width }) : null,
    pasteStatus ? e(PasteStatusLine, { text: pasteStatus, width }) : null,
    queuedInput !== undefined ? e(QueuedInputLine, { text: queuedInput, width }) : null,
    e(PromptLine, { text: promptDisplayText, cursor: promptDisplayCursor, busy, locked: inputLockedByQueue, placeholder: input.length === 0 && promptPlaceholder !== undefined, width, prompt, slashCompletions, selectedSlashCompletionIndex, attachments }),
  );
}

const MessageList = React.memo(function MessageList(
  { lines, width, liveMaxLines, lineIndexOffset = 0, onMarkdownRenderComplete }:
  {
    lines: UiLine[];
    width: number;
    liveMaxLines?: number;
    lineIndexOffset?: number;
    onMarkdownRenderComplete?: (lineId: number, renderKey: string) => void;
  },
) {
  const contentWidth = messageContentWidth(width);
  const toolWidth = toolContentWidth(width);
  return e(
    Box,
    { flexDirection: "column" },
    ...lines.map((line, index) => e(MessageBlock, {
      key: line.id,
      line,
      width,
      blockIndex: lineIndexOffset + index,
      contentWidth,
      toolWidth,
      liveMaxLines,
      onMarkdownRenderComplete,
    })),
  );
});

function MessageBlock(
  { line, width, blockIndex, contentWidth, toolWidth, liveMaxLines, onMarkdownRenderComplete }:
  {
    line: UiLine;
    width: number;
    blockIndex: number;
    contentWidth?: number;
    toolWidth?: number;
    liveMaxLines?: number;
    onMarkdownRenderComplete?: (lineId: number, renderKey: string) => void;
  },
) {
  return e(
    Box,
    { flexDirection: "column", marginTop: blockIndex > 0 ? MESSAGE_BLOCK_SPACING_LINES : 0 },
    e(MessageLine, { line, width, contentWidth, toolWidth, liveMaxLines, onMarkdownRenderComplete }),
  );
}

function MessageLine(
  { line, width, contentWidth = messageContentWidth(width), toolWidth = toolContentWidth(width), liveMaxLines, onMarkdownRenderComplete }:
  {
    line: UiLine;
    width: number;
    contentWidth?: number;
    toolWidth?: number;
    liveMaxLines?: number;
    onMarkdownRenderComplete?: (lineId: number, renderKey: string) => void;
  },
) {
  if (line.previewStyle === "summary") {
    const useRoleMarker = summaryUsesRoleMarker(line);
    const summaryWidth = useRoleMarker ? contentWidth : toolWidth;
    const display = displayWindowForLine(line, summaryWidth, line.live ? liveMaxLines : undefined);
    return e(
      Box,
      { flexDirection: "row" },
      useRoleMarker ? e(Text, { color: markerColorForKind(line.kind) }, messageRoleMarker(line.kind)) : null,
      e(
        Box,
        { flexDirection: "column", width: summaryWidth },
        ...renderDisplayText(line, summaryWidth, display.maxLines, display.skipTop),
      ),
    );
  }
  const clipPendingMarkdown = !line.live && onMarkdownRenderComplete !== undefined && lineNeedsDynamicRender(line, contentWidth);
  const display = displayWindowForLine(line, contentWidth, line.live || clipPendingMarkdown ? liveMaxLines : undefined);
  return e(Box, { flexDirection: "row" },
    e(Text, { color: markerColorForKind(line.kind) }, messageRoleMarker(line.kind)),
    e(
      Box,
      { flexDirection: "column", width: contentWidth },
      ...renderDisplayText(line, contentWidth, display.maxLines, display.skipTop, onMarkdownRenderComplete),
    ),
  );
}

function displayWindowForLine(line: UiLine, width: number, maxLines: number | undefined): { maxLines?: number; skipTop: number } {
  if (maxLines === undefined) return { skipTop: 0 };
  const safeMaxLines = Math.max(1, maxLines);
  const lineCount = estimateRenderedLineCount(line, width);
  return {
    maxLines: safeMaxLines,
    skipTop: Math.max(0, lineCount - safeMaxLines),
  };
}

function estimateRenderedLineCount(line: UiLine, width: number): number {
  if (line.previewStyle === "summary") return renderSummaryLines(line, width).length;
  if (line.format === "ansi") return wrapAnsi(line.text, Math.max(10, width), { hard: true, trim: false }).split("\n").length;
  return estimateMarkdownLineCount(line.text, width);
}

function lineNeedsDynamicRender(line: UiLine, width: number): boolean {
  if (line.live || line.pendingReplacement) return true;
  if (line.previewStyle === "summary" || line.format === "ansi") return false;
  return line.renderedKey !== markdownRenderKey(line.text, line.kind, width);
}

function renderDisplayText(
  line: UiLine,
  width: number,
  maxLines?: number,
  skipTop = 0,
  onMarkdownRenderComplete?: (lineId: number, renderKey: string) => void,
): React.ReactNode[] {
  if (line.previewStyle === "summary") return renderSummaryBlock(line, width, maxLines, skipTop);
  if (line.format === "ansi") return renderAnsiBlock(line.text, width, maxLines, skipTop);
  const shouldAsyncRenderMarkdown = !line.live && onMarkdownRenderComplete !== undefined;
  return [e(MarkdownText, {
    key: `markdown-${line.id}`,
    text: line.text,
    kind: line.kind,
    width,
    maxLines,
    skipLines: skipTop,
    asyncRender: shouldAsyncRenderMarkdown,
    onRenderComplete: shouldAsyncRenderMarkdown ? (renderKey: string) => onMarkdownRenderComplete(line.id, renderKey) : undefined,
  })];
}

function renderSummaryLines(line: UiLine, width: number): string[] {
  const content = line.text;
  const detailWidth = Math.max(10, width - SUMMARY_BLOCK.detailIndent.length);
  const title = summaryTitle(line);
  const rawLines = content.replace(/\r\n/g, "\n").split("\n");
  const wrapped = rawLines.flatMap((rawLine, index) => {
    const lineWidth = index === 0 && !title ? width : detailWidth;
    return wrapAnsi(rawLine, Math.max(10, lineWidth), { hard: true, trim: false }).split("\n");
  });
  const maxLines = line.summaryMaxLines ?? SUMMARY_BLOCK.maxLines;
  const preview = [title, ...wrapped].filter((value) => stripAnsi(value).length > 0).slice(0, maxLines);
  if (wrapped.length + (title ? 1 : 0) > maxLines && preview.length > 0) {
    preview[preview.length - 1] = truncateAnsi(preview[preview.length - 1], Math.max(1, detailWidth - 1)) + "…";
  }
  return preview.length ? preview : [""];
}

function summaryTitle(line: UiLine): string {
  if (summaryUsesRoleMarker(line)) return "";
  const title = line.title ?? titleForKind(line.kind);
  if (!line.titleStatus) return title;
  return `${title} ${titleStatusMarker(line.titleStatus)}`;
}

function summaryUsesRoleMarker(line: UiLine): boolean {
  return line.previewStyle === "summary" && (line.kind === "system" || line.kind === "meta");
}

function titleStatusMarker(status: NonNullable<UiLine["titleStatus"]>): string {
  return status === "success" ? "✓" : "✗";
}

function titleStatusColor(status: NonNullable<UiLine["titleStatus"]>): string {
  return status === "success" ? "green" : "red";
}

function renderSummaryBlock(line: UiLine, width: number, maxLines?: number, skipTop = 0): React.ReactNode[] {
  const allPreviewLines = renderSummaryLines(line, width);
  const preview = clipStrings(allPreviewLines, maxLines, skipTop);
  return preview.map((previewLine, index) => {
    const sourceIndex = skipTop + index;
    const detail = sourceIndex > 0;
    const text = detail ? `${SUMMARY_BLOCK.detailIndent}${previewLine}` : previewLine;
    if (!detail && line.titleStatus) {
      const marker = titleStatusMarker(line.titleStatus);
      const markerSuffix = ` ${marker}`;
      const titleText = text.endsWith(markerSuffix) ? text.slice(0, -marker.length) : `${text} `;
      return e(
        Text,
        {
          key: `summary-${line.id}-${index}`,
          color: colorForKind(line.kind),
          bold: true,
        },
        titleText,
        e(Text, { color: titleStatusColor(line.titleStatus), bold: true }, marker),
      );
    }
    if (line.format === "ansi") {
      const baseStyle: AnsiStyle = detail
        ? { color: "gray", dimColor: true }
        : { color: colorForKind(line.kind), bold: true };
      return e(Text, { key: `summary-${line.id}-${index}` }, ...renderAnsiInline(text, baseStyle));
    }
    return e(
      Text,
      {
        key: `summary-${line.id}-${index}`,
        color: detail ? "gray" : colorForKind(line.kind),
        dimColor: detail,
        bold: !detail,
      },
      text,
    );
  });
}

function renderAnsiBlock(text: string, width: number, maxLines?: number, skipTop = 0): React.ReactNode[] {
  const lines = clipStrings(wrapAnsi(text, Math.max(10, width), { hard: true, trim: false }).split("\n"), maxLines, skipTop);
  return lines.map((line, index) => e(Text, { key: `ansi-${index}` }, ...renderAnsiInline(line)));
}

function clipStrings(lines: string[], maxLines: number | undefined, skipTop = 0): string[] {
  const start = Math.max(0, skipTop);
  if (maxLines === undefined) return lines.slice(start);
  if (maxLines <= 0) return [];
  return lines.slice(start, start + maxLines);
}
function renderAnsiInline(text: string, baseStyle: AnsiStyle = {}): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const pattern = /\x1b\[([0-9;]*)m/g;
  let lastIndex = 0;
  let style: AnsiStyle = { ...baseStyle };
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(e(Text, { key: `ansi-${nodes.length}`, ...style }, text.slice(lastIndex, match.index)));
    }
    style = nextAnsiStyle(style, match[1], baseStyle);
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) nodes.push(e(Text, { key: `ansi-${nodes.length}`, ...style }, text.slice(lastIndex)));
  return nodes.length ? nodes : [e(Text, { key: "ansi-empty", ...baseStyle }, "")];
}

interface AnsiStyle {
  color?: string;
  backgroundColor?: string;
  bold?: boolean;
  dimColor?: boolean;
  italic?: boolean;
  underline?: boolean;
}

function nextAnsiStyle(current: AnsiStyle, rawCodes: string | undefined, baseStyle: AnsiStyle = {}): AnsiStyle {
  const codes = rawCodes ? rawCodes.split(";").filter(Boolean).map((code) => Number(code)) : [0];
  let next = { ...current };
  for (let index = 0; index < codes.length; index += 1) {
    const code = codes[index] ?? 0;
    if (code === 0) next = { ...baseStyle };
    else if (code === 1) next.bold = true;
    else if (code === 2) next.dimColor = true;
    else if (code === 3) next.italic = true;
    else if (code === 4) next.underline = true;
    else if (code === 22) {
      next.bold = undefined;
      next.dimColor = undefined;
    } else if (code === 23) next.italic = undefined;
    else if (code === 24) next.underline = undefined;
    else if (code === 39) next.color = undefined;
    else if (code === 49) next.backgroundColor = undefined;
    else if (code >= 30 && code <= 37) next.color = ANSI_COLORS[code - 30];
    else if (code >= 90 && code <= 97) next.color = ANSI_BRIGHT_COLORS[code - 90];
    else if (code >= 40 && code <= 47) next.backgroundColor = ANSI_COLORS[code - 40];
    else if (code >= 100 && code <= 107) next.backgroundColor = ANSI_BRIGHT_COLORS[code - 100];
    else if (code === 38 || code === 48) {
      const isForeground = code === 38;
      const mode = codes[index + 1];
      if (mode === 5) {
        const color = xtermColor(codes[index + 2]);
        if (isForeground) next.color = color;
        else next.backgroundColor = color;
        index += 2;
      } else if (mode === 2) {
        const color = rgbColor(codes[index + 2], codes[index + 3], codes[index + 4]);
        if (isForeground) next.color = color;
        else next.backgroundColor = color;
        index += 4;
      }
    }
  }
  return next;
}

const ANSI_COLORS = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];
const ANSI_BRIGHT_COLORS = ["gray", "redBright", "greenBright", "yellowBright", "blueBright", "magentaBright", "cyanBright", "whiteBright"];

function xtermColor(value: number | undefined): string | undefined {
  if (value === undefined || Number.isNaN(value)) return undefined;
  if (value < 8) return ANSI_COLORS[value];
  if (value < 16) return ANSI_BRIGHT_COLORS[value - 8];
  return undefined;
}

function rgbColor(red: number | undefined, green: number | undefined, blue: number | undefined): string | undefined {
  if ([red, green, blue].some((value) => value === undefined || Number.isNaN(value))) return undefined;
  return `#${[red, green, blue].map((value) => Math.max(0, Math.min(255, value ?? 0)).toString(16).padStart(2, "0")).join("")}`;
}

function hasAnsi(text: string): boolean {
  return /\x1b\[[0-9;]*m/.test(text);
}

interface StatusSegment {
  text: string;
  color?: string;
  bold?: boolean;
}

function useAnimatedNumber(target: number | undefined): number | undefined {
  const [display, setDisplay] = useState<number | undefined>(target);
  const displayRef = useRef<number | undefined>(target);

  useEffect(() => {
    if (target === undefined) {
      displayRef.current = undefined;
      setDisplay(undefined);
      return undefined;
    }

    const current = displayRef.current;
    if (current === undefined || current === target) {
      displayRef.current = target;
      setDisplay(target);
      return undefined;
    }

    const from = current;
    const delta = target - from;
    const startedAt = Date.now();
    const durationMs = animatedNumberDurationMs(Math.abs(delta));
    const interval = setInterval(() => {
      const progress = Math.min(1, (Date.now() - startedAt) / durationMs);
      const eased = easeOutCubic(progress);
      const next = from + delta * eased;
      displayRef.current = progress >= 1 ? target : next;
      setDisplay(displayRef.current);
      if (progress >= 1) clearInterval(interval);
    }, ANIMATED_NUMBER_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [target]);

  return display;
}

function useMinimumDisplayValue<T>(target: T, minDurationMs: number): T {
  const [display, setDisplay] = useState<T>(target);
  const displayRef = useRef<T>(target);
  const displayedAtRef = useRef(Date.now());
  const pendingRef = useRef<T | undefined>(undefined);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = undefined;
    }

    if (Object.is(target, displayRef.current)) {
      pendingRef.current = undefined;
      return undefined;
    }

    const applyPending = () => {
      const next = pendingRef.current;
      if (next === undefined || Object.is(next, displayRef.current)) {
        pendingRef.current = undefined;
        return;
      }
      displayRef.current = next;
      displayedAtRef.current = Date.now();
      pendingRef.current = undefined;
      timerRef.current = undefined;
      setDisplay(next);
    };

    pendingRef.current = target;
    const elapsedMs = Date.now() - displayedAtRef.current;
    const remainingMs = minDurationMs - elapsedMs;
    if (remainingMs <= 0) {
      applyPending();
      return undefined;
    }

    timerRef.current = setTimeout(applyPending, remainingMs);
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = undefined;
      }
    };
  }, [target, minDurationMs]);

  return display;
}

function animatedNumberDurationMs(delta: number): number {
  if (!Number.isFinite(delta) || delta <= 0) return ANIMATED_NUMBER_MIN_DURATION_MS;
  const scaled = ANIMATED_NUMBER_MIN_DURATION_MS + Math.log10(delta + 1) * ANIMATED_NUMBER_DURATION_SCALE_MS;
  return Math.min(ANIMATED_NUMBER_MAX_DURATION_MS, Math.max(ANIMATED_NUMBER_MIN_DURATION_MS, scaled));
}

function easeOutCubic(progress: number): number {
  const clamped = Math.max(0, Math.min(1, progress));
  return 1 - Math.pow(1 - clamped, 3);
}

function StatusBar(
  { status, animationTick, width: terminalWidth }:
  { status: UiStatus; animationTick: number; width: number },
) {
  const width = statusBarWidth(terminalWidth);
  const inputTokens = useAnimatedNumber(statusInputTokens(status));
  const outputTokens = useAnimatedNumber(statusOutputTokens(status));
  const displayPhase = useMinimumDisplayValue(status.phase, STATUS_PHASE_MIN_DISPLAY_MS);
  const segments = fitStatusSegments(renderCompactStatusSegments(status, animationTick, width, inputTokens, outputTokens, displayPhase), width);
  return e(
    Box,
    { marginTop: 1, width, height: 1, overflow: "hidden" },
    ...segments.map((segment, index) => e(
      Text,
      { key: index, color: segment.color ?? "gray", bold: segment.bold ?? false },
      segment.text,
    )),
  );
}

function BackgroundTaskStatusLine(
  { count, width: terminalWidth }:
  { count: number; width: number },
) {
  const width = statusBarWidth(terminalWidth);
  const text = count <= 3 ? "◇".repeat(Math.max(0, count)) : `◇×${count}`;
  return e(
    Box,
    { width, height: 1, overflow: "hidden" },
    e(Text, { color: "yellow" }, fitToWidth(text, width)),
  );
}

function renderCompactStatusSegments(
  status: UiStatus,
  animationTick: number,
  width: number,
  inputTokens: number | undefined,
  outputTokens: number | undefined,
  displayPhase = status.phase,
): StatusSegment[] {
  const phase = displayPhase;
  const now = Date.now();
  const phaseText = phaseLabelForStatus(phase);
  const inputValue = compactNumber(inputTokens);
  const outputValue = compactNumber(outputTokens);
  const context = renderContextParts(status.metrics);
  const fixedText = [
    phaseText,
    `ctx ${context.used} / ${context.limit} (${context.percent})`,
    `↑ ${inputValue}`,
    `↓ ${outputValue}`,
  ].join(STATUS_SEPARATOR);
  const modelBudget = Math.max(4, width - fixedText.length - STATUS_SEPARATOR.length);
  const model = truncateMiddle(status.metrics?.model ?? "model?", Math.min(width >= 120 ? 26 : width >= 90 ? 20 : 14, modelBudget));
  const retryPending = retryCooldownActive(status, now);
  const outputPulseColor = tokenArrowColor(status.outputTokenUpdatedAt, now, "cyan");
  const outputPending = modelOutputPending(status, now);
  const tokenInputColor = retryPending ? "red" : tokenArrowColor(status.inputTokenUpdatedAt, now, "green");
  const tokenOutputColor = outputPulseColor;
  const outputLabelColor = outputPending && !slowBlinkVisible(animationTick) ? "gray" : tokenOutputColor;

  const segments: StatusSegment[] = [
    ...renderPhaseStatusSegments(phaseText, phase, animationTick),
    statusDividerSegment(),
    { text: model },
    statusDividerSegment(),
    statusLabelSegment("ctx"),
    { text: ` ${context.used} / ${context.limit}` },
    { text: ` (${context.percent})`, color: contextColor(status.metrics) },
    statusDividerSegment(),
    statusLabelSegment("↑", tokenInputColor),
    { text: ` ${inputValue}` },
    statusDividerSegment(),
    statusLabelSegment("↓", outputLabelColor),
    { text: ` ${outputValue}` },
  ];

  return segments;
}

function fitStatusSegments(segments: StatusSegment[], width: number): StatusSegment[] {
  const fitted: StatusSegment[] = [];
  let remaining = width;
  for (const segment of segments) {
    if (remaining <= 0) break;
    const textWidth = stripAnsi(segment.text).length;
    if (textWidth <= remaining) {
      fitted.push(segment);
      remaining -= textWidth;
      continue;
    }
    const text = fitToWidth(segment.text, remaining);
    if (text.length > 0) fitted.push({ ...segment, text });
    remaining = 0;
  }
  return fitted;
}

const SLASH_COMPLETION_PAGE_SIZE = 10;
const MODEL_REASONING_EFFORTS: ReasoningEffort[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
const MODEL_REASONING_CONTROL_CHOICES: ModelReasoningArgument[] = ["default", "off"];

interface SlashCommandCompletion {
  value: string;
  insertText: string;
  description: string;
  arguments: ReplCommandArgumentSpec;
  kind: "command" | "model" | "reasoning";
}

function slashCommandCompletions(text: string, cursor: number): SlashCommandCompletion[] {
  const safeCursor = Math.max(0, Math.min(cursor, text.length));
  const prefix = text.slice(0, safeCursor);
  if (!prefix.startsWith("/") || /\r|\n/.test(prefix)) return [];
  if (/^\s/.test(prefix) || text.slice(0, 1) !== "/") return [];

  const suffix = text.slice(safeCursor);
  if (/\S/.test(suffix)) return [];
  if (prefix.startsWith("/model") && (prefix.length === "/model".length || prefix["/model".length] === " ")) {
    return modelCommandCompletions(prefix);
  }
  if (prefix.length > 1 && !/^\/[\w-]*$/.test(prefix)) return [];

  const normalizedPrefix = prefix.toLowerCase();
  return replCommandDefinitions
    .flatMap((command) => [command.name, ...(command.aliases ?? [])].map((name) => ({ value: name, insertText: name, description: command.description, arguments: command.arguments, kind: "command" as const })))
    .filter((command) => command.value.toLowerCase().startsWith(normalizedPrefix));
}

function modelCommandCompletions(prefix: string): SlashCommandCompletion[] {
  const hasTrailingSpace = /\s$/.test(prefix);
  const tokens = prefix.trim().split(/\s+/).filter(Boolean);
  const argumentTokens = tokens.slice(1);
  if (!hasTrailingSpace && argumentTokens.length === 0 && !"/model".startsWith(prefix.toLowerCase())) return [];
  if (argumentTokens.length >= 2 && !hasTrailingSpace) {
    const current = argumentTokens[1] ?? "";
    return reasoningCompletions(argumentTokens[0] ?? "", current);
  }
  if (argumentTokens.length >= 2) return [];

  if (argumentTokens.length === 1 && hasTrailingSpace) {
    const first = argumentTokens[0] ?? "";
    return isModelReasoningArgument(first) ? [] : reasoningCompletions(first, "");
  }

  const current = argumentTokens[0] ?? "";
  const modelCompletions = availableModelIds()
    .filter((modelId) => modelId.toLowerCase().includes(current.toLowerCase()))
    .map((modelId) => modelCompletion(modelId));
  const reasoning = reasoningChoicesForModel(undefined)
    .filter((choice) => choice.startsWith(current.toLowerCase()))
    .map((choice) => reasoningCompletion("", choice));
  return [...modelCompletions, ...reasoning];
}

function modelCompletion(modelId: string): SlashCommandCompletion {
  const window = resolveContextWindowTokens(modelId);
  const metadata = window.model;
  const efforts = reasoningEffortsForModel(modelId);
  const details = [
    metadata?.provider,
    metadata?.reasoning ? (efforts?.length ? `reasoning: ${efforts.join("/")}` : "reasoning") : undefined,
    metadata?.imageInput ? "vision" : undefined,
    window.tokens ? `${formatCompactNumber(window.tokens)} ctx` : undefined,
  ].filter(Boolean).join(" · ");
  return {
    value: modelId,
    insertText: `/model ${modelId}`,
    description: details || "model id",
    arguments: "optional",
    kind: "model",
  };
}

function reasoningCompletions(modelId: string, current: string): SlashCommandCompletion[] {
  return reasoningChoicesForModel(modelId || undefined)
    .filter((choice) => choice.startsWith(current.toLowerCase()))
    .map((choice) => reasoningCompletion(modelId, choice));
}

function reasoningChoicesForModel(modelId: string | undefined): ModelReasoningArgument[] {
  if (!modelId) return [...MODEL_REASONING_EFFORTS, ...MODEL_REASONING_CONTROL_CHOICES];
  const efforts = reasoningEffortsForModel(modelId);
  if (!efforts) return MODEL_REASONING_CONTROL_CHOICES;
  return [...efforts, ...MODEL_REASONING_CONTROL_CHOICES];
}

function reasoningCompletion(modelId: string, choice: ModelReasoningArgument): SlashCommandCompletion {
  return {
    value: choice,
    insertText: modelId ? `/model ${modelId} ${choice}` : `/model ${choice}`,
    description: reasoningDescription(choice),
    arguments: "optional",
    kind: "reasoning",
  };
}

function availableModelIds(): string[] {
  const ids = loadModelCatalog().models.flatMap((model) => model.modelIds.length ? model.modelIds : [model.id]);
  return [...new Set(ids)].sort((left, right) => left.localeCompare(right));
}

function slashCompletionPageCount(completions: SlashCommandCompletion[]): number {
  return Math.max(1, Math.ceil(completions.length / SLASH_COMPLETION_PAGE_SIZE));
}

function slashCompletionPageStart(selectedIndex: number, completions: SlashCommandCompletion[]): number {
  const page = Math.floor(Math.max(0, selectedIndex) / SLASH_COMPLETION_PAGE_SIZE);
  return Math.min(page * SLASH_COMPLETION_PAGE_SIZE, Math.max(0, (slashCompletionPageCount(completions) - 1) * SLASH_COMPLETION_PAGE_SIZE));
}

function visibleSlashCompletions(completions: SlashCommandCompletion[], selectedIndex: number): SlashCommandCompletion[] {
  const start = slashCompletionPageStart(selectedIndex, completions);
  return completions.slice(start, start + SLASH_COMPLETION_PAGE_SIZE);
}

function slashCompletionViewHeight(completions: SlashCommandCompletion[]): number {
  if (completions.length === 0) return 0;
  return Math.min(completions.length, SLASH_COMPLETION_PAGE_SIZE) + 2;
}

function slashCompletionSelectableCount(text: string, cursor: number): number {
  return slashCommandCompletions(text, cursor).length;
}

function selectedSlashCommandCompletion(text: string, cursor: number, selectedIndex: number): SlashCommandCompletion | undefined {
  const completions = slashCommandCompletions(text, cursor);
  if (completions.length === 0) return undefined;
  return completions[Math.max(0, Math.min(selectedIndex, completions.length - 1))];
}

function PromptLine(
  { text, cursor, busy, locked, placeholder = false, width, prompt, slashCompletions, selectedSlashCompletionIndex, attachments }:
  { text: string; cursor: number; busy: boolean; locked: boolean; placeholder?: boolean; width: number; prompt: string; slashCompletions: SlashCommandCompletion[]; selectedSlashCompletionIndex: number; attachments: ClipboardAttachment[] },
) {
  const visualLines = promptTextView(text, cursor, width, prompt);
  const inputColor = placeholder ? "gray" : (!locked && isValidReplCommandLine(text) ? "cyan" : undefined);
  return e(
    Box,
    { flexDirection: "column" },
    ...visualLines.map((line, index) => e(
      Box,
      { key: `prompt-${index}`, height: 1, overflow: "hidden" },
      e(Text, { color: locked ? "gray" : "cyan" }, index === 0 ? prompt : " ".repeat(prompt.length)),
      ...renderPromptPart(line.before, inputColor, attachments, `prompt-${index}-before`),
      e(Text, { key: `prompt-${index}-cursor`, inverse: true, color: inputColor }, line.selected),
      ...renderPromptPart(line.after, inputColor, attachments, `prompt-${index}-after`),
    )),
    ...SlashCompletionLines({ completions: slashCompletions, width, prompt, selectedIndex: selectedSlashCompletionIndex }),
  );
}

function PasteStatusLine(
  { text, width: terminalWidth }:
  { text: string; width: number },
) {
  const width = statusBarWidth(terminalWidth);
  return e(
    Box,
    { width, height: 1, overflow: "hidden" },
    e(Text, { color: "yellow" }, fitToWidth(text, width)),
  );
}

function QueuedInputLine(
  { text, width: terminalWidth }:
  { text: string; width: number },
) {
  const width = statusBarWidth(terminalWidth);
  const preview = fitToWidth(`queued next: ${text.replace(/\s+/g, " ").trim()}  (Esc to edit)`, width);
  return e(
    Box,
    { width, height: 1, overflow: "hidden" },
    e(Text, { color: "yellow" }, preview),
  );
}

function renderPromptPart(text: string, color: string | undefined, attachments: ClipboardAttachment[], keyPrefix: string): React.ReactNode[] {
  if (!text) return [];
  const activeLabels = attachments.map((attachment) => attachment.label).filter((label) => text.includes(label));
  if (activeLabels.length === 0) return [e(Text, { key: `${keyPrefix}-plain`, color }, text)];
  const pattern = new RegExp(activeLabels.map(escapeRegExp).join("|"), "g");
  const nodes: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) nodes.push(e(Text, { key: `${keyPrefix}-plain-${nodes.length}`, color }, text.slice(lastIndex, match.index)));
    nodes.push(e(Text, { key: `${keyPrefix}-tag-${nodes.length}`, color: "black", backgroundColor: "cyan", bold: true }, match[0]));
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) nodes.push(e(Text, { key: `${keyPrefix}-plain-${nodes.length}`, color }, text.slice(lastIndex)));
  return nodes;
}

function SlashCompletionLines(
  { completions, width, prompt, selectedIndex }:
  { completions: SlashCommandCompletion[]; width: number; prompt: string; selectedIndex: number },
): React.ReactNode[] {
  if (completions.length === 0) return [];
  const pageStart = slashCompletionPageStart(selectedIndex, completions);
  const visibleCompletions = visibleSlashCompletions(completions, selectedIndex);
  const safeSelectedIndex = Math.max(0, Math.min(selectedIndex - pageStart, visibleCompletions.length - 1));
  const contentWidth = Math.max(20, width - prompt.length);
  const nameWidth = Math.min(32, Math.max(...visibleCompletions.map((completion) => completion.value.length)));
  const pageCount = slashCompletionPageCount(completions);
  const pageIndex = Math.floor(pageStart / SLASH_COMPLETION_PAGE_SIZE) + 1;
  const footer = pageCount > 1 ? "↑/↓ select · ←/→ page · Tab complete" : "↑/↓ select · Tab complete";
  const rows = visibleCompletions.map((completion, index) => {
    const selected = index === safeSelectedIndex;
    const numberPrefix = `${pageStart + index + 1}.`.padStart(String(completions.length).length + 1);
    const descriptionWidth = Math.max(0, contentWidth - numberPrefix.length - nameWidth - 4);
    const description = fitToWidth(completion.description, descriptionWidth);
    return e(
      Text,
      { key: `slash-completion-${completion.kind}-${completion.insertText}`, color: "white" },
      e(Text, {
        color: selected ? "black" : "white",
        backgroundColor: selected ? "cyan" : undefined,
      }, numberPrefix),
      e(Text, { color: "gray" }, " "),
      e(Text, { color: completion.kind === "reasoning" ? "magenta" : "cyan" }, completion.value.padEnd(nameWidth)),
      e(Text, { color: "gray" }, "  "),
      e(Text, { color: selected ? "white" : "gray" }, description),
    );
  });

  const title = pageCount > 1 ? `Completions (${completions.length}) page ${pageIndex}/${pageCount}` : `Completions (${completions.length})`;
  return [
    e(Text, { key: "slash-completion-header", color: "cyan", bold: true }, fitToWidth(title, contentWidth)),
    ...rows,
    e(Text, { key: "slash-completion-footer", color: "gray" }, fitToWidth(footer, contentWidth)),
  ].map((line, index) => e(
    Box,
    { key: `slash-completion-line-${index}`, height: 1, overflow: "hidden" },
    e(Text, { color: "gray" }, " ".repeat(prompt.length)),
    line,
  ));
}

async function handleModelCommand(
  command: Extract<ReturnType<typeof parseReplCommand>, { type: "model" }>,
  runtime: ReplRuntime,
): Promise<Omit<UiLine, "id">> {
  const current = runtime.engine.getModelSettings();
  const nextModel = command.model ?? current.model;
  const validationError = validateModelReasoningArgument(nextModel, command.reasoning);
  if (validationError) return { kind: "error", text: validationError };

  const reasoningUpdate = resolveModelReasoningUpdate(command.reasoning, current.reasoning, nextModel, command.model !== undefined);
  const changed = command.model !== undefined || command.reasoning !== undefined;
  if (changed) {
    runtime.engine.setModel(nextModel, reasoningUpdate.reasoning, reasoningUpdate.update);
    try {
      await persistModelCommandSettings(runtime, command, reasoningUpdate);
    } catch (error) {
      return { kind: "error", text: `Model settings changed for this session, but saving to ${runtime.envPath} failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  const settings = formatModelSettings(runtime.engine.getModelSettings(), runtime.defaultReasoning);
  return systemLine(changed ? `${settings}\nSaved to ${runtime.envPath}` : settings);
}

function resolveModelReasoningUpdate(
  value: ModelReasoningArgument | undefined,
  current: ReasoningConfig | null | undefined,
  modelId: string | undefined,
  modelChanged: boolean,
): { reasoning: ReasoningConfig | null | undefined; update: boolean } {
  if (value === "off") return { reasoning: null, update: true };
  if (value === "default") return { reasoning: undefined, update: true };
  if (value !== undefined) return { reasoning: { effort: value as ReasoningEffort }, update: true };
  if (modelChanged && current?.effort && !reasoningEffortsForModel(modelId)?.includes(current.effort)) {
    return { reasoning: undefined, update: true };
  }
  return { reasoning: current, update: false };
}

async function persistModelCommandSettings(
  runtime: ReplRuntime,
  command: Extract<ReturnType<typeof parseReplCommand>, { type: "model" }>,
  reasoningUpdate: { reasoning: ReasoningConfig | null | undefined; update: boolean },
): Promise<void> {
  const provider = currentModelProvider();
  const updates: Record<string, string | undefined> = {};
  if (command.model !== undefined) updates[modelEnvKeyForProvider(provider)] = command.model.trim() || undefined;
  if (command.reasoning !== undefined || reasoningUpdate.update) {
    updates.MODEL_REASONING_EFFORT = envValueForReasoning(reasoningUpdate.reasoning);
    updates.MODEL_REASONING_SUMMARY = undefined;
  }
  if (Object.keys(updates).length === 0) return;
  await writeEnvUpdates(runtime.envPath, updates);
  applyEnvUpdatesToProcess(updates);
  runtime.defaultReasoning = reasoningUpdate.update ? reasoningUpdate.reasoning : runtime.defaultReasoning;
}

function currentModelProvider(): LoginProviderName {
  return parseLoginProvider(process.env.MODEL_PROVIDER) ?? "openai";
}

function modelEnvKeyForProvider(provider: LoginProviderName): "OPENAI_MODEL" | "DEEPSEEK_MODEL" {
  return provider === "deepseek" ? "DEEPSEEK_MODEL" : "OPENAI_MODEL";
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
  const lines = [
    "Model settings:",
    `  Model: ${settings.model ?? "<provider default>"}`,
  ];
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

function reasoningDescription(choice: ModelReasoningArgument): string {
  if (choice === "default") return "use MODEL_REASONING_EFFORT / provider default";
  if (choice === "off") return "send no reasoning config";
  return `reasoning effort: ${choice}`;
}

async function handleLogCommand(
  command: Extract<ReturnType<typeof parseReplCommand>, { type: "log" }>,
  runtime: ReplRuntime,
  append: (line: Omit<UiLine, "id">) => number,
) {
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

function renderMessage(
  message: Message,
  append: (line: Omit<UiLine, "id">) => number,
  activeAssistantId?: number,
  options: { includeToolUseBlocks?: boolean } = {},
): boolean {
  if (message.metadata?.syntheticToolUse === true) return false;
  if (message.role === "progress" || message.isMeta) return false;
  if (message.role === "assistant" && activeAssistantId !== undefined && message.blocks.some((block) => block.type === "text")) {
    return true;
  }

  let rendered = false;
  for (const block of message.blocks) {
    if (block.type === "text") {
      const kind = kindForRole(message.role);
      if (kind === "meta") continue;
      if (kind === "system") append({ kind, title: titleForRole(message.role), text: block.text, previewStyle: "summary" });
      else append({ kind, text: block.text });
      rendered = true;
    }
    if (block.type === "image") {
      const kind = kindForRole(message.role);
      if (kind === "meta") continue;
      append({ kind, text: block.label ?? `[image ${block.mimeType}]` });
      rendered = true;
    }
    if (block.type === "thinking") {
      append(thinkingLine(block.text));
      rendered = true;
    }
    if (block.type === "tool_use" && options.includeToolUseBlocks) {
      append({ ...formatToolUse(block), live: false });
      rendered = true;
    }
    if (block.type === "tool_result") {
      append(formatToolResultLine(block.name, block.output, block.ok));
      rendered = true;
    }
  }
  return rendered;
}

function renderToolResultMessage(
  message: Message,
  append: (line: Omit<UiLine, "id">) => number,
  replaceLine: (id: number, patch: Partial<UiLine>) => void,
  activeToolLineIds: Map<string, number>,
  scheduleReplacement: (toolUseId: string, lineId: number, line: Omit<UiLine, "id">) => void,
): boolean {
  let rendered = false;
  for (const block of message.blocks) {
    if (block.type !== "tool_result") continue;
    const line = formatToolResultLine(block.name, block.output, block.ok);
    const id = activeToolLineIds.get(block.toolUseId);
    if (id === undefined) {
      append(line);
    } else {
      replaceLine(id, {
        kind: line.kind,
        title: toolTitle(block.name, "finished"),
        titleStatus: block.ok ? "success" : "failure",
        live: true,
        pendingReplacement: true,
      });
      activeToolLineIds.delete(block.toolUseId);
      scheduleReplacement(block.toolUseId, id, line);
    }
    rendered = true;
  }
  return rendered;
}

function assistantText(message: Message): string | undefined {
  const text = message.blocks
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  return text.length > 0 ? text : undefined;
}

function thinkingText(message: Message): string | undefined {
  const text = message.blocks
    .filter((block) => block.type === "thinking")
    .map((block) => block.text)
    .join("");
  return text.length > 0 ? text : undefined;
}

function reduceStatus(status: UiStatus, event: AgentEvent): UiStatus {
  if (event.type === "state") {
    return {
      ...status,
      phase: event.phase,
      detail: event.detail,
      usage: event.phase === "preparing" ? undefined : status.usage,
      streamedOutputTokens: event.phase === "preparing" ? 0 : status.streamedOutputTokens,
      inputTokenUpdatedAt: event.phase === "preparing" ? undefined : status.inputTokenUpdatedAt,
      outputTokenUpdatedAt: event.phase === "preparing" ? undefined : status.outputTokenUpdatedAt,
      retryCooldownUntil: event.phase === "preparing" ? undefined : status.retryCooldownUntil,
      activityTick: status.activityTick + 1,
    };
  }
  if (event.type === "context.metrics") {
    return {
      ...status,
      metrics: event.metrics,
      inputTokenUpdatedAt: event.metrics.estimatedInputTokens !== status.metrics?.estimatedInputTokens ? Date.now() : status.inputTokenUpdatedAt,
      activityTick: status.activityTick + 1,
    };
  }
  if (event.type === "usage") {
    return {
      ...status,
      usage: event.usage,
      inputTokenUpdatedAt: event.usage.inputTokens !== undefined ? Date.now() : status.inputTokenUpdatedAt,
      outputTokenUpdatedAt: event.usage.outputTokens !== undefined ? Date.now() : status.outputTokenUpdatedAt,
      activityTick: status.activityTick + 1,
    };
  }
  if (event.type === "assistant.delta") {
    return {
      ...status,
      phase: "calling_model",
      streamedOutputTokens: status.streamedOutputTokens + estimateTokens(event.text),
      outputTokenUpdatedAt: Date.now(),
      activityTick: status.activityTick + 1,
    };
  }
  if (event.type === "thinking.delta") {
    return {
      ...status,
      phase: "thinking",
      streamedOutputTokens: status.streamedOutputTokens + estimateTokens(event.text),
      outputTokenUpdatedAt: Date.now(),
      activityTick: status.activityTick + 1,
    };
  }
  if (event.type === "tool_call.delta") {
    return {
      ...status,
      phase: "calling_model",
      streamedOutputTokens: status.streamedOutputTokens + estimateTokens(event.argumentsDelta),
      outputTokenUpdatedAt: Date.now(),
      activityTick: status.activityTick + 1,
    };
  }
  if (event.type === "retrying") {
    return {
      ...status,
      phase: "calling_model",
      detail: `retrying in ${(event.delayMs / 1000).toFixed(1)}s`,
      retryCooldownUntil: Date.now() + event.delayMs,
      activityTick: status.activityTick + 1,
    };
  }
  if (event.type === "terminal") {
    return {
      ...status,
      phase: "stopped",
      detail: event.reason,
      inputTokenUpdatedAt: undefined,
      outputTokenUpdatedAt: undefined,
      retryCooldownUntil: undefined,
      activityTick: status.activityTick + 1,
    };
  }
  if (event.type === "message" || event.type === "tool.started" || event.type === "tool.finished" || event.type === "error") {
    return { ...status, activityTick: status.activityTick + 1 };
  }
  return status;
}

async function handleSessionsCommand(
  runtime: ReplRuntime,
  setBrowser: (state: SessionsBrowserState | undefined) => void,
  append: (line: Omit<UiLine, "id">) => number,
) {
  const sessions = await runtime.engine.listSessions(Number.POSITIVE_INFINITY);
  if (sessions.length === 0) {
    setBrowser(undefined);
    append(systemLine("No saved sessions found."));
    return;
  }
  setBrowser({ sessions, pageSize: SESSIONS_DEFAULT_PAGE_SIZE, pageIndex: 0, selectedIndex: 0 });
}

async function handleExportCommand(
  command: Extract<ReturnType<typeof parseReplCommand>, { type: "export" }>,
  runtime: ReplRuntime,
): Promise<Omit<UiLine, "id">> {
  const snapshot = runtime.engine.snapshot();
  if (!snapshot.session) throw new Error("session transcripts are disabled; cannot export current session");
  const promptSnapshot = await runtime.engine.promptExportSnapshot();
  const result = await writeSessionMarkdownExport({
    outputPath: command.path,
    session: snapshot.session,
    agentId: snapshot.agentId,
    promptSnapshot,
    engineSnapshot: { ...snapshot, communicationLog: runtime.communicationLogger.snapshot(), usage: runtime.usage.snapshot() },
  });
  return systemLine(`Exported current session to ${result.outputPath}\nEntries: ${result.entries}\nMessages: ${result.messages}\nBytes: ${result.bytes}`);
}

async function handleResumeCommand(
  sessionId: string | undefined,
  runtime: ReplRuntime,
  append: (line: Omit<UiLine, "id">) => number,
): Promise<{ snapshot: SessionStoreSnapshot; metrics: ContextMetrics } | undefined> {
  try {
    const snapshot = await runtime.engine.resumeSession(sessionId);
    const metrics = await runtime.engine.contextMetrics();
    return { snapshot, metrics };
  } catch (error) {
    append({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    return undefined;
  }
}

async function handleDeleteSessionCommand(
  sessionId: string,
  current: SessionsBrowserState,
  runtime: ReplRuntime,
  setBrowser: (state: SessionsBrowserState | undefined) => void,
  append: (line: Omit<UiLine, "id">) => number,
): Promise<void> {
  try {
    const deleted = await runtime.engine.deleteSession(sessionId);
    if (!deleted) {
      append({ kind: "error", text: `session not found: ${sessionId}` });
      return;
    }
    const nextSessions = current.sessions.filter((session) => session.sessionId !== sessionId);
    if (nextSessions.length === 0) {
      setBrowser(undefined);
    } else {
      const pageCount = Math.max(1, Math.ceil(nextSessions.length / current.pageSize));
      const pageIndex = Math.min(current.pageIndex, pageCount - 1);
      const pageLength = nextSessions.slice(pageIndex * current.pageSize, pageIndex * current.pageSize + current.pageSize).length;
      setBrowser({
        ...current,
        sessions: nextSessions,
        pageIndex,
        selectedIndex: Math.min(current.selectedIndex, Math.max(0, pageLength - 1)),
      });
    }
    append(systemLine(`deleted session ${sessionId}`));
  } catch (error) {
    append({ kind: "error", text: error instanceof Error ? error.message : String(error) });
  }
}

function initialLines(runtime: ReplRuntime, lineId: { current: number }): UiLine[] {
  const session = runtime.engine.snapshot().session;
  const suffix = session
    ? ` Session: ${session.sessionId}${session.resumedMessages > 0 ? ` (${session.resumedMessages} resumed messages)` : ""}.`
    : "";
  const lines: UiLine[] = [
    { id: 0, kind: "system", title: "System", text: `Interactive UI enabled. Type /help for commands.${suffix}`, previewStyle: "summary" },
  ];
  lineId.current = 0;
  if (runtime.envNotice) lines.push({ id: ++lineId.current, kind: "system", title: "Config", text: runtime.envNotice, previewStyle: "summary" });
  for (const line of restoredHistoryLines(runtime)) lines.push({ id: ++lineId.current, ...line });
  return lines;
}

function resetLinesToHistory(runtime: ReplRuntime, setLines: (lines: UiLine[]) => void, lineId: { current: number }): void {
  setLines(initialLines(runtime, lineId));
}

function restoredHistoryLines(runtime: ReplRuntime): Omit<UiLine, "id">[] {
  const lines: Omit<UiLine, "id">[] = [];
  const append = (line: Omit<UiLine, "id">) => {
    lines.push(line);
    return lines.length;
  };
  for (const message of runtime.engine.getHistoryMessages()) {
    renderMessage(message, append, undefined, { includeToolUseBlocks: true });
  }
  return lines;
}

const LOGIN_PROVIDERS: LoginProviderName[] = ["openai", "deepseek"];

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
};

const DEPRECATED_MODEL_ENV_KEYS = [
  "MODEL_API_KEY",
  "MODEL_BASE_URL",
  "MODEL_ID",
  "MODEL_FALLBACK_ID",
  "MODEL_ENDPOINT",
  "OPENAI_PROVIDER",
  "OPENAI_REASONING_EFFORT",
  "OPENAI_REASONING_SUMMARY",
  "OPENAI_MAX_OUTPUT_TOKENS",
  "OPENAI_TIMEOUT_MS",
  "OPENAI_STREAM_IDLE_TIMEOUT_MS",
  "OPENAI_MAX_RETRIES",
  "DEEPSEEK_REASONING_EFFORT",
  "DEEPSEEK_REASONING_SUMMARY",
  "DEEPSEEK_MAX_OUTPUT_TOKENS",
  "DEEPSEEK_TIMEOUT_MS",
  "DEEPSEEK_STREAM_IDLE_TIMEOUT_MS",
  "DEEPSEEK_MAX_RETRIES",
];

function sessionsPageCount(state: SessionsBrowserState): number {
  return Math.max(1, Math.ceil(state.sessions.length / state.pageSize));
}

function sessionsPageItems(state: SessionsBrowserState): SessionSummary[] {
  const start = state.pageIndex * state.pageSize;
  return state.sessions.slice(start, start + state.pageSize);
}

function sessionAbsoluteIndex(state: SessionsBrowserState): number {
  return state.pageIndex * state.pageSize + state.selectedIndex;
}

function moveSessionsSelection(state: SessionsBrowserState, delta: number): SessionsBrowserState {
  const pageLength = sessionsPageItems(state).length;
  if (pageLength <= 0) return state;
  const selectedIndex = (state.selectedIndex + delta + pageLength) % pageLength;
  return { ...state, selectedIndex };
}

function moveSessionsPage(state: SessionsBrowserState, delta: number): SessionsBrowserState {
  const pageCount = sessionsPageCount(state);
  if (pageCount <= 1) return state;
  const pageIndex = (state.pageIndex + delta + pageCount) % pageCount;
  const pageLength = state.sessions.slice(pageIndex * state.pageSize, pageIndex * state.pageSize + state.pageSize).length;
  return { ...state, pageIndex, selectedIndex: Math.min(state.selectedIndex, Math.max(0, pageLength - 1)) };
}

function sessionsBrowserViewHeight(state: SessionsBrowserState): number {
  return sessionsPageItems(state).length + 3;
}

function SessionsBrowser({ state, width }: { state: SessionsBrowserState; width: number }) {
  const pageCount = sessionsPageCount(state);
  const pageItems = sessionsPageItems(state);
  const showPagination = pageCount > 1;
  const contentWidth = Math.max(20, width);
  const header = showPagination
    ? `Saved sessions (${state.sessions.length}) · page ${state.pageIndex + 1}/${pageCount}`
    : `Saved sessions (${state.sessions.length})`;
  const footer = showPagination
    ? "↑/↓ select · ←/→ page · Enter resume · d/Delete remove · Esc close"
    : "↑/↓ select · Enter resume · d/Delete remove · Esc close";

  return e(
    Box,
    { flexDirection: "column", marginTop: 1 },
    e(Text, { color: "cyan", bold: true }, fitToWidth(header, contentWidth)),
    ...pageItems.map((session, index) => {
      const selected = index === state.selectedIndex;
      const absoluteIndex = state.pageIndex * state.pageSize + index;
      const row = formatSessionBrowserRow(session, absoluteIndex, contentWidth);
      return e(
        Text,
        { key: session.sessionId, color: "white" },
        e(Text, {
          color: selected ? "black" : "white",
          backgroundColor: selected ? "cyan" : undefined,
        }, row.numberPrefix),
        row.rest,
      );
    }),
    e(Text, { color: "gray" }, fitToWidth(footer, contentWidth)),
  );
}

function handleLoginFormInput(
  value: string,
  key: { upArrow?: boolean; downArrow?: boolean; leftArrow?: boolean; rightArrow?: boolean; return?: boolean; escape?: boolean; tab?: boolean; backspace?: boolean; delete?: boolean; ctrl?: boolean; meta?: boolean },
  state: LoginFormState,
  setLoginFormState: (next: LoginFormState | undefined) => void,
  runtime: ReplRuntime,
  append: (line: Omit<UiLine, "id">) => number,
  setStatus: React.Dispatch<React.SetStateAction<UiStatus>>,
): void {
  if (key.escape) {
    if (state.step === "fields") setLoginFormState({ ...state, step: "provider" });
    else {
      setLoginFormState(undefined);
      append(systemLine("Login cancelled."));
    }
    return;
  }

  if (state.step === "provider") {
    if (key.upArrow) {
      setLoginFormState(moveLoginProviderSelection(state, -1));
      return;
    }
    if (key.downArrow) {
      setLoginFormState(moveLoginProviderSelection(state, 1));
      return;
    }
    if (key.return) {
      const provider = state.providers[state.selectedProviderIndex] ?? state.provider;
      setLoginFormState({ ...loginFormForProvider(provider, state.envPath), step: "fields" });
      return;
    }
    return;
  }

  const fields = LOGIN_FIELD_DEFINITIONS[state.provider];
  const field = fields[state.selectedFieldIndex];
  if (!field) return;

  if (key.upArrow) {
    setLoginFormState(moveLoginFieldSelection(state, -1));
    return;
  }
  if (key.downArrow) {
    setLoginFormState(moveLoginFieldSelection(state, 1));
    return;
  }
  if (key.leftArrow) {
    setLoginFormState({ ...state, cursor: Math.max(0, state.cursor - 1) });
    return;
  }
  if (key.rightArrow) {
    const current = state.values[field.key] ?? "";
    setLoginFormState({ ...state, cursor: Math.min(current.length, state.cursor + 1) });
    return;
  }
  if (key.tab && field.options?.length) {
    setLoginFormState(cycleLoginFieldOption(state, field));
    return;
  }
  if (key.backspace || key.delete) {
    setLoginFormState(deleteLoginFieldCharacter(state, field));
    return;
  }
  if (key.return) {
    void submitLoginForm(state, runtime, append, setLoginFormState, setStatus);
    return;
  }
  if (value && !key.ctrl && !key.meta) {
    setLoginFormState(insertLoginFieldText(state, field, value));
  }
}

function moveLoginProviderSelection(state: LoginFormState, delta: number): LoginFormState {
  const selectedProviderIndex = (state.selectedProviderIndex + delta + state.providers.length) % state.providers.length;
  return { ...state, selectedProviderIndex, provider: state.providers[selectedProviderIndex] ?? state.provider };
}

function moveLoginFieldSelection(state: LoginFormState, delta: number): LoginFormState {
  const fields = LOGIN_FIELD_DEFINITIONS[state.provider];
  const selectedFieldIndex = (state.selectedFieldIndex + delta + fields.length) % fields.length;
  const field = fields[selectedFieldIndex];
  return { ...state, selectedFieldIndex, cursor: field ? (state.values[field.key] ?? "").length : 0 };
}

function cycleLoginFieldOption(state: LoginFormState, field: LoginFieldDefinition): LoginFormState {
  const options = field.options ?? [];
  const current = state.values[field.key] ?? "";
  const index = options.indexOf(current);
  const next = options[(index + 1 + options.length) % options.length] ?? "";
  return { ...state, values: { ...state.values, [field.key]: next }, cursor: next.length };
}

function insertLoginFieldText(state: LoginFormState, field: LoginFieldDefinition, value: string): LoginFormState {
  const current = state.values[field.key] ?? "";
  const cursor = Math.max(0, Math.min(state.cursor, current.length));
  const next = `${current.slice(0, cursor)}${value}${current.slice(cursor)}`;
  return { ...state, values: { ...state.values, [field.key]: next }, cursor: cursor + value.length };
}

function deleteLoginFieldCharacter(state: LoginFormState, field: LoginFieldDefinition): LoginFormState {
  const current = state.values[field.key] ?? "";
  const cursor = Math.max(0, Math.min(state.cursor, current.length));
  if (cursor <= 0) return state;
  const next = `${current.slice(0, cursor - 1)}${current.slice(cursor)}`;
  return { ...state, values: { ...state.values, [field.key]: next }, cursor: cursor - 1 };
}

async function submitLoginForm(
  state: LoginFormState,
  runtime: ReplRuntime,
  append: (line: Omit<UiLine, "id">) => number,
  setLoginFormState: (next: LoginFormState | undefined) => void,
  setStatus: React.Dispatch<React.SetStateAction<UiStatus>>,
): Promise<void> {
  const validationError = validateLoginForm(state);
  if (validationError) {
    append({ kind: "error", text: validationError });
    return;
  }

  try {
    await saveLoginFormToEnv(state);
    applyLoginFormToProcessEnv(state);
    const config = readModelProviderConfig(process.env);
    if (!config) throw new Error("Saved provider config could not be loaded from environment.");
    const innerGateway = createModelGatewayFromConfig(config);
    runtime.modelGateway.setInner(innerGateway);
    runtime.agentRuntime.modelGateway = runtime.modelGateway;
    runtime.engine.setModelProvider({
      modelGateway: runtime.modelGateway,
      model: config.model,
      fallbackModel: config.fallbackModel,
      reasoning: config.defaultReasoning,
    });
    runtime.defaultReasoning = config.defaultReasoning;
    setStatus((current) => ({
      ...current,
      metrics: { ...initialContextMetrics(config.model, runtime.engine.snapshot().messages, runtime.initialMetrics.toolCount), messageCount: runtime.engine.snapshot().messages },
    }));
    setLoginFormState(undefined);
    append(systemLine(`Saved ${state.provider} login to ${state.envPath}\n${formatModelSettings(runtime.engine.getModelSettings(), runtime.defaultReasoning)}`, EXPANDED_SUMMARY_MAX_LINES));
  } catch (error) {
    append({ kind: "error", text: `Login save failed: ${error instanceof Error ? error.message : String(error)}` });
  }
}

function validateLoginForm(state: LoginFormState): string | undefined {
  for (const field of LOGIN_FIELD_DEFINITIONS[state.provider]) {
    const value = (state.values[field.key] ?? "").trim();
    if (field.required && !value) return `${field.label} is required.`;
    if (field.options?.length && value && !field.options.includes(value)) return `${field.label} must be one of: ${field.options.filter(Boolean).join(", ")}`;
  }
  for (const fieldKey of ["maxOutputTokens", "timeoutMs", "streamIdleTimeoutMs", "maxRetries"]) {
    const value = state.values[fieldKey]?.trim();
    if (value && !Number.isFinite(Number(value))) return `${fieldKey} must be a number.`;
  }
  return undefined;
}

function createLoginFormState(envPath = getUserDotEnvPath()): LoginFormState {
  const env = parseEnvFileSafe(envPath);
  const currentProvider = parseLoginProvider(env.MODEL_PROVIDER ?? process.env.MODEL_PROVIDER) ?? ((env.DEEPSEEK_API_KEY ?? process.env.DEEPSEEK_API_KEY) ? "deepseek" : "openai");
  return loginFormForProvider(currentProvider, envPath, env);
}

function loginFormForProvider(provider: LoginProviderName, envPath: string, env: Record<string, string> = parseEnvFileSafe(envPath)): LoginFormState {
  const selectedProviderIndex = Math.max(0, LOGIN_PROVIDERS.indexOf(provider));
  return {
    step: "provider",
    providers: LOGIN_PROVIDERS,
    selectedProviderIndex,
    provider,
    selectedFieldIndex: 0,
    cursor: 0,
    values: loginValuesForProvider(provider, env),
    envPath,
  };
}

function loginValuesForProvider(provider: LoginProviderName, env: Record<string, string>): Record<string, string> {
  const values: Record<string, string> = {};
  for (const field of LOGIN_FIELD_DEFINITIONS[provider]) {
    values[field.key] = env[field.envKey] ?? "";
  }
  if (!values.baseUrl) values.baseUrl = provider === "deepseek" ? "https://api.deepseek.com" : "https://api.openai.com";
  if (!values.model) values.model = provider === "deepseek" ? "deepseek-chat" : "gpt-5.5";
  if (provider === "openai" && !values.endpoint) values.endpoint = "auto";
  return values;
}

function parseLoginProvider(value: string | undefined): LoginProviderName | undefined {
  if (value === "openai" || value === "deepseek") return value;
  return undefined;
}

function loginFormViewHeight(state: LoginFormState): number {
  return state.step === "provider" ? state.providers.length + 3 : LOGIN_FIELD_DEFINITIONS[state.provider].length + 4;
}

function LoginFormView({ state, width }: { state: LoginFormState; width: number }) {
  const contentWidth = Math.max(30, width);
  if (state.step === "provider") {
    return e(
      Box,
      { flexDirection: "column", marginTop: 1 },
      e(Text, { color: "cyan", bold: true }, fitToWidth(`Login: choose provider · saving to ${state.envPath}`, contentWidth)),
      ...state.providers.map((provider, index) => e(
        Text,
        { key: provider, color: "white" },
        e(Text, { color: index === state.selectedProviderIndex ? "black" : "white", backgroundColor: index === state.selectedProviderIndex ? "cyan" : undefined }, `${index + 1}.`.padStart(3)),
        e(Text, { color: "gray" }, " "),
        e(Text, { color: "cyan" }, provider),
      )),
      e(Text, { color: "gray" }, fitToWidth("↑/↓ select · Enter edit config · Esc close", contentWidth)),
    );
  }

  const fields = LOGIN_FIELD_DEFINITIONS[state.provider];
  const maxLabel = Math.max(...fields.map((field) => field.label.length));
  return e(
    Box,
    { flexDirection: "column", marginTop: 1 },
    e(Text, { color: "cyan", bold: true }, fitToWidth(`Login: ${state.provider} · ${state.envPath}`, contentWidth)),
    ...fields.map((field, index) => {
      const selected = index === state.selectedFieldIndex;
      const rawValue = state.values[field.key] ?? "";
      const visibleValue = formatLoginFieldValue(field, rawValue, selected ? state.cursor : undefined);
      const placeholder = rawValue ? "" : (field.placeholder ? ` (${field.placeholder})` : "");
      return e(
        Text,
        { key: field.key, color: "white" },
        e(Text, { color: selected ? "black" : "white", backgroundColor: selected ? "cyan" : undefined }, `${index + 1}.`.padStart(3)),
        e(Text, { color: field.required ? "yellow" : "gray" }, ` ${field.label.padEnd(maxLabel)} `),
        e(Text, { color: field.scope === "shared" ? "blue" : "gray" }, field.scope === "shared" ? "shared " : "provider "),
        e(Text, { color: rawValue ? "white" : "gray" }, fitToWidth(`${visibleValue}${placeholder}`, Math.max(8, contentWidth - maxLabel - 14))),
      );
    }),
    e(Text, { color: "gray" }, fitToWidth("↑/↓ field · ←/→ cursor · type edit · Tab cycle choices · Enter save · Esc back/cancel", contentWidth)),
    e(Text, { color: "gray" }, fitToWidth("Provider fields save as OPENAI_* / DEEPSEEK_*; shared runtime fields save as MODEL_*.", contentWidth)),
  );
}

function formatLoginFieldValue(field: LoginFieldDefinition, value: string, cursor: number | undefined): string {
  const display = field.secret && value ? "•".repeat(Math.min(value.length, 24)) : value;
  if (cursor === undefined) return display;
  const safeCursor = Math.max(0, Math.min(cursor, display.length));
  const selected = display[safeCursor] ?? " ";
  return `${display.slice(0, safeCursor)}█${selected === " " ? "" : display.slice(safeCursor + 1)}`;
}

function applyLoginFormToProcessEnv(state: LoginFormState): void {
  applyEnvUpdatesToProcess(envEntriesForLoginForm(state));
  for (const key of DEPRECATED_MODEL_ENV_KEYS) delete process.env[key];
}

async function saveLoginFormToEnv(state: LoginFormState): Promise<void> {
  await writeEnvUpdates(state.envPath, envEntriesForLoginForm(state), DEPRECATED_MODEL_ENV_KEYS);
}

function envEntriesForLoginForm(state: LoginFormState): Record<string, string | undefined> {
  const entries: Record<string, string | undefined> = {
    MODEL_PROVIDER: state.provider,
  };
  for (const field of LOGIN_FIELD_DEFINITIONS[state.provider]) {
    const value = (state.values[field.key] ?? "").trim();
    entries[field.envKey] = value || undefined;
  }
  return entries;
}

function updateEnvContent(content: string, updates: Record<string, string | undefined>, removeKeys: string[] = []): string {
  const keys = new Set(Object.keys(updates));
  const removals = new Set(removeKeys);
  const seen = new Set<string>();
  const lines = content ? content.split(/\r?\n/) : [];
  const updatedLines = lines.map((line) => {
    const parsed = parseEnvLine(line);
    if (!parsed) return line;
    if (removals.has(parsed.key) && !keys.has(parsed.key)) return undefined;
    if (!keys.has(parsed.key)) return line;
    seen.add(parsed.key);
    const value = updates[parsed.key];
    if (value === undefined) return undefined;
    return `${parsed.key}=${quoteEnvValue(value)}`;
  }).filter((line): line is string => line !== undefined);

  const missing = Object.entries(updates).filter((entry): entry is [string, string] => !seen.has(entry[0]) && entry[1] !== undefined);
  if (missing.length > 0) {
    const grouped = groupLoginEnvEntries(missing);
    appendEnvGroup(updatedLines, "# Neo active provider", grouped.active);
    appendEnvGroup(updatedLines, "# OpenAI provider settings", grouped.openai);
    appendEnvGroup(updatedLines, "# DeepSeek provider settings", grouped.deepseek);
    appendEnvGroup(updatedLines, "# Shared model runtime settings", grouped.shared);
  }
  return `${updatedLines.join("\n").replace(/\n*$/u, "")}\n`;
}

function groupLoginEnvEntries(entries: Array<[string, string]>): Record<"active" | "openai" | "deepseek" | "shared", Array<[string, string]>> {
  return {
    active: entries.filter(([key]) => key === "MODEL_PROVIDER"),
    openai: entries.filter(([key]) => key.startsWith("OPENAI_")),
    deepseek: entries.filter(([key]) => key.startsWith("DEEPSEEK_")),
    shared: entries.filter(([key]) => key.startsWith("MODEL_") && key !== "MODEL_PROVIDER"),
  };
}

function appendEnvGroup(lines: string[], header: string, entries: Array<[string, string]>): void {
  if (entries.length === 0) return;
  if (lines.length > 0 && lines[lines.length - 1]?.trim()) lines.push("");
  lines.push(header);
  for (const [key, value] of entries) lines.push(`${key}=${quoteEnvValue(value)}`);
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

function parseEnvLine(line: string): { key: string; value: string } | undefined {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return undefined;
  const separator = trimmed.indexOf("=");
  if (separator <= 0) return undefined;
  const key = trimmed.slice(0, separator).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return undefined;
  return { key, value: trimmed.slice(separator + 1) };
}

function quoteEnvValue(value: string): string {
  if (/^[A-Za-z0-9_./:@+-]*$/.test(value)) return value;
  return JSON.stringify(value);
}

function stripEnvQuotes(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1);
  return value;
}

function formatSessionBrowserRow(session: SessionSummary, absoluteIndex: number, width: number): { numberPrefix: string; rest: string } {
  const numberPrefix = `${absoluteIndex + 1}.`.padStart(4);
  const title = session.title?.trim() || "(untitled)";
  const updated = session.updatedAt ? ` · ${formatSessionTimestamp(session.updatedAt)}` : "";
  const messages = ` · ${session.messages} messages`;
  const fixedParts = `${numberPrefix} ${updated}${messages}`;
  const idBudget = Math.max(12, Math.min(32, Math.floor(width * 0.28)));
  const id = truncateMiddle(session.sessionId, idBudget);
  const titleBudget = Math.max(8, width - fixedParts.length - id.length - 5);
  const row = fitToWidth(`${numberPrefix} ${truncateMiddle(title, titleBudget)} · ${id}${updated}${messages}`, width);
  return { numberPrefix, rest: row.slice(numberPrefix.length) };
}

function formatSessionTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "Z");
}

function formatResume(snapshot: SessionStoreSnapshot): string {
  return `resumed session ${snapshot.sessionId}: ${snapshot.resumedMessages} messages from ${snapshot.transcriptPath}`;
}

function formatUsageTotals(totals: UsageTotals): string {
  if (totals.requests === 0) return "No token usage recorded for this REPL session yet.";

  const totalLabel = totals.computedTotalTokens ? "Total tokens (computed)" : "Total tokens";
  const lines = [
    "Session token usage:",
    `  ${totalLabel}: ${formatNumber(totals.totalTokens)}`,
    `  Input tokens: ${formatNumber(totals.inputTokens)}`,
    `  Output tokens: ${formatNumber(totals.outputTokens)}`,
    `  Model requests: ${formatNumber(totals.requests)}`,
  ];

  if (totals.reasoningTokens > 0) lines.push(`  Reasoning tokens: ${formatNumber(totals.reasoningTokens)}`);
  if (totals.cachedTokens > 0) lines.push(`  Cached input tokens: ${formatNumber(totals.cachedTokens)}`);

  return lines.join("\n");
}

function formatManualCompaction(result: CompactionResult): string {
  if (!result.changed) return "No earlier context available to compact.";
  return `manual context compacted: ${result.messages.length} messages retained, ${formatNumber(result.tokensFreed ?? 0)} chars freed`;
}

function formatPureCompaction(result: CompactionResult): string {
  if (!result.changed) return "No context available to purify.";
  return `pure context compacted: ${result.messages.length} sanitized message(s) retained, ${formatNumber(result.tokensFreed ?? 0)} chars removed; raw command/log/code details omitted`;
}

function colorForKind(kind: UiLine["kind"]) {
  if (kind === "user") return "cyan";
  if (kind === "assistant") return "green";
  if (kind === "thinking") return THINKING_COLOR;
  if (kind === "tool") return "#d4b04c";
  if (kind === "error") return "red";
  if (kind === "meta") return "gray";
  return "white";
}

function markerColorForKind(kind: UiLine["kind"]) {
  if (kind === "thinking") return THINKING_COLOR;
  return colorForKind(kind);
}

function messageRoleMarker(kind?: UiLine["kind"]): string {
  if (kind === "thinking") return `${THINKING_MARKER} `;
  return "● ";
}

function kindForRole(role: Message["role"]): UiLine["kind"] {
  if (role === "user") return "user";
  if (role === "assistant") return "assistant";
  if (role === "tool_result") return "tool";
  if (role === "progress") return "meta";
  if (role === "system") return "meta";
  return "system";
}

function titleForKind(kind: UiLine["kind"]): string {
  if (kind === "thinking") return `${THINKING_MARKER} Think`;
  if (kind === "tool") return "Tool";
  if (kind === "error") return "Error";
  if (kind === "meta") return "Meta";
  if (kind === "system") return "System";
  if (kind === "user") return "User";
  return "Assistant";
}

function titleForRole(role: Message["role"]): string {
  if (role === "progress") return "Meta";
  if (role === "system") return "System";
  if (role === "tool_result") return "Tool result";
  return titleForKind(kindForRole(role));
}

function systemLine(text: string, summaryMaxLines?: number): Omit<UiLine, "id"> {
  return {
    kind: "system",
    title: "System",
    text,
    previewStyle: "summary",
    summaryMaxLines,
  };
}

function thinkingLine(text: string, live = false): Omit<UiLine, "id"> {
  return {
    kind: "thinking",
    title: titleForKind("thinking"),
    text,
    previewStyle: "summary",
    summaryMaxLines: THINKING_SUMMARY_MAX_LINES,
    live,
  };
}

function metaLine(text: string): Omit<UiLine, "id"> {
  return {
    kind: "meta",
    title: "Meta",
    text,
    previewStyle: "summary",
  };
}

function formatToolUse(toolUse: ToolUseRequest): Omit<UiLine, "id"> {
  if (toolUse.name === "plan" && isPlanToolPayload(toolUse.input)) {
    return {
      kind: "tool",
      title: toolTitle(toolUse.name, "running"),
      text: formatPlanToolPayload(toolUse.input),
    };
  }

  return {
    kind: "tool",
    title: toolTitle(toolUse.name, "running"),
    text: formatJson(toolUse.input, 1200),
    previewStyle: "summary",
  };
}

function formatToolResultLine(toolName: string, output: unknown, ok: boolean): Omit<UiLine, "id"> {
  const formatted = formatToolResult(toolName, output, ok);
  const line: Omit<UiLine, "id"> = {
    kind: ok ? "tool" : "error",
    title: toolTitle(toolName, "finished"),
    titleStatus: ok ? "success" : "failure",
    text: formatted.text,
    format: formatted.format,
    live: false,
  };
  if (formatted.summaryMaxLines !== undefined) {
    line.previewStyle = "summary";
    line.summaryMaxLines = formatted.summaryMaxLines;
  } else if (!formatted.full) {
    line.previewStyle = "summary";
  }
  return line;
}

function formatToolFinishedWithoutResult(toolUse: ToolUseRequest, ok: boolean): Omit<UiLine, "id"> {
  const inputText = formatJson(toolUse.input, 1200);
  return {
    kind: ok ? "tool" : "error",
    title: toolTitle(toolUse.name, "finished"),
    titleStatus: ok ? "success" : "failure",
    text: inputText ? `${ok ? "finished" : "failed"}\n${inputText}` : ok ? "finished" : "failed",
    previewStyle: "summary",
    live: true,
    pendingReplacement: true,
  };
}

function toolTitle(toolName: string, phase: "running" | "finished"): string {
  if (toolName === "plan") return `${phase === "running" ? "◇" : "◆"} plan`;
  return `${phase === "running" ? "◇" : "◆"} ${toolName}`;
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
  return value.items.every((item) => {
    if (!isRecord(item)) return false;
    return (
      typeof item.description === "string" &&
      (item.status === "pending" || item.status === "in_progress" || item.status === "completed")
    );
  });
}

function formatPlanToolPayload(payload: PlanToolPayloadLike): string {
  const sections: string[] = [];
  if (payload.title?.trim()) sections.push(`**${payload.title.trim()}**`);
  if (payload.summary?.trim()) sections.push(payload.summary.trim());
  if (payload.note?.trim()) sections.push(payload.note.trim());
  sections.push(payload.items.map(formatPlanItem).join("\n"));
  return sections.filter(Boolean).join("\n");
}

function formatPlanItem(item: PlanItemLike): string {
  const text = escapePlanMarkdown(item.description.trim());
  if (item.status === "completed") return `- ~~${text}~~`;
  if (item.status === "in_progress") return `- ▶ ${text}`;
  return `- ${text}`;
}

function escapePlanMarkdown(text: string): string {
  return text.replace(/([\\`*_{}[\]()#+.!|>~-])/g, "\\$1");
}

function formatJson(value: unknown, maxLength: number): string {
  return formatReplData(value, maxLength);
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
  if (value instanceof Error) return formatReplObject({ name: value.name, message: value.message, stack: value.stack }, indent, seen);
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
  const lines = value.map((item) => {
    if (isReplScalar(item)) return `${pad}- ${formatReplValue(item, childIndent, seen)}`;
    const formatted = formatReplValue(item, childIndent, seen);
    return `${pad}-\n${formatted}`;
  });
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
    if (formatted === "[]" || formatted === "{}" || formatted === "[Circular]") return `${label} ${formatted}`;
    return `${label}\n${formatted}`;
  });
  seen.delete(value);
  return lines.join("\n");
}

function isReplScalar(value: unknown): boolean {
  return value === null || value === undefined || typeof value !== "object" || value instanceof Date;
}

function formatToolResult(toolName: string, output: unknown, ok: boolean): { text: string; format?: UiLine["format"]; full?: boolean; summaryMaxLines?: number } {
  if (toolName === "edit" && isRecord(output) && isEditToolOutput(output)) {
    return { text: formatEditToolDiff(output, ok), format: "ansi", summaryMaxLines: EDIT_TOOL_SUMMARY_MAX_LINES };
  }

  if (isExecOutput(output)) {
    const status = output.timedOut
      ? "timed out"
      : output.exitCode === 0
        ? "exit 0"
        : `exit ${output.exitCode ?? output.signal ?? "unknown"}`;
    const sections = [
      `${status} · ${output.durationMs}ms`,
      `$ ${output.command}`,
    ];
    if (output.stdout) sections.push("stdout:", output.stdout.replace(/\s+$/u, ""));
    if (output.stderr) sections.push("stderr:", output.stderr.replace(/\s+$/u, ""));
    if (!output.stdout && !output.stderr) sections.push(ok ? "no output" : "no captured output");
    return { text: sections.join("\n"), format: "ansi" };
  }

  if (typeof output === "string" && hasAnsi(output)) {
    return { text: output, format: "ansi" };
  }

  if (toolName === "list" && isRecord(output)) {
    return { text: formatListToolResult(output, ok) };
  }

  if (toolName === "read" && isRecord(output)) {
    return { text: formatReadToolResult(output, ok) };
  }

  if (toolName === "grep" && isRecord(output)) {
    return { text: formatGrepToolResult(output, ok) };
  }

  if (toolName === "search" && isRecord(output)) {
    return { text: formatWebSearchToolResult(output, ok), summaryMaxLines: EXPANDED_SUMMARY_MAX_LINES };
  }

  if (toolName === "plan" && isPlanToolPayload(output)) {
    return { text: formatPlanToolPayload(output), full: true };
  }

  return { text: `${ok ? "ok" : "failed"}\n${formatJson(output, 6000)}`, summaryMaxLines: EXPANDED_SUMMARY_MAX_LINES };
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
  return (
    typeof value.path === "string" &&
    typeof value.operation === "string" &&
    typeof value.replacements === "number" &&
    Array.isArray(value.patch) &&
    value.patch.every(isEditPatchHunk)
  );
}

function isEditPatchHunk(value: unknown): value is EditPatchHunkLike {
  if (!isRecord(value)) return false;
  return (
    typeof value.oldStart === "number" &&
    typeof value.oldLines === "number" &&
    typeof value.newStart === "number" &&
    typeof value.newLines === "number" &&
    Array.isArray(value.lines) &&
    value.lines.every((line) => typeof line === "string")
  );
}

function formatEditToolDiff(output: EditToolOutputLike, ok: boolean): string {
  const lines = [
    dimAnsi(`${ok ? output.operation : "failed"} ${output.path}, ${output.replacements} replacement(s)`),
    `\x1b[2;31m--- ${output.path}\x1b[0m`,
    `\x1b[2;32m+++ ${output.path}\x1b[0m`,
  ];
  for (const hunk of output.patch) {
    lines.push(colorizeDiffLine(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`));
    lines.push(...formatEditPatchHunkLines(hunk));
  }
  if (output.patch.length === 0) lines.push(dimAnsi("no changes"));
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
    const line = `${oldLineLabel} ${newLineLabel} │ ${marker}${rawLine.slice(1)}`;

    if (showOldLineNumber) oldLineNumber += 1;
    if (showNewLineNumber) newLineNumber += 1;
    return colorizeDiffLine(line, marker);
  });
}

function diffLineNumberWidth(start: number, lineCount: number): number {
  const end = lineCount > 0 ? start + lineCount - 1 : start;
  return Math.max(String(start).length, String(end).length, 2);
}

function diffLineMarker(line: string): "+" | "-" | " " | undefined {
  const marker = line[0];
  if (marker === "+" || marker === "-" || marker === " ") return marker;
  return undefined;
}

function colorizeDiffLine(line: string, marker?: "+" | "-" | " "): string {
  if (marker === "+" || (!marker && line.startsWith("+"))) return `\x1b[2;32m${line}\x1b[0m`;
  if (marker === "-" || (!marker && line.startsWith("-"))) return `\x1b[2;31m${line}\x1b[0m`;
  if (line.startsWith("@@")) return `\x1b[2;36m${line}\x1b[0m`;
  return dimAnsi(line);
}

function dimAnsi(line: string): string {
  return `\x1b[2m${line}\x1b[0m`;
}

interface ExecResultLike {
  command: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
}

function isExecOutput(value: unknown): value is ExecResultLike {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.command === "string" &&
    (typeof record.exitCode === "number" || record.exitCode === null) &&
    typeof record.timedOut === "boolean" &&
    typeof record.durationMs === "number" &&
    typeof record.stdout === "string" &&
    typeof record.stderr === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function formatListToolResult(output: Record<string, unknown>, ok: boolean): string {
  const pathValue = typeof output.path === "string" ? output.path : "";
  const typeValue = typeof output.type === "string" ? output.type : "result";
  const returnedEntries = typeof output.returnedEntries === "number" ? output.returnedEntries : undefined;
  const totalFiles = typeof output.totalFiles === "number" ? output.totalFiles : undefined;
  const totalDirectories = typeof output.totalDirectories === "number" ? output.totalDirectories : undefined;
  const entries = Array.isArray(output.entries) ? output.entries : [];
  const names = entries
    .map((entry) => (isRecord(entry) && typeof entry.name === "string" ? entry.name : undefined))
    .filter((name): name is string => Boolean(name))
    .slice(0, 3);

  const lines = [ok ? typeValue : "failed"];
  if (pathValue) lines.push(pathValue);
  const counts = [
    returnedEntries !== undefined ? `${returnedEntries} shown` : undefined,
    totalFiles !== undefined ? `${totalFiles} files` : undefined,
    totalDirectories !== undefined ? `${totalDirectories} dirs` : undefined,
  ].filter((value): value is string => Boolean(value));
  if (counts.length > 0) lines.push(counts.join(" · "));
  for (const name of names) lines.push(name);
  return lines.join("\n");
}

function formatReadToolResult(output: Record<string, unknown>, ok: boolean): string {
  const error = typeof output.error === "string" ? output.error : undefined;
  if (!ok || error) return ["failed", error ?? formatJson(output, 1200)].join("\n");

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
    const more = [hasMoreBefore ? "more before" : undefined, hasMoreAfter ? "more after" : undefined]
      .filter((value): value is string => Boolean(value))
      .join(", ");
    lines.push(`range: lines ${startLine}-${endLine} of ${totalLines}${more ? ` (${more})` : ""}`);
  }
  lines.push("content:");
  lines.push(content || "(empty range)");
  return lines.join("\n");
}

function formatWebSearchToolResult(output: Record<string, unknown>, ok: boolean): string {
  const error = typeof output.error === "string" ? output.error : undefined;
  if (!ok || error) return ["failed", error ?? formatJson(output, 1200)].join("\n");

  const provider = typeof output.provider === "string" ? output.provider : "unknown";
  const query = typeof output.query === "string" ? output.query : "";
  const returnedResults = typeof output.returnedResults === "number" ? output.returnedResults : undefined;
  const results = Array.isArray(output.results) ? output.results : [];
  const header = [`${returnedResults ?? results.length} web result(s) via ${provider}`];
  if (query) header.push(`query: ${query}`);
  if (output.truncated === true) header.push("truncated");
  if (results.length === 0) return [...header, "no results"].join("\n");

  const lines = [...header];
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
  if (!ok || error) return ["failed", error ?? formatJson(output, 1200)].join("\n");

  const query = typeof output.query === "string" ? output.query : undefined;
  const grepPath = typeof output.grepPath === "string" ? output.grepPath : undefined;
  const returnedMatches = typeof output.returnedMatches === "number" ? output.returnedMatches : undefined;
  const totalMatchesKnown = typeof output.totalMatchesKnown === "number" ? output.totalMatchesKnown : undefined;
  const truncated = output.truncated === true;
  const matches = Array.isArray(output.matches) ? output.matches.filter(isGrepMatchLike) : [];
  const errors = Array.isArray(output.errors)
    ? output.errors.filter((value): value is string => typeof value === "string")
    : [];
  const transportTruncation = isRecord(output.transportTruncation) ? output.transportTruncation : undefined;
  const omittedMatches = typeof transportTruncation?.omittedMatches === "number" ? transportTruncation.omittedMatches : undefined;

  const lines = ["grep result"];
  if (query !== undefined) lines.push(`query: ${query}`);
  if (grepPath !== undefined) lines.push(`path: ${grepPath}`);
  const countParts = [
    `${returnedMatches ?? matches.length} shown`,
    totalMatchesKnown !== undefined ? `${totalMatchesKnown} known` : undefined,
    truncated ? "truncated" : undefined,
    omittedMatches !== undefined && omittedMatches > 0 ? `${omittedMatches} omitted` : undefined,
  ].filter((value): value is string => Boolean(value));
  lines.push(`matches: ${countParts.join(" · ")}`);

  if (errors.length > 0) {
    lines.push("errors:");
    lines.push(...errors.slice(0, 5).map((message) => `  ${message}`));
    if (errors.length > 5) lines.push(`  ... ${errors.length - 5} more error(s)`);
  }

  if (matches.length === 0) {
    lines.push("no matches");
    return lines.join("\n");
  }

  lines.push("results:");
  for (const match of matches) {
    for (const context of match.contextBefore ?? []) {
      lines.push(formatGrepContextLine(context, "-"));
    }
    lines.push(formatGrepMatchLine(match));
    for (const context of match.contextAfter ?? []) {
      lines.push(formatGrepContextLine(context, "+"));
    }
  }
  return lines.join("\n");
}

interface GrepMatchLike {
  file: string;
  line: number;
  column?: number;
  text: string;
  contextBefore?: GrepContextLineLike[];
  contextAfter?: GrepContextLineLike[];
}

interface GrepContextLineLike {
  file: string;
  line: number;
  text: string;
}

function isGrepMatchLike(value: unknown): value is GrepMatchLike {
  if (!isRecord(value)) return false;
  return (
    typeof value.file === "string" &&
    typeof value.line === "number" &&
    typeof value.text === "string" &&
    (value.column === undefined || typeof value.column === "number")
  );
}

function formatGrepMatchLine(match: GrepMatchLike): string {
  const column = match.column !== undefined ? `:${match.column}` : "";
  return `  ${match.file}:${match.line}${column}: ${match.text}`;
}

function formatGrepContextLine(line: GrepContextLineLike, marker: "-" | "+"): string {
  return `  ${line.file}:${line.line}${marker} ${line.text}`;
}

interface RenderedContextParts {
  used: string;
  limit: string;
  percent: string;
}

function renderContextParts(metrics: ContextMetrics | undefined): RenderedContextParts {
  if (!metrics) return { used: "?", limit: "?", percent: "?" };
  const used = compactNumber(metrics.estimatedInputTokens);
  const limit = metrics.contextWindowTokens ? compactNumber(metrics.contextWindowTokens) : "?";
  const percent = metrics.contextUsageRatio === undefined ? "?" : `${(metrics.contextUsageRatio * 100).toFixed(1)}%`;
  return { used, limit, percent };
}

function contextColor(metrics: ContextMetrics | undefined): string {
  const ratio = metrics?.contextUsageRatio;
  if (ratio === undefined) return "gray";
  if (ratio >= 0.9) return "red";
  if (ratio >= 0.75) return "yellow";
  return "gray";
}

function statusInputTokens(status: UiStatus): number | undefined {
  return status.usage?.inputTokens ?? status.metrics?.estimatedInputTokens;
}

function statusOutputTokens(status: UiStatus): number | undefined {
  return status.usage?.outputTokens ?? status.streamedOutputTokens;
}

function tokenArrowColor(updatedAt: number | undefined, now: number, activeColor: string): string {
  return updatedAt !== undefined && now - updatedAt <= TOKEN_PULSE_MS ? activeColor : "gray";
}

function retryCooldownActive(status: UiStatus, now: number): boolean {
  return status.retryCooldownUntil !== undefined && now < status.retryCooldownUntil;
}

function modelOutputPending(status: UiStatus, now: number): boolean {
  if (retryCooldownActive(status, now)) return true;
  if (status.phase !== "calling_model") return false;
  return tokenArrowColor(status.outputTokenUpdatedAt, now, "cyan") === "gray";
}

function slowBlinkVisible(tick: number): boolean {
  return Math.floor(tick / STATUS_BLINK_TICKS) % 2 === 0;
}

function estimateTokens(text: string): number {
  return text ? Math.max(1, Math.ceil(text.length / 4)) : 0;
}

function formatNumber(value: number | undefined): string {
  return value === undefined ? "?" : new Intl.NumberFormat("en-US").format(Math.round(value));
}

function formatCompactNumber(value: number | undefined): string {
  if (value === undefined) return "?";
  if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(1))}M`;
  if (value >= 1_000) return `${Number((value / 1_000).toFixed(1))}K`;
  return String(Math.round(value));
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}

function truncateAnsi(value: string, maxLength: number): string {
  if (stripAnsi(value).length <= maxLength) return value;
  if (maxLength <= 0) return "";

  let visibleLength = 0;
  let index = 0;
  let output = "";
  const ansiPattern = /\x1b\[[0-9;]*m/y;

  while (index < value.length && visibleLength < maxLength) {
    ansiPattern.lastIndex = index;
    const ansiMatch = ansiPattern.exec(value);
    if (ansiMatch) {
      output += ansiMatch[0];
      index = ansiPattern.lastIndex;
      continue;
    }

    const codePoint = value.codePointAt(index);
    if (codePoint === undefined) break;
    const char = String.fromCodePoint(codePoint);
    output += char;
    visibleLength += 1;
    index += char.length;
  }

  return hasAnsi(output) ? `${output}\x1b[0m` : output;
}

function phaseLabelForStatus(phase: string): string {
  if (phase === "calling_model") return "model";
  if (phase === "thinking") return "think";
  if (phase === "running_tools") return "tools";
  if (phase === "injecting_context") return "context";
  return phase;
}

function isActivePhase(phase: string): boolean {
  return phase === "running" ||
    phase === "preparing" ||
    phase === "calling_model" ||
    phase === "thinking" ||
    phase === "running_tools" ||
    phase === "compacting" ||
    phase === "injecting_context";
}

function phaseColor(phase: string): string {
  if (phase === "ready") return "green";
  if (phase === "stopped") return "yellow";
  if (phase === "failed") return "red";
  if (phase === "thinking") return THINKING_COLOR;
  if (phase === "running_tools") return "#d4b04c";
  if (phase === "compacting" || phase === "injecting_context") return "magenta";
  return "cyan";
}

function renderPhaseStatusSegments(text: string, phase: string, animationTick: number): StatusSegment[] {
  const color = phaseColor(phase);
  if (!isActivePhase(phase) || text.length <= 1) return [{ text, color, bold: true }];

  const shimmerCenter = animationTick % (text.length + STATUS_SHIMMER_GAP_TICKS);
  return [...text].map((char, index) => ({
    text: char,
    color: Math.abs(index - shimmerCenter) <= STATUS_SHIMMER_RADIUS ? STATUS_SHIMMER_COLOR : color,
    bold: true,
  }));
}

function compactNumber(value: number | undefined): string {
  if (value === undefined) return "?";
  const rounded = Math.max(0, Math.round(value));
  if (rounded >= 1_000_000) return `${trimFixed(rounded / 1_000_000)}m`;
  if (rounded >= 10_000) return `${Math.round(rounded / 1000)}k`;
  if (rounded >= 1000) return `${trimFixed(rounded / 1000)}k`;
  return String(rounded);
}

function statusDividerSegment(): StatusSegment {
  return { text: STATUS_SEPARATOR, color: "gray" };
}

function statusLabelSegment(text: string, color = "gray"): StatusSegment {
  return { text, color, bold: color !== "gray" };
}

function trimFixed(value: number): string {
  return value >= 10 ? value.toFixed(0) : value.toFixed(1).replace(/\.0$/, "");
}

function statusBarWidth(columns: number): number {
  return Math.max(1, Math.min(columns - 1, 160));
}

interface TerminalSize {
  columns: number;
  rows: number;
}

function useTerminalSize(): TerminalSize {
  const [size, setSize] = useState<TerminalSize>(() => currentTerminalSize());

  useEffect(() => {
    const onResize = () => setSize(currentTerminalSize());
    stdout.on("resize", onResize);
    onResize();
    return () => {
      stdout.off("resize", onResize);
    };
  }, []);

  return size;
}

function currentTerminalSize(): TerminalSize {
  return {
    columns: terminalColumns(),
    rows: terminalRows(),
  };
}

function terminalRows(): number {
  return Math.max(8, stdout.rows ?? 30);
}

function terminalColumns(): number {
  return Math.max(1, stdout.columns ?? 100);
}

interface PromptVisualLine {
  before: string;
  selected: string;
  after: string;
}

function promptPrefix(busy: boolean): string {
  return messageRoleMarker();
}

function promptTextView(text: string, cursor: number, terminalWidth: number, prompt: string): PromptVisualLine[] {
  const normalized = text.replace(/\r?\n/g, " ");
  const safeCursor = Math.max(0, Math.min(cursor, normalized.length));
  const prefixWidth = stringCellWidth(prompt);
  const firstContentWidth = Math.max(1, terminalWidth - prefixWidth);
  const continuationWidth = firstContentWidth;
  const segments = wrapPromptText(normalized, safeCursor, firstContentWidth, continuationWidth);
  return segments.length > 0 ? segments : [{ before: "", selected: " ", after: "" }];
}

interface PromptSegment {
  start: number;
  end: number;
}

function wrapPromptText(text: string, cursor: number, firstWidth: number, continuationWidth: number): PromptVisualLine[] {
  const segments: PromptSegment[] = [];
  let start = 0;
  let index = 0;
  let width = Math.max(1, firstWidth);
  let used = 0;

  while (index < text.length) {
    const char = nextTextChar(text, index);
    const charWidth = Math.max(1, stringCellWidth(char.value));
    if (used > 0 && used + charWidth > width) {
      segments.push({ start, end: index });
      start = index;
      used = 0;
      width = Math.max(1, continuationWidth);
      continue;
    }
    used += charWidth;
    index = char.nextIndex;
  }

  segments.push({ start, end: text.length });

  const cursorSegmentIndex = segmentIndexForCursor(segments, cursor);
  return segments.map((segment, index) => {
    if (index !== cursorSegmentIndex) return { before: text.slice(segment.start, segment.end), selected: "", after: "" };
    const selected = cursor < segment.end ? nextTextChar(text, cursor).value : " ";
    const selectedEnd = cursor < segment.end ? nextTextChar(text, cursor).nextIndex : cursor;
    return {
      before: text.slice(segment.start, cursor),
      selected,
      after: text.slice(selectedEnd, segment.end),
    };
  });
}

function segmentIndexForCursor(segments: PromptSegment[], cursor: number): number {
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (!segment) continue;
    const isLast = index === segments.length - 1;
    if (cursor >= segment.start && (cursor < segment.end || isLast || segment.start === segment.end)) return index;
  }
  return Math.max(0, segments.length - 1);
}

function nextTextChar(text: string, index: number): { value: string; nextIndex: number } {
  const codePoint = text.codePointAt(index);
  if (codePoint === undefined) return { value: "", nextIndex: index };
  const value = String.fromCodePoint(codePoint);
  return { value, nextIndex: index + value.length };
}

function messageContentWidth(columns: number): number {
  return Math.max(10, columns - messageRoleMarker().length);
}

function toolContentWidth(columns: number): number {
  return Math.max(10, columns - 2);
}

function stringCellWidth(value: string): number {
  let width = 0;
  for (const char of [...value]) width += charCellWidth(char);
  return width;
}

function charCellWidth(char: string): number {
  const codePoint = char.codePointAt(0);
  if (codePoint === undefined) return 0;
  if (codePoint === 0) return 0;
  if (codePoint < 32 || (codePoint >= 0x7f && codePoint < 0xa0)) return 0;
  if (isCombiningMark(codePoint)) return 0;
  return isFullWidthCodePoint(codePoint) ? 2 : 1;
}

function isCombiningMark(codePoint: number): boolean {
  return (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe20 && codePoint <= 0xfe2f)
  );
}

function isFullWidthCodePoint(codePoint: number): boolean {
  return (
    codePoint >= 0x1100 && (
      codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1f300 && codePoint <= 0x1f64f) ||
      (codePoint >= 0x1f900 && codePoint <= 0x1f9ff) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd)
    )
  );
}

const SESSIONS_DEFAULT_PAGE_SIZE = 10;
const TERMINAL_TITLE_DOT_FILLED_PREFIX = "● ";
const TERMINAL_TITLE_DOT_BLANK_PREFIX = "  ";
const TERMINAL_TITLE_BLINK_INTERVAL_MS = 1000;
const REPL_ANIMATION_INTERVAL_MS = 420;
const TOOL_RESULT_REPLACEMENT_DELAY_MS = 2000;
const TOKEN_PULSE_MS = 900;
const ANIMATED_NUMBER_INTERVAL_MS = 50;
const ANIMATED_NUMBER_MIN_DURATION_MS = 180;
const ANIMATED_NUMBER_MAX_DURATION_MS = 700;
const ANIMATED_NUMBER_DURATION_SCALE_MS = 130;
const STATUS_BLINK_TICKS = 2;
const STATUS_PHASE_MIN_DISPLAY_MS = 2000;
const STATUS_SHIMMER_GAP_TICKS = 3;
const STATUS_SHIMMER_RADIUS = 1;
const STATUS_SHIMMER_COLOR = "whiteBright";
const STATUS_SEPARATOR = " · ";
const STATUS_BAR_RENDER_ROWS = 2;
const BACKGROUND_TASK_STATUS_RENDER_ROWS = 1;
const QUEUED_INPUT_RENDER_ROWS = 1;
const EMPTY_CTRL_C_EXIT_PLACEHOLDER = "Press Ctrl+C again to exit";
const LONG_CLIPBOARD_TEXT_THRESHOLD = 200;
const PASTE_STATUS_DISPLAY_MS = 2500;
const MIN_LIVE_VIEWPORT_LINES = 4;
const MESSAGE_BLOCK_SPACING_LINES = 1;
const SUMMARY_BLOCK = {
  maxLines: 6,
  detailIndent: "    ",
};
const THINKING_COLOR = "#a855f7";
const THINKING_MARKER = "◆";
const THINKING_SUMMARY_MAX_LINES = 1000;
const EXPANDED_SUMMARY_MAX_LINES = 1000;
const EDIT_TOOL_SUMMARY_MAX_LINES = EXPANDED_SUMMARY_MAX_LINES;

function fixed(value: string, width: number, align: "left" | "right" = "right"): string {
  const stripped = stripAnsi(value);
  const trimmed = stripped.length > width ? stripped.slice(0, width) : stripped;
  return align === "left" ? trimmed.padEnd(width, " ") : trimmed.padStart(width, " ");
}

function fitToWidth(value: string, width: number): string {
  const stripped = stripAnsi(value);
  if (stripped.length === width) return stripped;
  if (stripped.length > width) return stripped.slice(0, width);
  return stripped.padEnd(width, " ");
}

function truncateMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  if (maxLength <= 3) return value.slice(0, maxLength);
  const left = Math.ceil((maxLength - 3) / 2);
  const right = Math.floor((maxLength - 3) / 2);
  return `${value.slice(0, left)}...${value.slice(value.length - right)}`;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
