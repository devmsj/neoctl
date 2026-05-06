#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { stdout } from "node:process";
import React, { useEffect, useRef, useState } from "react";
import { Box, Text, render, useApp, useInput } from "ink";
import figures from "figures";
import stripAnsi from "strip-ansi";
import wrapAnsi from "wrap-ansi";
import { QueryEngine } from "../core/query-engine.js";
import type { SessionStoreSnapshot, SessionSummary } from "../session/session-store.js";
import { createModelGatewayFromEnv, loadDotEnvIfPresent } from "../model/env.js";
import { readModelProviderConfig } from "../model/config.js";
import { resolveContextWindowTokens } from "../model/context-window.js";
import { CommunicationLogger, LoggingModelGateway } from "../model/communication-logger.js";
import type { ModelUsage } from "../model/model-gateway.js";
import { ToolRegistry } from "../tools/registry.js";
import { echoTool } from "../tools/builtins/echo-tool.js";
import { editTool, writeTool } from "../tools/builtins/edit-tool.js";
import { execTool } from "../tools/builtins/exec-tool.js";
import { listDirectoryTool, readFileTool } from "../tools/builtins/filesystem-tools.js";
import { searchTool } from "../tools/builtins/search-tool.js";
import { createAgentTool } from "../agents/agent-tool.js";
import { createTaskTools } from "../tasks/task-tools.js";
import { TaskStore } from "../tasks/task-store.js";
import { parseReplCommand, helpText } from "./commands.js";
import { estimateMarkdownLineCount, MarkdownText } from "./markdown-renderer.js";
import type { AgentEvent, ContextMetrics } from "../types/events.js";
import type { Message, ToolUseRequest } from "../types/messages.js";

const e = React.createElement;
interface ReplRuntime {
  engine: QueryEngine;
  communicationLogger: CommunicationLogger;
  initialMetrics: ContextMetrics;
}

