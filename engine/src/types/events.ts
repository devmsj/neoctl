import type { CompactionReport } from "../context/compaction.js";
import type { TerminalReason } from "../core/state.js";
import type { ModelUsage } from "../model/model-gateway.js";
import type { Message, ToolUseRequest } from "./messages.js";

export interface PromptCacheSectionMetric {
  name: string;
  cacheStable: boolean;
  estimatedTokens: number;
  chars: number;
  hash: string;
}

export interface PromptCacheDiagnostics {
  systemPromptHash: string;
  stableSystemPromptHash: string;
  dynamicSystemPromptHash: string;
  toolDefinitionsHash: string;
  stablePrefixHash: string;
  promptCacheKey: string;
  messagePrefixHash: string;
  implicitBreakpointIndex?: number;
  implicitBreakpointHash?: string;
  priorImplicitBreakpointHash?: string;
  promptSections: PromptCacheSectionMetric[];
  stablePromptTokens: number;
  dynamicPromptTokens: number;
  toolDefinitionTokens: number;
  cacheablePrefixTokens: number;
}

export interface ContextMetrics {
  model?: string;
  estimatedInputTokens: number;
  estimatedChars: number;
  messageCount: number;
  toolCount: number;
  contextWindowTokens?: number;
  contextWindowSource: "session" | "env" | "known" | "unknown";
  contextUsageRatio?: number;
  cacheDiagnostics?: PromptCacheDiagnostics;
  modelMetadata?: {
    id: string;
    provider: string;
    maxOutputTokens?: number;
    knowledgeCutoff?: string;
    reasoning?: boolean;
    imageInput?: boolean;
    source?: string;
  };
}

export type AgentEvent =
  | { type: "state"; phase: string; detail?: string }
  | { type: "context.metrics"; metrics: ContextMetrics }
  | { type: "context.compacted"; compaction: CompactionReport }
  | { type: "assistant.delta"; text: string }
  | { type: "thinking.delta"; text: string }
  | { type: "tool_call.delta"; callId: string; name?: string; argumentsDelta: string }
  | { type: "message"; message: Message }
  | { type: "tool.started"; toolUse: ToolUseRequest }
  | { type: "tool.finished"; toolUse: ToolUseRequest; ok: boolean }
  | { type: "usage"; usage: ModelUsage }
  | { type: "retrying"; attempt: number; delayMs: number; error: Error }
  | { type: "terminal"; reason: TerminalReason; detail?: string }
  | { type: "error"; error: Error };
