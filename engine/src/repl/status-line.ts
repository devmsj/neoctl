import readline from "node:readline";
import type { Writable } from "node:stream";
import type { AgentEvent, ContextMetrics } from "../types/events.js";
import type { ModelUsage } from "../model/model-gateway.js";

export class ReplStatusLine {
  private phase = "ready";
  private lastDetail = "";
  private metrics?: ContextMetrics;
  private lastUsage?: ModelUsage;
  private outputTokensStreamed = 0;
  private visible = false;

  constructor(private readonly output: Writable & { isTTY?: boolean }) {}

  handle(event: AgentEvent): void {
    if (event.type === "state") {
      this.phase = event.phase;
      this.lastDetail = event.detail ?? "";
      if (event.phase === "preparing") {
        this.lastUsage = undefined;
        this.outputTokensStreamed = 0;
      }
    }
    if (event.type === "context.metrics") {
      this.metrics = event.metrics;
    }
    if (event.type === "assistant.delta") {
      this.outputTokensStreamed += estimateDeltaTokens(event.text);
    }
    if (event.type === "usage") {
      this.lastUsage = event.usage;
    }
    if (event.type === "terminal") {
      this.phase = "stopped";
      this.lastDetail = event.reason;
    }
  }

  clear(): void {
    if (!this.visible || !this.output.isTTY) return;
    readline.clearLine(this.output, 0);
    readline.cursorTo(this.output, 0);
    this.visible = false;
  }

  render(): void {
    if (!this.output.isTTY) return;
    const line = this.renderLine();
    readline.clearLine(this.output, 0);
    readline.cursorTo(this.output, 0);
    this.output.write(line);
    this.visible = true;
  }

  renderLine(): string {
    const input = this.lastUsage?.inputTokens ?? this.metrics?.estimatedInputTokens;
    const output = this.lastUsage?.outputTokens ?? this.outputTokensStreamed;
    const context = renderContext(this.metrics);
    const model = this.metrics?.model ?? "model?";
    const source = this.metrics?.contextWindowSource ?? "unknown";
    const detail = this.lastDetail ? ` ${this.lastDetail}` : "";
    const width = terminalWidth(this.output);
    const fixedPrefix = [
      statusIndicator(this.phase),
      fixed(phaseLabel(this.phase), 10, "left"),
      `MDL ${fixed(truncateMiddle(model, 20), 20, "left")}`,
      `IN ${fixed(formatCompact(input), 7, "left")}`,
      `OUT ${fixed(formatCompact(output), 7, "left")}`,
      `CTX ${fixed(context, 20, "left")}`,
      `SRC ${fixed(source, 7, "left")}`,
    ].join(" | ");
    return fitToWidth(`${fixedPrefix}${detail}`, width);
  }
}

function renderContext(metrics: ContextMetrics | undefined): string {
  if (!metrics) return "unknown";
  const used = formatCompact(metrics.estimatedInputTokens);
  if (!metrics.contextWindowTokens) return `${used}/?`;
  const window = formatCompact(metrics.contextWindowTokens);
  const percent = metrics.contextUsageRatio === undefined ? "?" : `${(metrics.contextUsageRatio * 100).toFixed(1)}%`;
  return `${used}/${window} ${percent}`;
}

function estimateDeltaTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

function formatCompact(value: number | undefined): string {
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

function terminalWidth(output: Writable & { columns?: number }): number {
  return Math.max(72, Math.min(output.columns ?? 100, 160)) - 1;
}

function statusIndicator(phase: string): string {
  if (phase === "ready") return "[=]";
  if (phase === "calling_model") return "[>]";
  if (phase === "running_tools") return "[*]";
  if (phase === "compacting") return "[#]";
  if (phase === "preparing") return "[.]";
  if (phase === "injecting_context") return "[+]";
  if (phase === "stopped") return "[-]";
  if (phase === "failed") return "[x]";
  return "[~]";
}

function phaseLabel(phase: string): string {
  if (phase === "calling_model") return "model";
  if (phase === "running_tools") return "tools";
  if (phase === "injecting_context") return "context";
  return phase;
}

function fixed(value: string, width: number, align: "left" | "right" = "right"): string {
  const clipped = value.length > width ? value.slice(0, width) : value;
  return align === "left" ? clipped.padEnd(width, " ") : clipped.padStart(width, " ");
}

function fitToWidth(value: string, width: number): string {
  if (value.length === width) return value;
  if (value.length > width) return value.slice(0, width);
  return value.padEnd(width, " ");
}

function truncateMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  if (maxLength <= 3) return value.slice(0, maxLength);
  const left = Math.ceil((maxLength - 3) / 2);
  const right = Math.floor((maxLength - 3) / 2);
  return `${value.slice(0, left)}...${value.slice(value.length - right)}`;
}
