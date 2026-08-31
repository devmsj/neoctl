import type { QueryEngine } from "../core/query-engine.js";
import type { TerminalReason } from "../core/state.js";
import type { AgentEvent } from "../types/events.js";
import type { Message } from "../types/messages.js";
import { toDisplayAgentEvent } from "../ui/display-message.js";
import { isModelReasoningArgument, type ModelReasoningArgument } from "./commands.js";

export interface RunCliOptions {
  json: boolean;
  prompt?: string;
  model?: string;
  reasoning?: ModelReasoningArgument;
}

export type RunCliParseResult =
  | { ok: true; options: RunCliOptions }
  | { ok: false; error: string };

export interface RunCommandIo {
  stdout: { write(chunk: string): unknown };
  stderr: { write(chunk: string): unknown };
}

export interface RunCommandResult {
  exitCode: number;
  terminalReason?: TerminalReason;
}

export interface RunPromptInput extends NodeJS.ReadableStream {
  readonly isTTY?: boolean;
}

export function parseRunCliArgs(argv: string[]): RunCliParseResult {
  const options: RunCliOptions = { json: false };
  const promptParts: string[] = [];
  let positionalOnly = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (positionalOnly) {
      promptParts.push(arg);
      continue;
    }
    if (arg === "--") {
      positionalOnly = true;
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--model") {
      const value = argv[++index]?.trim();
      if (!value) return { ok: false, error: "--model requires a model id" };
      options.model = value;
      continue;
    }
    if (arg.startsWith("--model=")) {
      const value = arg.slice("--model=".length).trim();
      if (!value) return { ok: false, error: "--model requires a model id" };
      options.model = value;
      continue;
    }
    if (arg === "--reasoning") {
      const value = argv[++index]?.trim();
      if (!value || !isModelReasoningArgument(value)) return invalidReasoning();
      options.reasoning = value;
      continue;
    }
    if (arg.startsWith("--reasoning=")) {
      const value = arg.slice("--reasoning=".length).trim();
      if (!isModelReasoningArgument(value)) return invalidReasoning();
      options.reasoning = value;
      continue;
    }
    if (arg.startsWith("-")) {
      if (arg === "-") {
        if (promptParts.length > 0) return { ok: false, error: "stdin marker '-' cannot be combined with a prompt argument" };
        promptParts.push(arg);
        positionalOnly = true;
        continue;
      }
      return { ok: false, error: `unknown run option: ${arg}` };
    }
    promptParts.push(arg);
  }

  if (promptParts.length > 0) options.prompt = promptParts.join(" ");
  return { ok: true, options };
}

export function runCliHelpText(binaryName = "neo"): string {
  return [
    `Usage: ${binaryName} run [options] [prompt]`,
    "",
    "Run one agent request without starting the interactive REPL.",
    "If prompt is omitted or is '-', read it from stdin.",
    "",
    "Options:",
    "  --json                    Stream newline-delimited JSON events to stdout",
    "  --model <model-id>        Override the configured model for this run",
    "  --reasoning <effort>      Override reasoning: none|minimal|low|medium|high|xhigh|max|default|off",
    "  --                        Treat all remaining arguments as prompt text",
    "",
    "Examples:",
    `  ${binaryName} run "summarize this repository"`,
    `  "review this diff" | ${binaryName} run --json`,
    `  ${binaryName} run --model gpt-5.6 --reasoning high -- "fix the failing tests"`,
  ].join("\n");
}

export async function readRunPrompt(configuredPrompt: string | undefined, input: RunPromptInput): Promise<string> {
  if (configuredPrompt !== undefined && configuredPrompt !== "-") return requirePrompt(configuredPrompt);
  if (input.isTTY) throw new Error("prompt is required when stdin is a terminal");

  let prompt = "";
  input.setEncoding?.("utf8");
  for await (const chunk of input) prompt += String(chunk);
  return requirePrompt(prompt);
}

export async function executeRunCommand(
  engine: Pick<QueryEngine, "sendUserText">,
  prompt: string,
  options: Pick<RunCliOptions, "json">,
  io: RunCommandIo,
  abortSignal?: AbortSignal,
): Promise<RunCommandResult> {
  let terminalReason: TerminalReason | undefined;
  let sawAssistantDelta = false;
  let wrotePlainText = false;
  let lastAssistantText: string | undefined;

  try {
    for await (const event of engine.sendUserText(prompt, { abortSignal })) {
      if (options.json) {
        io.stdout.write(`${JSON.stringify(toJsonAgentEvent(event))}\n`);
      } else if (event.type === "assistant.delta") {
        sawAssistantDelta = true;
        wrotePlainText = wrotePlainText || event.text.length > 0;
        io.stdout.write(event.text);
      } else if (event.type === "message" && event.message.role === "assistant") {
        lastAssistantText = messageText(event.message) ?? lastAssistantText;
      } else if (event.type === "retrying") {
        io.stderr.write(`retry ${event.attempt} in ${event.delayMs}ms: ${event.error.message}\n`);
      } else if (event.type === "error") {
        io.stderr.write(`${event.error.message}\n`);
      }
      if (event.type === "terminal") terminalReason = event.reason;
    }
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error(String(error));
    if (options.json) io.stdout.write(`${JSON.stringify({ type: "error", error: serializeError(normalized) })}\n`);
    else io.stderr.write(`${normalized.message}\n`);
    return { exitCode: abortSignal?.aborted ? 130 : 1, terminalReason };
  }

  if (!options.json) {
    if (!sawAssistantDelta && lastAssistantText) {
      io.stdout.write(lastAssistantText);
      wrotePlainText = true;
    }
    if (wrotePlainText) io.stdout.write("\n");
  }
  if (abortSignal?.aborted || terminalReason === "aborted_streaming" || terminalReason === "aborted_tools") {
    return { exitCode: 130, terminalReason };
  }
  return { exitCode: terminalReason === "completed" ? 0 : 1, terminalReason };
}

export function toJsonAgentEvent(event: AgentEvent): unknown {
  const displayEvent = toDisplayAgentEvent(event, { imageMode: "metadata-only" });
  if (displayEvent.type === "error" || displayEvent.type === "retrying") {
    return { ...displayEvent, error: serializeError(displayEvent.error) };
  }
  return displayEvent;
}

function invalidReasoning(): RunCliParseResult {
  return { ok: false, error: "--reasoning requires one of: none, minimal, low, medium, high, xhigh, max, default, off" };
}

function requirePrompt(prompt: string): string {
  const normalized = prompt.trim();
  if (!normalized) throw new Error("prompt must not be empty");
  return normalized;
}

function messageText(message: Message): string | undefined {
  const text = message.blocks.filter((block) => block.type === "text").map((block) => block.text).join("");
  return text || undefined;
}

function serializeError(error: Error): { name: string; message: string; stack?: string } {
  return { name: error.name, message: error.message, stack: error.stack };
}
