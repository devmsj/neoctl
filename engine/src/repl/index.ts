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
import { MarkdownText } from "./markdown-renderer.js";
import type { AgentEvent, ContextMetrics } from "../types/events.js";
import type { Message } from "../types/messages.js";

const e = React.createElement;

interface ReplRuntime {
  engine: QueryEngine;
  communicationLogger: CommunicationLogger;
}

interface UiLine {
  id: number;
  kind: "system" | "user" | "assistant" | "tool" | "error" | "meta";
  text: string;
  format?: "markdown" | "ansi";
}

interface UiStatus {
  phase: string;
  detail?: string;
  metrics?: ContextMetrics;
  usage?: ModelUsage;
  streamedOutputTokens: number;
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
      resume: process.env.AGENT_SESSION_RESUME === "1",
      toolResultThresholdChars: process.env.AGENT_TOOL_RESULT_THRESHOLD_CHARS
        ? Number(process.env.AGENT_TOOL_RESULT_THRESHOLD_CHARS)
        : undefined,
    },
  });
  await engine.initialize();
  return { engine, communicationLogger };
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
  const [status, setStatus] = useState<UiStatus>({ phase: "ready", streamedOutputTokens: 0 });

  const append = (line: Omit<UiLine, "id">) => {
    const id = ++lineId.current;
    setLines((current) => [...current, { id, ...line }].slice(-120));
    return id;
  };

  const updateLine = (id: number, updater: (text: string) => string) => {
    setLines((current) => current.map((line) => line.id === id ? { ...line, text: updater(line.text) } : line));
  };

  const handleEvent = (event: AgentEvent) => {
    setStatus((current) => reduceStatus(current, event));
    if (event.type === "state") {
      append({ kind: "meta", text: `[${event.phase}]${event.detail ? ` ${event.detail}` : ""}` });
      return;
    }
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
      append({ kind: "tool", text: `${figures.pointerSmall} ${event.toolUse.name} started ${formatJson(event.toolUse.input, 800)}` });
      return;
    }
    if (event.type === "tool.finished") {
      append({ kind: event.ok ? "tool" : "error", text: `${event.ok ? figures.tick : figures.cross} ${event.toolUse.name} ${event.ok ? "ok" : "failed"}` });
      return;
    }
    if (event.type === "retrying") {
      append({ kind: "meta", text: `retrying model request: attempt ${event.attempt}, delay ${event.delayMs}ms, ${event.error.message}` });
      return;
    }
    if (event.type === "terminal") {
      assistantLineId.current = undefined;
      append({ kind: "meta", text: `[stopped] ${event.reason}${event.detail ? `: ${event.detail}` : ""}` });
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
    await handleCommandOrPrompt(text);
  };

  const handleCommandOrPrompt = async (text: string) => {
    const command = parseReplCommand(text);
    if (command.type === "exit") {
      app.exit();
      return;
    }
    if (command.type === "help") {
      append({ kind: "system", text: helpText });
      return;
    }
    if (command.type === "reset") {
      runtime.engine.reset();
      append({ kind: "system", text: "transcript reset" });
      return;
    }
    if (command.type === "state") {
      append({ kind: "system", text: JSON.stringify({ ...runtime.engine.snapshot(), communicationLog: runtime.communicationLogger.snapshot() }, null, 2) });
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
    setStatus((current) => ({ ...current, phase: "running", detail: "request in progress", streamedOutputTokens: 0 }));
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
  }, [runtime]);

  useInput((value, key) => {
    if (key.ctrl && value === "c") {
      if (busy) {
        const controller = activeAbortController.current;
        if (controller && !controller.signal.aborted && !interruptArmed.current) {
          interruptArmed.current = true;
          controller.abort("Interrupted by Ctrl+C");
          append({ kind: "meta", text: "interrupt requested; press Ctrl+C again to exit" });
          setStatus((current) => ({ ...current, phase: "stopped", detail: "interrupt requested" }));
          return;
        }
      }
      app.exit();
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
    e(MessageList, { lines }),
    e(StatusBar, { status, logging: runtime.communicationLogger.snapshot().enabled }),
    e(PromptLine, { text: input, cursor, busy }),
  );
}

function Header({ runtime }: { runtime: ReplRuntime }) {
  const session = runtime.engine.snapshot().session;
  return e(
    Box,
    { flexDirection: "column", marginBottom: 1 },
    e(Text, { bold: true }, "Agent Scaffold REPL"),
    e(Text, { color: "gray" }, `Type /help for commands.${session ? ` Session: ${session.transcriptPath}` : ""}`),
  );
}

function MessageList({ lines }: { lines: UiLine[] }) {
  const contentWidth = Math.max(40, (stdout.columns ?? 100) - 16);
  return e(
    Box,
    { flexDirection: "column" },
    ...lines.slice(-60).map((line) =>
      e(Box, { key: line.id, flexDirection: "row" },
        e(Text, { color: colorForKind(line.kind) }, `${prefixForKind(line.kind)} `),
        e(Box, { flexDirection: "column", width: contentWidth }, ...renderDisplayText(line, contentWidth)),
      ),
    ),
  );
}

function renderDisplayText(line: UiLine, width: number): React.ReactNode[] {
  if (line.format === "ansi") return renderAnsiBlock(line.text, width);
  return [e(MarkdownText, { key: `markdown-${line.id}`, text: line.text, kind: line.kind, width })];
}

function renderAnsiBlock(text: string, width: number): React.ReactNode[] {
  const lines = wrapAnsi(text, Math.max(10, width), { hard: true, trim: false }).split("\n");
  return lines.map((line, index) => e(Text, { key: `ansi-${index}` }, ...renderAnsiInline(line)));
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

function StatusBar({ status, logging }: { status: UiStatus; logging: boolean }) {
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
  const detail = detailWidth > 0 ? ` | ${fixed(status.detail ?? "", detailWidth, "left")}` : "";
  const line = fitToWidth(`${fixedPrefix}${detail}`, width);
  return e(
    Box,
    { marginTop: 1, width },
    e(Text, { inverse: true }, line),
  );
}

function PromptLine({ text, cursor, busy }: { text: string; cursor: number; busy: boolean }) {
  const before = text.slice(0, cursor);
  const selected = text[cursor] ?? " ";
  const after = text.slice(cursor + 1);
  return e(
    Box,
    null,
    e(Text, { color: busy ? "gray" : "cyan" }, busy ? "busy> " : "agent> "),
    e(Text, null, before),
    e(Text, { inverse: true }, selected),
    e(Text, null, after),
  );
}

async function handleLogCommand(
  command: Extract<ReturnType<typeof parseReplCommand>, { type: "log" }>,
  runtime: ReplRuntime,
  append: (line: Omit<UiLine, "id">) => number,
) {
  if (command.off) {
    runtime.communicationLogger.setDirectory(undefined);
    append({ kind: "system", text: "model communication logging disabled" });
    return;
  }
  if (!command.path || !path.isAbsolute(command.path)) {
    append({ kind: "error", text: "usage: /log <absolute-directory> or /log off" });
    return;
  }
  await fs.mkdir(command.path, { recursive: true });
  runtime.communicationLogger.setDirectory(command.path);
  append({ kind: "system", text: `model communication logs: ${path.resolve(command.path)}` });
}

function renderMessage(message: Message, append: (line: Omit<UiLine, "id">) => number, activeAssistantId?: number) {
  if (message.role === "assistant" && activeAssistantId !== undefined && message.blocks.some((block) => block.type === "text")) {
    for (const block of message.blocks) {
      if (block.type === "tool_use") append({ kind: "tool", text: `${block.name} ${formatJson(block.input, 1200)}` });
    }
    return;
  }
  for (const block of message.blocks) {
    if (block.type === "text") append({ kind: message.isMeta ? "meta" : kindForRole(message.role), text: block.text });
    if (block.type === "thinking") append({ kind: "meta", text: `thinking: ${block.text}` });
    if (block.type === "tool_use") append({ kind: "tool", text: `${block.name} ${formatJson(block.input, 1200)}` });
    if (block.type === "tool_result") {
      const formatted = formatToolResult(block.name, block.output, block.ok);
      append({ kind: block.ok ? "tool" : "error", text: formatted.text, format: formatted.format });
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
    };
  }
  if (event.type === "context.metrics") return { ...status, metrics: event.metrics };
  if (event.type === "usage") return { ...status, usage: event.usage };
  if (event.type === "assistant.delta") return { ...status, streamedOutputTokens: status.streamedOutputTokens + estimateTokens(event.text) };
  if (event.type === "terminal") return { ...status, phase: "stopped", detail: event.reason };
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
  if (session) console.log(`Session transcript: ${session.transcriptPath}`);

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
  return [
    { id: 0, kind: "system", text: "Interactive UI enabled. Type /help for commands." },
    ...(session ? [{ id: -1, kind: "meta" as const, text: `Session transcript: ${session.transcriptPath}` }] : []),
  ];
}

function colorForKind(kind: UiLine["kind"]) {
  if (kind === "user") return "cyan";
  if (kind === "assistant") return "green";
  if (kind === "tool") return "yellow";
  if (kind === "error") return "red";
  if (kind === "meta") return "gray";
  return "white";
}

function prefixForKind(kind: UiLine["kind"]): string {
  if (kind === "user") return "user>";
  if (kind === "assistant") return "assistant>";
  if (kind === "tool") return "tool>";
  if (kind === "error") return "error>";
  if (kind === "meta") return "meta>";
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
      `${toolName}> ${status} (${output.durationMs}ms)`,
      `$ ${output.command}`,
    ];
    if (output.stdout) sections.push("stdout:", output.stdout.replace(/\s+$/u, ""));
    if (output.stderr) sections.push("stderr:", output.stderr.replace(/\s+$/u, ""));
    if (!output.stdout && !output.stderr) sections.push(ok ? "no output" : "no captured output");
    return { text: sections.join("\n"), format: "ansi" };
  }

  if (typeof output === "string" && hasAnsi(output)) {
    return { text: `${toolName}>\n${output}`, format: "ansi" };
  }

  return { text: `${toolName}> ${formatJson(output, 6000)}` };
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
  const columns = stdout.columns ?? 100;
  return Math.max(72, Math.min(columns - 1, 160));
}

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