interface UiLine {
  id: number;
  kind: "system" | "user" | "assistant" | "thinking" | "tool" | "error" | "meta";
  text: string;
  title?: string;
  format?: "markdown" | "ansi";
  previewStyle?: "summary";
  live?: boolean;
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

async function main(): Promise<void> {
  const runtime = await createRuntime();
  const instance = render(e(InkRepl, { runtime }), {
    exitOnCtrlC: false,
  });
  await instance.waitUntilExit();
}

async function createRuntime(): Promise<ReplRuntime> {
  loadDotEnvIfPresent(undefined, { override: true });
  const modelConfig = readModelProviderConfig(process.env);
  const communicationLogger = new CommunicationLogger();
  const modelGateway = new LoggingModelGateway(createModelGatewayFromEnv(), communicationLogger);
  const taskStore = new TaskStore();
  const tools = new ToolRegistry();
  tools.register(echoTool);
  tools.register(editTool);
  tools.register(writeTool);
  tools.register(execTool);
  tools.register(listDirectoryTool);
  tools.register(readFileTool);
  tools.register(searchTool);
  for (const tool of createTaskTools(taskStore)) tools.register(tool);
  tools.register(createAgentTool({ modelGateway, tools, taskStore }));

  const engine = new QueryEngine({
    agentId: "main",
    model: modelConfig?.model,
    fallbackModel: modelConfig?.fallbackModel,
    modelGateway,
    tools,
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
  return { engine, communicationLogger, initialMetrics: initialContextMetrics(modelConfig?.model, engine.snapshot().messages, tools.names().length) };
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
          source: window.model.source,
        }
      : undefined,
  };
}

function initialStatus(runtime: ReplRuntime): UiStatus {
  return {
    phase: "ready",
    metrics: {
      ...runtime.initialMetrics,
      messageCount: runtime.engine.snapshot().messages,
    },
    streamedOutputTokens: 0,
    activityTick: 0,
  };
}

function InkRepl({ runtime }: { runtime: ReplRuntime }) {
  const app = useApp();
  const lineId = useRef(0);
  const assistantLineId = useRef<number | undefined>(undefined);
  const thinkingLineId = useRef<number | undefined>(undefined);
  const activeAbortController = useRef<AbortController | undefined>(undefined);
  const interruptArmed = useRef(false);
  const history = useRef<string[]>([]);
  const [lines, setLines] = useState<UiLine[]>(() => initialLines(runtime));
  const [input, setInput] = useState("");
  const [cursor, setCursor] = useState(0);
  const [historyIndex, setHistoryIndex] = useState<number | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<UiStatus>(() => initialStatus(runtime));
  const [scrollOffset, setScrollOffset] = useState(0);
  const [animationTick, setAnimationTick] = useState(0);

  useEffect(() => {
    if (!busy) return undefined;
    const interval = setInterval(() => setAnimationTick((current) => current + 1), REPL_ANIMATION_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [busy]);

  const append = (line: Omit<UiLine, "id">) => {
    const id = ++lineId.current;
    const next: UiLine = { id, ...line };
    setLines((current) => [...current, next]);
    return id;
  };

  const updateLine = (id: number, updater: (text: string) => string) => {
    setLines((current) => current.map((line) => line.id === id ? { ...line, text: updater(line.text) } : line));
  };

  const replaceLineText = (id: number, text: string) => {
    setLines((current) => current.map((line) => line.id === id ? { ...line, text } : line));
  };

  const finalizeLiveLine = (id: number | undefined) => {
    if (id === undefined) return;
    setLines((current) => current.map((line) => line.id === id ? { ...line, live: false } : line));
  };

  const handleEvent = (event: AgentEvent) => {
    setStatus((current) => reduceStatus(current, event));
    if (event.type === "state") return;
    if (event.type === "context.metrics" || event.type === "usage") return;
    if (event.type === "assistant.delta") {
      finalizeLiveLine(thinkingLineId.current);
      thinkingLineId.current = undefined;
      const id = assistantLineId.current ?? append({ kind: "assistant", text: "", live: true });
      assistantLineId.current = id;
      updateLine(id, (text) => text + event.text);
      return;
    }
    if (event.type === "thinking.delta") {
      const id = thinkingLineId.current ?? append({ kind: "thinking", title: "Think", text: "", previewStyle: "summary", live: true });
      thinkingLineId.current = id;
      updateLine(id, (text) => text + event.text);
      return;
    }
    if (event.type === "message") {
      if (event.message.role === "assistant" && assistantLineId.current !== undefined) {
        const text = assistantText(event.message);
        if (text !== undefined) {
          replaceLineText(assistantLineId.current, text);
          finalizeLiveLine(assistantLineId.current);
          return;
        }
      }
      if (event.message.role === "assistant" && thinkingLineId.current !== undefined) {
        const text = thinkingText(event.message);
        if (text !== undefined) {
          replaceLineText(thinkingLineId.current, text);
          finalizeLiveLine(thinkingLineId.current);
          thinkingLineId.current = undefined;
          return;
        }
      }
      if (event.message.role !== "assistant") {
        finalizeLiveLine(assistantLineId.current);
        finalizeLiveLine(thinkingLineId.current);
        assistantLineId.current = undefined;
        thinkingLineId.current = undefined;
      }
      const rendered = renderMessage(event.message, append, assistantLineId.current);
      if (rendered && event.message.role === "assistant") {
        finalizeLiveLine(assistantLineId.current);
        finalizeLiveLine(thinkingLineId.current);
        assistantLineId.current = undefined;
        thinkingLineId.current = undefined;
      }
      return;
    }
    if (event.type === "tool.started") {
      finalizeLiveLine(assistantLineId.current);
      finalizeLiveLine(thinkingLineId.current);
      thinkingLineId.current = undefined;
      append(formatToolUse(event.toolUse));
      return;
    }
    if (event.type === "tool.finished") return;
    if (event.type === "retrying") return;
    if (event.type === "terminal") {
      finalizeLiveLine(assistantLineId.current);
      finalizeLiveLine(thinkingLineId.current);
      assistantLineId.current = undefined;
      thinkingLineId.current = undefined;
      return;
    }
    if (event.type === "error") {
      append({ kind: "error", text: event.error.message });
    }
  };

  const submitLine = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    history.current = [text, ...history.current.filter((entry) => entry !== text)].slice(0, 100);
    setHistoryIndex(undefined);
    setInput("");
    setCursor(0);
    setScrollOffset(0);
    await handleCommandOrPrompt(text);
  };

  const handleCommandOrPrompt = async (text: string) => {
    const command = parseReplCommand(text);
    if (command.type === "exit") {
      app.exit();
      return;
    }
    if (command.type === "help") {
      append(systemLine(helpText));
      return;
    }
    if (command.type === "reset") {
      runtime.engine.reset();
      setStatus(initialStatus(runtime));
      append(systemLine("transcript reset"));
      return;
    }
    if (command.type === "state") {
      append(systemLine(JSON.stringify({ ...runtime.engine.snapshot(), communicationLog: runtime.communicationLogger.snapshot() }, null, 2)));
      return;
    }
    if (command.type === "sessions") {
      await handleSessionsCommand(command.limit, runtime, (line) => append(line));
      return;
    }
    if (command.type === "resume") {
      const resumed = await handleResumeCommand(command.sessionId, runtime, (line) => append(line));
      if (resumed) setStatus(initialStatus(runtime));
      return;
    }
    if (command.type === "log") {
      await handleLogCommand(command, runtime, append);
      return;
    }

    append({ kind: "user", text });
    const abortController = new AbortController();
    activeAbortController.current = abortController;
    interruptArmed.current = false;
    setBusy(true);
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
      for await (const event of runtime.engine.sendUserText(command.text, { abortSignal: abortController.signal })) {
        handleEvent(event);
      }
    } catch (error) {
      finalizeLiveLine(assistantLineId.current);
      finalizeLiveLine(thinkingLineId.current);
      assistantLineId.current = undefined;
      thinkingLineId.current = undefined;
      append({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      if (activeAbortController.current === abortController) activeAbortController.current = undefined;
      interruptArmed.current = false;
      finalizeLiveLine(assistantLineId.current);
      finalizeLiveLine(thinkingLineId.current);
      assistantLineId.current = undefined;
      thinkingLineId.current = undefined;
      setBusy(false);
      setStatus((current) => ({
        ...current,
        phase: "ready",
        detail: undefined,
        inputTokenUpdatedAt: undefined,
        outputTokenUpdatedAt: undefined,
        retryCooldownUntil: undefined,
      }));
    }
  };

  useEffect(() => {
    setLines(initialLines(runtime));
    assistantLineId.current = undefined;
    thinkingLineId.current = undefined;
    setStatus(initialStatus(runtime));
    setScrollOffset(0);
  }, [runtime]);

  const terminalSize = useTerminalSize();
  const width = terminalSize.columns;
  const prompt = promptPrefix(busy);
  const promptHeight = estimatePromptHeight(input, cursor, width, prompt);
  const contentWidth = messageContentWidth(width);
  const toolWidth = toolContentWidth(width);
  const maxMessageViewportHeight = Math.max(1, terminalSize.rows - STATUS_BAR_ROWS - promptHeight - MESSAGE_VIEWPORT_PADDING_ROWS);
  const messageContentHeight = totalUiLinesHeight(lines, contentWidth, toolWidth);
  const reviewingHistory = scrollOffset > 0;
  const messageViewportHeight = reviewingHistory
    ? maxMessageViewportHeight
    : Math.max(1, messageContentHeight);
  const scrollViewportHeight = Math.min(maxMessageViewportHeight, Math.max(1, messageContentHeight));
  const maxScrollOffset = maxScrollForLines(lines, scrollViewportHeight, contentWidth, toolWidth);
  const effectiveScrollOffset = Math.min(scrollOffset, maxScrollOffset);
  const scrollPage = Math.max(1, scrollViewportHeight - 1);

  useEffect(() => {
    setScrollOffset((current) => Math.min(current, maxScrollOffset));
  }, [maxScrollOffset]);

  useInput((value, key) => {
    if (key.ctrl && value === "c") {
      if (busy) {
        const controller = activeAbortController.current;
        if (controller && !controller.signal.aborted && !interruptArmed.current) {
          interruptArmed.current = true;
          controller.abort("Interrupted by Ctrl+C");
          append(metaLine("interrupt requested; press Ctrl+C again to exit"));
          setStatus((current) => ({ ...current, phase: "stopped", detail: "interrupt requested" }));
          return;
        }
      }
      app.exit();
      return;
    }
    if (key.pageUp || (key.ctrl && key.upArrow)) {
      setScrollOffset((current) => Math.min(maxScrollOffset, current + scrollPage));
      return;
    }
    if (key.pageDown || (key.ctrl && key.downArrow)) {
      setScrollOffset((current) => Math.max(0, current - scrollPage));
      return;
    }
    if (key.ctrl && key.home) {
      setScrollOffset(maxScrollOffset);
      return;
    }
    if (key.ctrl && key.end) {
      setScrollOffset(0);
      return;
    }
    if (busy) return;
    if (key.return) {
      void submitLine(input);
      return;
    }
    if (key.backspace || key.delete) {
      if (cursor > 0) {
        setInput((current) => `${current.slice(0, cursor - 1)}${current.slice(cursor)}`);
        setCursor((current) => Math.max(0, current - 1));
      }
      return;
    }
    if (key.leftArrow) {
      setCursor((current) => Math.max(0, current - 1));
      return;
    }
    if (key.rightArrow) {
      setCursor((current) => Math.min(input.length, current + 1));
      return;
    }
    if (key.home) {
      setCursor(0);
      return;
    }
    if (key.end) {
      setCursor(input.length);
      return;
    }
    if (key.upArrow) {
      const next = Math.min(history.current.length - 1, (historyIndex ?? -1) + 1);
      if (next >= 0 && history.current[next] !== undefined) {
        setHistoryIndex(next);
        setInput(history.current[next]);
        setCursor(history.current[next].length);
      }
      return;
    }
    if (key.downArrow) {
      if (historyIndex === undefined) return;
      const next = historyIndex - 1;
      if (next < 0) {
        setHistoryIndex(undefined);
        setInput("");
        setCursor(0);
      } else {
        setHistoryIndex(next);
        setInput(history.current[next] ?? "");
        setCursor((history.current[next] ?? "").length);
      }
      return;
    }
    if (key.tab) return;
    if (value && !key.ctrl && !key.meta) {
      setInput((current) => `${current.slice(0, cursor)}${value}${current.slice(cursor)}`);
      setCursor((current) => current + value.length);
    }
  });

  return e(
    Box,
    { flexDirection: "column" },
    e(MessageList, { lines, height: messageViewportHeight, scrollOffset: effectiveScrollOffset, width }),
    e(StatusBar, { status, scrollOffset: effectiveScrollOffset, maxScrollOffset, animationTick, width }),
    e(PromptLine, { text: input, cursor, busy, width, prompt }),
  );
}

function MessageList({ lines, height, scrollOffset, width }: { lines: UiLine[]; height: number; scrollOffset: number; width: number }) {
  const contentWidth = messageContentWidth(width);
  const toolWidth = toolContentWidth(width);
  const reviewingHistory = scrollOffset > 0;
  const visible = reviewingHistory
    ? selectVisibleLines(lines, height, contentWidth, toolWidth, scrollOffset)
    : lines.map((line) => ({ line, maxLines: estimateUiLineHeight(line, displayWidthForLine(line, contentWidth, toolWidth)), skipTop: 0 }));
  return e(
    Box,
    reviewingHistory ? { flexDirection: "column", height, overflow: "hidden" } : { flexDirection: "column" },
    ...visible.map((entry) => {
      const line = entry.line;
      if (line.previewStyle === "summary") {
        return e(
          Box,
          { key: line.id, flexDirection: "row" },
          e(
            Box,
            { flexDirection: "column", width: toolWidth },
            ...renderDisplayText(line, toolWidth, entry.maxLines, entry.skipTop),
          ),
        );
      }
      return e(Box, { key: line.id, flexDirection: "row" },
        e(Text, { color: colorForKind(line.kind) }, `${prefixForKind(line.kind)} `),
        e(Box, { flexDirection: "column", width: contentWidth }, ...renderDisplayText(line, contentWidth, entry.maxLines, entry.skipTop)),
      );
    }),
  );
}

interface VisibleLine {
  line: UiLine;
  maxLines: number;
  skipTop: number;
}

function selectVisibleLines(lines: UiLine[], maxHeight: number, contentWidth: number, toolWidth: number, scrollOffset: number): VisibleLine[] {
  const selected: VisibleLine[] = [];
  const viewportHeight = Math.max(1, maxHeight);
  const totalHeight = totalUiLinesHeight(lines, contentWidth, toolWidth);
  const viewportEnd = Math.max(0, totalHeight - Math.max(0, scrollOffset));
  const viewportStart = Math.max(0, viewportEnd - viewportHeight);
  let lineStart = 0;

  for (const line of lines) {
    const displayWidth = displayWidthForLine(line, contentWidth, toolWidth);
    const lineHeight = estimateUiLineHeight(line, displayWidth);
    const lineEnd = lineStart + lineHeight;
    const visibleStart = Math.max(lineStart, viewportStart);
    const visibleEnd = Math.min(lineEnd, viewportEnd);
    if (visibleEnd > visibleStart) {
      selected.push({ line, skipTop: visibleStart - lineStart, maxLines: visibleEnd - visibleStart });
    }
    lineStart = lineEnd;
    if (lineStart >= viewportEnd) break;
  }

  return selected;
}

function maxScrollForLines(lines: UiLine[], maxHeight: number, contentWidth: number, toolWidth: number): number {
  return Math.max(0, totalUiLinesHeight(lines, contentWidth, toolWidth) - Math.max(1, maxHeight));
}

function totalUiLinesHeight(lines: UiLine[], contentWidth: number, toolWidth: number): number {
  return lines.reduce((total, line) => total + estimateUiLineHeight(line, displayWidthForLine(line, contentWidth, toolWidth)), 0);
}

function displayWidthForLine(line: UiLine, contentWidth: number, toolWidth: number): number {
  return line.previewStyle === "summary" || line.kind === "tool" ? toolWidth : contentWidth;
}

function estimateUiLineHeight(line: UiLine, width: number): number {
  if (line.previewStyle === "summary") return renderSummaryLines(line, width).length;
  if (line.format === "ansi") return wrapAnsi(line.text, Math.max(10, width), { hard: true, trim: false }).split("\n").length;
  return estimateMarkdownLineCount(line.text, width);
}
function renderDisplayText(line: UiLine, width: number, maxLines?: number, skipTop = 0): React.ReactNode[] {
  if (line.previewStyle === "summary") return renderSummaryBlock(line, width, maxLines, skipTop);
  if (line.format === "ansi") return renderAnsiBlock(line.text, width, maxLines, skipTop);
  return [e(MarkdownText, { key: `markdown-${line.id}`, text: line.text, kind: line.kind, width, maxLines, skipLines: skipTop })];
}

function renderSummaryLines(line: UiLine, width: number): string[] {
  const content = line.format === "ansi" ? stripAnsi(line.text) : line.text;
  const detailWidth = Math.max(10, width - SUMMARY_BLOCK.detailIndent.length);
  const title = line.title ?? titleForKind(line.kind);
  const rawLines = content.replace(/\r\n/g, "\n").split("\n");
  const wrapped = rawLines.flatMap((rawLine, index) => {
    const lineWidth = index === 0 && !title ? width : detailWidth;
    return wrapAnsi(rawLine, Math.max(10, lineWidth), { hard: true, trim: false }).split("\n");
  });
  const preview = [title, ...wrapped].filter((value) => value.length > 0).slice(0, SUMMARY_BLOCK.maxLines);
  if (wrapped.length + (title ? 1 : 0) > SUMMARY_BLOCK.maxLines && preview.length > 0) {
    preview[preview.length - 1] = truncate(preview[preview.length - 1], Math.max(1, detailWidth - 1)) + "…";
  }
  return preview.length ? preview : [""];
}

function renderSummaryBlock(line: UiLine, width: number, maxLines?: number, skipTop = 0): React.ReactNode[] {
  const allPreviewLines = renderSummaryLines(line, width);
  const preview = clipStrings(allPreviewLines, maxLines, skipTop);
  return preview.map((previewLine, index) => {
    const sourceIndex = skipTop + index;
    const detail = sourceIndex > 0;
    return e(
      Text,
      {
        key: `summary-${line.id}-${index}`,
        color: detail ? "gray" : colorForKind(line.kind),
        dimColor: detail,
        bold: !detail,
      },
      detail ? `${SUMMARY_BLOCK.detailIndent}${previewLine}` : previewLine,
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
function renderAnsiInline(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const pattern = /\x1b\[([0-9;]*)m/g;
  let lastIndex = 0;
  let style: AnsiStyle = {};
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(e(Text, { key: `ansi-${nodes.length}`, ...style }, text.slice(lastIndex, match.index)));
    }
    style = nextAnsiStyle(style, match[1]);
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) nodes.push(e(Text, { key: `ansi-${nodes.length}`, ...style }, text.slice(lastIndex)));
  return nodes.length ? nodes : [e(Text, { key: "ansi-empty" }, "")];
}

interface AnsiStyle {
  color?: string;
  backgroundColor?: string;
  bold?: boolean;
  dimColor?: boolean;
  italic?: boolean;
  underline?: boolean;
}

function nextAnsiStyle(current: AnsiStyle, rawCodes: string | undefined): AnsiStyle {
  const codes = rawCodes ? rawCodes.split(";").filter(Boolean).map((code) => Number(code)) : [0];
  let next = { ...current };
  for (let index = 0; index < codes.length; index += 1) {
    const code = codes[index] ?? 0;
    if (code === 0) next = {};
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

function StatusBar(
  { status, scrollOffset, maxScrollOffset, animationTick, width: terminalWidth }:
  { status: UiStatus; scrollOffset: number; maxScrollOffset: number; animationTick: number; width: number },
) {
  const width = statusBarWidth(terminalWidth);
  const segments = fitStatusSegments(renderCompactStatusSegments(status, scrollOffset, maxScrollOffset, animationTick, width), width);
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

function renderCompactStatusSegments(
  status: UiStatus,
  scrollOffset: number,
  maxScrollOffset: number,
  animationTick: number,
  width: number,
): StatusSegment[] {
  const phase = status.phase;
  const now = Date.now();
  const inputTokens = statusInputTokens(status);
  const outputTokens = statusOutputTokens(status);
  const phaseText = `${statusActivityPixel(phase, animationTick)} ${phaseLabelForStatus(phase)}`;
  const inputText = `↑${compactNumber(inputTokens)}`;
  const outputText = `↓${compactNumber(outputTokens)}`;
  const contextText = `ctx:${renderContext(status.metrics)}`;
  const fixedText = [phaseText, inputText, outputText, contextText].join(STATUS_SEPARATOR);
  const modelBudget = Math.max(4, width - fixedText.length - STATUS_SEPARATOR.length);
  const model = truncateMiddle(status.metrics?.model ?? "model?", Math.min(width >= 120 ? 26 : width >= 90 ? 20 : 14, modelBudget));
  const retryPending = retryCooldownActive(status, now);
  const outputPulseColor = tokenArrowColor(status.outputTokenUpdatedAt, now, "cyan");
  const outputPending = modelOutputPending(status, now);
  const tokenInputColor = retryPending ? "red" : tokenArrowColor(status.inputTokenUpdatedAt, now, "green");
  const tokenOutputColor = outputPulseColor;
  const outputArrow = outputPending && !slowBlinkVisible(animationTick) ? " " : "↓";

  const segments: StatusSegment[] = [
    { text: phaseText, color: phaseColor(phase), bold: true },
    { text: STATUS_SEPARATOR },
    { text: model },
    { text: STATUS_SEPARATOR },
    { text: "↑", color: tokenInputColor, bold: tokenInputColor !== "gray" },
    { text: compactNumber(inputTokens) },
    { text: STATUS_SEPARATOR },
    { text: outputArrow, color: tokenOutputColor, bold: tokenOutputColor !== "gray" },
    { text: compactNumber(outputTokens) },
    { text: STATUS_SEPARATOR },
    { text: contextText },
  ];

  if (scrollOffset > 0 && maxScrollOffset > 0) {
    segments.push({ text: STATUS_SEPARATOR }, { text: `scroll ${scrollOffset}/${maxScrollOffset}` });
  }
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

function PromptLine(
  { text, cursor, busy, width, prompt }:
  { text: string; cursor: number; busy: boolean; width: number; prompt: string },
) {
  const visualLines = promptTextView(text, cursor, width, prompt);
  return e(
    Box,
    { flexDirection: "column" },
    ...visualLines.map((line, index) => e(
      Box,
      { key: index, height: 1, overflow: "hidden" },
      e(Text, { color: busy ? "gray" : "cyan" }, index === 0 ? prompt : " ".repeat(prompt.length)),
      e(Text, null, line.before),
      e(Text, { inverse: true }, line.selected),
      e(Text, null, line.after),
    )),
  );
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

function renderMessage(message: Message, append: (line: Omit<UiLine, "id">) => number, activeAssistantId?: number): boolean {
  if (message.metadata?.syntheticToolUse === true) return false;
  if (message.role === "progress" || message.isMeta) {
    append(formatMetaMessage(message));
    return true;
  }
  if (message.role === "assistant" && activeAssistantId !== undefined && message.blocks.some((block) => block.type === "text")) {
    return true;
  }

  let rendered = false;
  for (const block of message.blocks) {
    if (block.type === "text") {
      const kind = kindForRole(message.role);
      if (kind === "system" || kind === "meta") append({ kind, title: titleForRole(message.role), text: block.text, previewStyle: "summary" });
      else append({ kind, text: block.text });
      rendered = true;
    }
    if (block.type === "thinking") {
      append({ kind: "thinking", title: "Think", text: block.text, previewStyle: "summary" });
      rendered = true;
    }
    if (block.type === "tool_result") {
      const formatted = formatToolResult(block.name, block.output, block.ok);
      append({
        kind: block.ok ? "tool" : "error",
        title: `Tool result: ${block.name}`,
        text: formatted.text,
        format: formatted.format,
        previewStyle: "summary",
      });
      rendered = true;
    }
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
      streamedOutputTokens: status.streamedOutputTokens + estimateTokens(event.text),
      outputTokenUpdatedAt: Date.now(),
      activityTick: status.activityTick + 1,
    };
  }
  if (event.type === "thinking.delta") return { ...status, activityTick: status.activityTick + 1 };
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

async function handleSessionsCommand(limit: number | undefined, runtime: ReplRuntime, append: (line: Omit<UiLine, "id">) => number) {
  const sessions = await runtime.engine.listSessions(limit ?? 10);
  append(systemLine(formatSessions(sessions)));
}

async function handleResumeCommand(sessionId: string | undefined, runtime: ReplRuntime, append: (line: Omit<UiLine, "id">) => number): Promise<boolean> {
  try {
    const snapshot = await runtime.engine.resumeSession(sessionId);
    append(systemLine(formatResume(snapshot)));
    return true;
  } catch (error) {
    append({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

function initialLines(runtime: ReplRuntime): UiLine[] {
  const session = runtime.engine.snapshot().session;
  const suffix = session
    ? ` Session: ${session.sessionId}${session.resumedMessages > 0 ? ` (${session.resumedMessages} resumed messages)` : ""}.`
    : "";
  return [
    { id: 0, kind: "system", title: "System", text: `Interactive UI enabled. Type /help for commands.${suffix}`, previewStyle: "summary" },
  ];
}

function formatSessions(sessions: readonly SessionSummary[]): string {
  if (sessions.length === 0) return "No saved sessions found.";
  return [
    "Saved sessions:",
    ...sessions.map((session, index) => {
      const updated = session.updatedAt ? ` · ${session.updatedAt}` : "";
      return `${index + 1}. ${session.sessionId}${updated} · ${session.messages} messages · ${session.transcriptPath}`;
    }),
    "Use /resume <session_id> to restore one.",
  ].join("\n");
}

function formatResume(snapshot: SessionStoreSnapshot): string {
  return `resumed session ${snapshot.sessionId}: ${snapshot.resumedMessages} messages from ${snapshot.transcriptPath}`;
}

function colorForKind(kind: UiLine["kind"]) {
  if (kind === "user") return "cyan";
  if (kind === "assistant") return "green";
  if (kind === "thinking") return "gray";
  if (kind === "tool") return "#d4b04c";
  if (kind === "error") return "red";
  if (kind === "meta") return "gray";
  return "white";
}

function prefixForKind(kind: UiLine["kind"]): string {
  if (kind === "user") return "user>";
  if (kind === "assistant") return "assistant>";
  if (kind === "thinking") return "think>";
  if (kind === "tool") return "tool>";
  if (kind === "error") return "error>";
  return "system>";
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
  if (kind === "thinking") return "Think";
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

function formatMetaMessage(message: Message): Omit<UiLine, "id"> {
  const text = message.blocks.map(formatMessageBlockSummary).filter(Boolean).join("\n") || titleForRole(message.role);
  return {
    kind: kindForRole(message.role),
    title: message.metadata?.systemInit ? "System" : titleForRole(message.role),
    text,
    previewStyle: "summary",
  };
}

function systemLine(text: string): Omit<UiLine, "id"> {
  return {
    kind: "system",
    title: "System",
    text,
    previewStyle: "summary",
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
  return {
    kind: "tool",
    title: `Tool call: ${toolUse.name}`,
    text: formatJson(toolUse.input, 1200),
    previewStyle: "summary",
  };
}

function formatMessageBlockSummary(block: Message["blocks"][number]): string {
  if (block.type === "text") return block.text;
  if (block.type === "thinking") return block.text;
  if (block.type === "tool_use") return `Tool call: ${block.name}\n${formatJson(block.input, 1200)}`;
  if (block.type === "tool_result") return `Tool result: ${block.name}\n${formatJson(block.output, 1200)}`;
  return "";
}

function formatJson(value: unknown, maxLength: number): string {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return truncate(text ?? "", maxLength);
}

function formatToolResult(toolName: string, output: unknown, ok: boolean): { text: string; format?: UiLine["format"] } {
  if (isExecOutput(output)) {
    const status = output.timedOut
      ? "timed out"
      : output.exitCode === 0
        ? "exit 0"
        : `exit ${output.exitCode ?? output.signal ?? "unknown"}`;
    const sections = [
      `${toolName} · ${status} · ${output.durationMs}ms`,
      `$ ${output.command}`,
    ];
    if (output.stdout) sections.push("stdout:", output.stdout.replace(/\s+$/u, ""));
    if (output.stderr) sections.push("stderr:", output.stderr.replace(/\s+$/u, ""));
    if (!output.stdout && !output.stderr) sections.push(ok ? "no output" : "no captured output");
    return { text: sections.join("\n"), format: "ansi" };
  }

  if (typeof output === "string" && hasAnsi(output)) {
    return { text: `${toolName}\n${output}`, format: "ansi" };
  }

  if (toolName === "list" && isRecord(output)) {
    return { text: formatListToolResult(output, ok) };
  }

  if (toolName === "read" && isRecord(output)) {
    return { text: formatReadToolResult(output, ok) };
  }

  return { text: `${toolName}${ok ? "" : " · failed"}\n${formatJson(output, 6000)}` };
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

  const lines = [`list · ${ok ? typeValue : "failed"}`];
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
  const startLine = typeof output.startLine === "number" ? output.startLine : undefined;
  const endLine = typeof output.endLine === "number" ? output.endLine : undefined;
  const totalLines = typeof output.totalLines === "number" ? output.totalLines : undefined;
  const content = typeof output.content === "string" ? output.content : "";
  const lines = [`read${ok ? "" : " · failed"}`];
  if (startLine !== undefined && endLine !== undefined && totalLines !== undefined) {
    lines.push(`lines ${startLine}-${endLine} of ${totalLines}`);
  }
  if (content) lines.push(content);
  return lines.join("\n");
}

function renderContext(metrics: ContextMetrics | undefined): string {
  if (!metrics) return "unknown";
  if (!metrics.contextWindowTokens) return `${compactNumber(metrics.estimatedInputTokens)}/?`;
  const percent = metrics.contextUsageRatio === undefined ? "?" : `${(metrics.contextUsageRatio * 100).toFixed(1)}%`;
  return `${compactNumber(metrics.estimatedInputTokens)}/${compactNumber(metrics.contextWindowTokens)} ${percent}`;
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

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}

function statusActivityPixel(phase: string, tick: number): string {
  if (!isActivePhase(phase)) return "  ";
  return PIXEL_BLOCK_FRAMES[tick % PIXEL_BLOCK_FRAMES.length];
}

function phaseLabelForStatus(phase: string): string {
  if (phase === "calling_model") return "model";
  if (phase === "running_tools") return "tools";
  if (phase === "injecting_context") return "context";
  return phase;
}

function isActivePhase(phase: string): boolean {
  return phase === "running" ||
    phase === "preparing" ||
    phase === "calling_model" ||
    phase === "running_tools" ||
    phase === "compacting" ||
    phase === "injecting_context";
}

function phaseColor(phase: string): string {
  if (phase === "ready") return "green";
  if (phase === "stopped") return "yellow";
  if (phase === "failed") return "red";
  if (phase === "running_tools") return "#d4b04c";
  if (phase === "compacting" || phase === "injecting_context") return "magenta";
  return "cyan";
}


function compactNumber(value: number | undefined): string {
  if (value === undefined) return "?";
  const rounded = Math.max(0, Math.round(value));
  if (rounded >= 1_000_000) return `${trimFixed(rounded / 1_000_000)}m`;
  if (rounded >= 10_000) return `${Math.round(rounded / 1000)}k`;
  if (rounded >= 1000) return `${trimFixed(rounded / 1000)}k`;
  return String(rounded);
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
  const rows = stdout.rows ?? 30;
  return Math.max(8, rows - 1);
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
  return busy ? "working> " : "agent> ";
}

function estimatePromptHeight(text: string, cursor: number, terminalWidth: number, prompt: string): number {
  return promptTextView(text, cursor, terminalWidth, prompt).length;
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
  return Math.max(10, columns - 16);
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

const STATUS_BAR_ROWS = 2;
const MESSAGE_VIEWPORT_PADDING_ROWS = 1;
const REPL_ANIMATION_INTERVAL_MS = 420;
const TOKEN_PULSE_MS = 900;
const STATUS_BLINK_TICKS = 2;
const PIXEL_BLOCK_FRAMES = ["  ", "▌ ", "█ ", "█▌", "██", "▐█", " █", " ▐"];
const STATUS_SEPARATOR = " ";
const SUMMARY_BLOCK = {
  maxLines: 6,
  detailIndent: "    ",
};

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
