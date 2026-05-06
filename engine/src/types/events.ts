import type { TerminalReason } from "../core/state.js";
import type { ModelUsage } from "../model/model-gateway.js";
import type { Message, ToolUseRequest } from "./messages.js";

export interface ContextMetrics {
  model?: string;
  estimatedInputTokens: number;
  estimatedChars: number;
  messageCount: number;
  toolCount: number;
  contextWindowTokens?: number;
  contextWindowSource: "env" | "known" | "unknown";
  contextUsageRatio?: number;
  modelMetadata?: {
    id: string;
    provider: string;
    maxOutputTokens?: number;
    knowledgeCutoff?: string;
    reasoning?: boolean;
    source?: string;
  };
}

export type AgentEvent =
  | { type: "state"; phase: string; detail?: string }
  | { type: "context.metrics"; metrics: ContextMetrics }
  | { type: "assistant.delta"; text: string }
  | { type: "thinking.delta"; text: string }
  | { type: "message"; message: Message }
  | { type: "tool.started"; toolUse: ToolUseRequest }
  | { type: "tool.finished"; toolUse: ToolUseRequest; ok: boolean }
  | { type: "usage"; usage: ModelUsage }
  | { type: "retrying"; attempt: number; delayMs: number; error: Error }
  | { type: "terminal"; reason: TerminalReason; detail?: string }
  | { type: "error"; error: Error };
