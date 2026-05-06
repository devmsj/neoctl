#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { stdin, stdout } from "node:process";
import React, { useEffect, useRef, useState } from "react";
import { Box, Text, render, useApp, useInput } from "ink";
import figures from "figures";
import stripAnsi from "strip-ansi";
import wrapAnsi from "wrap-ansi";
import { QueryEngine } from "../core/query-engine.js";
import type { SessionStoreSnapshot, SessionSummary } from "../session/session-store.js";
import { createModelGatewayFromEnv, loadDotEnvIfPresent } from "../model/env.js";
import { readModelProviderConfig } from "../model/config.js";
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
import { renderEvent } from "./render.js";
import { ReplStatusLine } from "./status-line.js";
import { estimateMarkdownLineCount, MarkdownText } from "./markdown-renderer.js";
import type { AgentEvent, ContextMetrics } from "../types/events.js";
import type { Message, ToolUseRequest } from "../types/messages.js";

const e = React.createElement;

interface ReplRuntime {
  engine: QueryEngine;
  communicationLogger: CommunicationLogger;
}

interface UiLine {
  id: number;
  kind: "system" | "user" | "assistant" | "tool" | "error" | "meta";
  text: string;
  title?: string;
  format?: "markdown" | "ansi";
  previewStyle?: "summary";
}

interface UiStatus {
  phase: string;
  detail?: string;
  metrics?: ContextMetrics;
  usage?: ModelUsage;
  streamedOutputTokens: number;
  activityTick: number;
}

async function main(): Promise<void> {
  const runtime = await createRuntime();
  if (!stdin.isTTY || process.env.AGENT_REPL_LEGACY === "1") {
    await runLineRepl(runtime);
    return;
  }

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
  return { engine, communicationLogger };
}

function parseResumeFlag(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "latest"].includes(value.toLowerCase());
}

