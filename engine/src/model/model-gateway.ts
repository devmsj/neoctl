import type { Message, ToolUseRequest } from "../types/messages.js";
import { createTextMessage } from "../types/messages.js";
import type { ToolDefinition } from "../tools/tool.js";

export interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  cachedTokens?: number;
  raw?: unknown;
}

export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ReasoningConfig {
  effort?: ReasoningEffort;
  summary?: "auto" | "concise" | "detailed";
}

export interface TextFormat {
  type: "json_schema" | "text" | "json_object";
  name?: string;
  schema?: Record<string, unknown>;
  strict?: boolean;
}

export interface ModelRequest {
  model?: string;
  messages: readonly Message[];
  systemPrompt?: string;
  instructions?: string;
  tools: readonly ToolDefinition[];
  toolChoice?: "auto" | "none" | "required" | { type: "function"; name: string };
  maxOutputTokens?: number;
  reasoning?: ReasoningConfig | null;
  textFormat?: TextFormat;
  metadata?: Record<string, string>;
  previousResponseId?: string;
  stream: boolean;
  timeoutMs?: number;
  queryOrigin?: string;
  serviceTier?: "auto" | "default" | "flex" | "priority" | "fast";
  cancellation?: AbortSignal;
  providerOptions?: Record<string, unknown>;
}

export type ModelStreamEvent =
  | { type: "assistant_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "assistant_message"; message: Message }
  | { type: "tool_use"; toolUse: ToolUseRequest }
  | { type: "tool_call_delta"; callId: string; name?: string; argumentsDelta: string }
  | { type: "response_started"; responseId: string }
  | { type: "response_completed"; responseId?: string; stopReason?: string; usage?: ModelUsage }
  | { type: "response_incomplete"; responseId?: string; reason?: string; usage?: ModelUsage }
  | { type: "usage"; usage: ModelUsage }
  | { type: "retrying"; error: Error; attempt: number; delayMs: number }
  | { type: "provider_event"; event: unknown }
  | { type: "error"; error: Error }
  | { type: "retry"; reason: string; attempt: number };

export interface ModelGateway {
  stream(request: ModelRequest): AsyncIterable<ModelStreamEvent>;
}

export class NotConfiguredModelGateway implements ModelGateway {
  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    const lastUserText = request.messages
      .slice()
      .reverse()
      .flatMap((message) => message.blocks)
      .find((block) => block.type === "text")?.text;

    yield {
      type: "assistant_message",
      message: createTextMessage(
        "assistant",
        `Model gateway is not configured yet. REPL received: ${lastUserText ?? "<empty>"}`,
      ),
    };
  }
}
