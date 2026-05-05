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
    const detail = this.lastDetail ? ` | ${truncate(this.lastDetail, 48)}` : "";
    return `[status] ${this.phase} | ${model} | up ${formatNumber(input)} tok | down ${formatNumber(output)} tok | ctx ${context} (${source})${detail}`;
  }
}

function renderContext(metrics: ContextMetrics | undefined): string {
  if (!metrics) return "unknown";
  if (!metrics.contextWindowTokens) return `${formatNumber(metrics.estimatedInputTokens)}/unknown`;
  const percent = metrics.contextUsageRatio === undefined ? "?" : `${(metrics.contextUsageRatio * 100).toFixed(1)}%`;
  return `${formatNumber(metrics.estimatedInputTokens)}/${formatNumber(metrics.contextWindowTokens)} ${percent}`;
}

function estimateDeltaTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

function formatNumber(value: number | undefined): string {
  if (value === undefined) return "?";
  return new Intl.NumberFormat("en-US").format(Math.round(value));
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}