function InkRepl({ runtime }: { runtime: ReplRuntime }) {
  const app = useApp();
  const lineId = useRef(0);
  const assistantLineId = useRef<number | undefined>(undefined);
  const activeAbortController = useRef<AbortController | undefined>(undefined);
  const interruptArmed = useRef(false);
  const history = useRef<string[]>([]);
  const [lines, setLines] = useState<UiLine[]>(() => initialLines(runtime));
  const [input, setInput] = useState("");
  const [cursor, setCursor] = useState(0);
  const [historyIndex, setHistoryIndex] = useState<number | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<UiStatus>({ phase: "ready", streamedOutputTokens: 0, activityTick: 0 });
  const [scrollOffset, setScrollOffset] = useState(0);

  const append = (line: Omit<UiLine, "id">) => {
    const id = ++lineId.current;
    setLines((current) => [...current, { id, ...line }].slice(-MAX_UI_LINES));
    return id;
  };

  const updateLine = (id: number, updater: (text: string) => string) => {
    setLines((current) => current.map((line) => line.id === id ? { ...line, text: updater(line.text) } : line));
  };

  const handleEvent = (event: AgentEvent) => {
    setStatus((current) => reduceStatus(current, event));
    if (event.type === "state") return;
    if (event.type === "context.metrics" || event.type === "usage") return;
    if (event.type === "assistant.delta") {
      const id = assistantLineId.current ?? append({ kind: "assistant", text: "" });
      assistantLineId.current = id;
      updateLine(id, (text) => text + event.text);
      return;
    }
    if (event.type === "message") {
      renderMessage(event.message, append, assistantLineId.current);
      return;
    }
    if (event.type === "tool.started") {
      append(formatToolUse(event.toolUse));
      return;
    }
    if (event.type === "tool.finished") return;
    if (event.type === "retrying") return;
    if (event.type === "terminal") {
      assistantLineId.current = undefined;
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
      await handleResumeCommand(command.sessionId, runtime, (line) => append(line));
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
    setStatus((current) => ({ ...current, phase: "running", detail: "working", streamedOutputTokens: 0 }));
    try {
      for await (const event of runtime.engine.sendUserText(command.text, { abortSignal: abortController.signal })) {
        handleEvent(event);
      }
    } catch (error) {
      append({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      if (activeAbortController.current === abortController) activeAbortController.current = undefined;
      interruptArmed.current = false;
      assistantLineId.current = undefined;
      setBusy(false);
      setStatus((current) => ({ ...current, phase: "ready", detail: undefined }));
    }
  };

  useEffect(() => {
    setLines(initialLines(runtime));
    setScrollOffset(0);
  }, [runtime]);

  const width = terminalColumns();
  const messageViewportHeight = Math.max(1, terminalRows() - UI_FIXED_ROWS);
  const contentWidth = Math.max(40, width - 16);
  const toolWidth = Math.max(40, width - 2);
  const maxScrollOffset = maxScrollForLines(lines, messageViewportHeight, contentWidth, toolWidth);
  const effectiveScrollOffset = Math.min(scrollOffset, maxScrollOffset);
  const scrollPage = Math.max(1, messageViewportHeight - 1);

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
    e(Header, { runtime }),
    e(MessageList, { lines, height: scrollOffset > 0 ? messageViewportHeight : undefined, scrollOffset: effectiveScrollOffset }),
    e(StatusBar, { status, logging: runtime.communicationLogger.snapshot().enabled, scrollOffset: effectiveScrollOffset, maxScrollOffset }),
    e(PromptLine, { text: input, cursor, busy, activityTick: status.activityTick }),
  );
}

function Header({ runtime }: { runtime: ReplRuntime }) {
  const session = runtime.engine.snapshot().session;
  const width = Math.max(1, terminalColumns() - 1);
  const sessionText = session ? ` Session: ${truncateMiddle(session.transcriptPath, Math.max(10, width - 34))}` : "";
  return e(
    Box,
    { flexDirection: "column", marginBottom: 1 },
    e(Text, { bold: true }, fitToWidth("Agent Scaffold REPL", width)),
    e(Text, { color: "gray" }, fitToWidth(`Type /help for commands.${sessionText}`, width)),
  );
}

function MessageList({ lines, height, scrollOffset }: { lines: UiLine[]; height?: number; scrollOffset: number }) {
  const width = terminalColumns();
  const contentWidth = Math.max(40, width - 16);
  const visible = height === undefined
    ? lines.map((line) => ({ line, maxLines: undefined, skipTop: 0 }))
    : selectVisibleLines(lines, height, contentWidth, Math.max(40, width - 2), scrollOffset);
  return e(
    Box,
    { flexDirection: "column", ...(height === undefined ? {} : { height, overflow: "hidden" }) },
    ...visible.map((entry) => {
      const line = entry.line;
      if (line.previewStyle === "summary") {
        const toolWidth = Math.max(40, width - 2);
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
    const displayWidth = line.kind === "tool" ? toolWidth : contentWidth;
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
  return lines.reduce((total, line) => total + estimateUiLineHeight(line, line.kind === "tool" ? toolWidth : contentWidth), 0);
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

function StatusBar({ status, logging, scrollOffset, maxScrollOffset }: { status: UiStatus; logging: boolean; scrollOffset: number; maxScrollOffset: number }) {
  const width = statusBarWidth();
  const model = fixed(truncateMiddle(status.metrics?.model ?? "model?", 20), 20, "left");
  const inputTokens = status.usage?.inputTokens ?? status.metrics?.estimatedInputTokens;
  const outputTokens = status.usage?.outputTokens ?? status.streamedOutputTokens;
  const phase = status.phase;
  const indicator = fixed(statusIndicator(phase), 3);
  const phaseLabel = fixed(phaseLabelForStatus(phase), 10, "left");
  const up = fixed(compactNumber(inputTokens), 7, "left");
  const down = fixed(compactNumber(outputTokens), 7, "left");
  const ctx = fixed(renderContext(status.metrics), 20, "left");
  const log = logging ? "LOG:on " : "LOG:off";
  const fixedPrefix = `${indicator} ${phaseLabel} | MDL ${model} | IN ${up} | OUT ${down} | CTX ${ctx} | ${log}`;
  const detailWidth = Math.max(0, width - fixedPrefix.length - 3);
  const scrollDetail = scrollOffset > 0 ? `scroll ${scrollOffset}/${maxScrollOffset} PgUp/PgDn Ctrl+End` : undefined;
  const detail = detailWidth > 0 ? ` | ${fixed(scrollDetail ?? status.detail ?? "", detailWidth, "left")}` : "";
  const line = fitToWidth(`${fixedPrefix}${detail}`, width);
  return e(
    Box,
    { marginTop: 1, width },
    e(Text, { inverse: true }, line),
  );
}

function PromptLine({ text, cursor, busy, activityTick }: { text: string; cursor: number; busy: boolean; activityTick: number }) {
  const frame = activityTick % WORKING_FRAMES.length;
  const prompt = busy ? `working${WORKING_FRAMES[frame]}> ` : "agent> ";
  const view = promptTextView(text, cursor, Math.max(1, terminalColumns() - prompt.length));
  return e(
    Box,
    { height: 1, overflow: "hidden" },
    e(Text, { color: busy ? "gray" : "cyan" }, prompt),
    e(Text, null, view.before),
    e(Text, { inverse: true }, view.selected),
    e(Text, null, view.after),
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

function renderMessage(message: Message, append: (line: Omit<UiLine, "id">) => number, activeAssistantId?: number) {
  if (message.metadata?.syntheticToolUse === true) return;
  if (message.role === "progress" || message.isMeta) {
    append(formatMetaMessage(message));
    return;
  }
  if (message.role === "assistant" && activeAssistantId !== undefined && message.blocks.some((block) => block.type === "text")) {
    return;
  }
  for (const block of message.blocks) {
    if (block.type === "text") {
      const kind = kindForRole(message.role);
      if (kind === "system" || kind === "meta") append({ kind, title: titleForRole(message.role), text: block.text, previewStyle: "summary" });
      else append({ kind, text: block.text });
    }
    if (block.type === "thinking") continue;
    if (block.type === "tool_result") {
      const formatted = formatToolResult(block.name, block.output, block.ok);
      append({
        kind: block.ok ? "tool" : "error",
        title: `Tool result: ${block.name}`,
        text: formatted.text,
        format: formatted.format,
        previewStyle: "summary",
      });
    }
  }
}

function reduceStatus(status: UiStatus, event: AgentEvent): UiStatus {
  if (event.type === "state") {
    return {
      ...status,
      phase: event.phase,
      detail: event.detail,
      usage: event.phase === "preparing" ? undefined : status.usage,
      streamedOutputTokens: event.phase === "preparing" ? 0 : status.streamedOutputTokens,
      activityTick: status.activityTick + 1,
    };
  }
  if (event.type === "context.metrics") return { ...status, metrics: event.metrics };
  if (event.type === "usage") return { ...status, usage: event.usage, activityTick: status.activityTick + 1 };
  if (event.type === "assistant.delta") return { ...status, streamedOutputTokens: status.streamedOutputTokens + estimateTokens(event.text), activityTick: status.activityTick + 1 };
  if (event.type === "terminal") return { ...status, phase: "stopped", detail: event.reason, activityTick: status.activityTick + 1 };
  if (event.type === "message" || event.type === "tool.started" || event.type === "tool.finished" || event.type === "retrying" || event.type === "error") {
    return { ...status, activityTick: status.activityTick + 1 };
  }
  return status;
}

async function runLineRepl(runtime: ReplRuntime): Promise<void> {
  const rl = readline.createInterface({ input: stdin, output: stdout, prompt: "agent> " });
  const statusLine = new ReplStatusLine(stdout);
  let activeAbortController: AbortController | undefined;
  let interruptArmed = false;
  let shouldExit = false;
  console.log("Agent Scaffold REPL");
  console.log("Type /help for commands.");
  const session = runtime.engine.snapshot().session;
  if (session) {
    console.log(`Session transcript: ${session.transcriptPath}`);
    if (session.resumedMessages > 0) console.log(`Resumed ${session.resumedMessages} messages from ${session.sessionId}.`);
  }

  rl.on("SIGINT", () => {
    if (activeAbortController) {
      if (!activeAbortController.signal.aborted && !interruptArmed) {
        interruptArmed = true;
        activeAbortController.abort("Interrupted by Ctrl+C");
        statusLine.clear();
        console.log("interrupt requested; press Ctrl+C again to exit");
        return;
      }
      shouldExit = true;
      rl.close();
      return;
    }
    rl.close();
  });

  rl.prompt();

  for await (const line of rl) {
    const command = parseReplCommand(line);
    if (command.type === "exit") break;
    if (command.type === "help") console.log(helpText);
    else if (command.type === "log") await handleLineLogCommand(command, runtime);
    else if (command.type === "sessions") await handleLineSessionsCommand(command.limit, runtime);
    else if (command.type === "resume") await handleLineResumeCommand(command.sessionId, runtime);
    else if (command.type === "reset") {
      runtime.engine.reset();
      console.log("transcript reset");
    } else if (command.type === "state") {
      console.log(JSON.stringify({ ...runtime.engine.snapshot(), communicationLog: runtime.communicationLogger.snapshot() }, null, 2));
    } else if (command.text.trim()) {
      const abortController = new AbortController();
      activeAbortController = abortController;
      interruptArmed = false;
      try {
        for await (const event of runtime.engine.sendUserText(command.text, { abortSignal: abortController.signal })) {
          statusLine.handle(event);
          const rendered = renderEvent(event);
          statusLine.clear();
          if (rendered) console.log(rendered);
          statusLine.render();
        }
      } catch (error) {
        statusLine.clear();
        console.error(error instanceof Error ? error.message : String(error));
      } finally {
        if (activeAbortController === abortController) activeAbortController = undefined;
        interruptArmed = false;
      }
      statusLine.clear();
    }
    if (shouldExit) break;
    rl.prompt();
  }
  rl.close();
}

async function handleSessionsCommand(limit: number | undefined, runtime: ReplRuntime, append: (line: Omit<UiLine, "id">) => number) {
  const sessions = await runtime.engine.listSessions(limit ?? 10);
  append(systemLine(formatSessions(sessions)));
}

async function handleResumeCommand(sessionId: string | undefined, runtime: ReplRuntime, append: (line: Omit<UiLine, "id">) => number) {
  try {
    const snapshot = await runtime.engine.resumeSession(sessionId);
    append(systemLine(formatResume(snapshot)));
  } catch (error) {
    append({ kind: "error", text: error instanceof Error ? error.message : String(error) });
  }
}

async function handleLineSessionsCommand(limit: number | undefined, runtime: ReplRuntime) {
  const sessions = await runtime.engine.listSessions(limit ?? 10);
  console.log(formatSessions(sessions));
}

async function handleLineResumeCommand(sessionId: string | undefined, runtime: ReplRuntime) {
  try {
    const snapshot = await runtime.engine.resumeSession(sessionId);
    console.log(formatResume(snapshot));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
  }
}

async function handleLineLogCommand(command: Extract<ReturnType<typeof parseReplCommand>, { type: "log" }>, runtime: ReplRuntime) {
  if (command.off) {
    runtime.communicationLogger.setDirectory(undefined);
    console.log("model communication logging disabled");
    return;
  }
  if (!command.path || !path.isAbsolute(command.path)) {
    console.log("usage: /log <absolute-directory> or /log off");
    return;
  }
  await fs.mkdir(command.path, { recursive: true });
  runtime.communicationLogger.setDirectory(command.path);
  console.log(`model communication logs: ${path.resolve(command.path)}`);
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
  if (kind === "tool") return "#d4b04c";
  if (kind === "error") return "red";
  if (kind === "meta") return "gray";
  return "white";
}

function prefixForKind(kind: UiLine["kind"]): string {
  if (kind === "user") return "user>";
  if (kind === "assistant") return "assistant>";
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

function renderWrapped(text: string): string {
  return wrapAnsi(text, Math.max(40, (stdout.columns ?? 100) - 16), { hard: true, trim: false });
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

function estimateTokens(text: string): number {
  return text ? Math.max(1, Math.ceil(text.length / 4)) : 0;
}

function formatNumber(value: number | undefined): string {
  return value === undefined ? "?" : new Intl.NumberFormat("en-US").format(Math.round(value));
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}

function statusIndicator(phase: string): string {
  if (phase === "ready") return "[=]";
  if (phase === "calling_model") return "[>]";
  if (phase === "running_tools") return "[*]";
  if (phase === "compacting") return "[#]";
  if (phase === "preparing") return "[.]";
  if (phase === "injecting_context") return "[+]";
  if (phase === "stopped") return "[-]";
  if (phase === "running") return "[*]";
  if (phase === "failed") return "[x]";
  return "[~]";
}

function phaseLabelForStatus(phase: string): string {
  if (phase === "calling_model") return "model";
  if (phase === "running_tools") return "tools";
  if (phase === "injecting_context") return "context";
  return phase;
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

function statusBarWidth(): number {
  const columns = terminalColumns();
  return Math.max(1, Math.min(columns - 1, 160));
}

function terminalRows(): number {
  const rows = stdout.rows ?? 30;
  return Math.max(8, rows - 1);
}

function terminalColumns(): number {
  return stdout.columns ?? 100;
}

function promptTextView(text: string, cursor: number, width: number): { before: string; selected: string; after: string } {
  const normalized = text.replace(/\r?\n/g, " ");
  const safeCursor = Math.max(0, Math.min(cursor, normalized.length));
  const viewWidth = Math.max(1, width);
  if (viewWidth === 1) return { before: "", selected: normalized[safeCursor] ?? " ", after: "" };
  const maxStart = Math.max(0, normalized.length - viewWidth);
  const start = Math.max(0, Math.min(safeCursor - Math.floor(viewWidth / 2), maxStart));
  const end = Math.min(normalized.length, start + viewWidth);
  const visible = normalized.slice(start, end);
  const visibleCursor = safeCursor - start;
  let before = visible.slice(0, visibleCursor);
  const selected = visible[visibleCursor] ?? " ";
  let after = visible.slice(visibleCursor + 1);
  if (start > 0 && before.length > 0) before = `…${before.slice(1)}`;
  if (end < normalized.length && after.length > 0) after = `${after.slice(0, -1)}…`;
  return { before, selected, after };
}

const UI_FIXED_ROWS = 6;
const MAX_UI_LINES = 1000;
const WORKING_FRAMES = [".  ", ".. ", "..."];
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
