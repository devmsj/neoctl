import { createTextMessage, createThinkingMessage, type MessageBlock } from "../types/messages.js";
import { buildPromptCacheIdentity } from "../core/prompt-cache-key.js";
import type { HttpJsonResponse } from "./http-transport.js";
import type { ModelRequest, ModelStreamEvent, ReasoningConfig } from "./model-gateway.js";
import { decodeSSE } from "./sse-decoder.js";
import { ModelAPIError, normalizeUnknownError } from "./errors.js";
import { withThinkingLifecycle } from "./thinking-lifecycle.js";
import {
  asNumber,
  asString,
  buildChatMessages,
  buildChatTools,
  dropUndefined,
  normalizeOpenAIStreamError,
  normalizeUsage,
  toToolUse,
  type ToolBuffer,
} from "./openai-mappers.js";

export interface OpenAIChatMapperOptions {
  model: string;
  defaultMaxOutputTokens?: number;
  streamIdleTimeoutMs?: number;
  defaultReasoning?: ReasoningConfig | null;
  includeMetadata?: boolean;
  providerName?: string;
}

export function buildChatRequest(request: ModelRequest, options: OpenAIChatMapperOptions): Record<string, unknown> {
  const tools = buildChatTools(request.tools);
  const model = request.model ?? options.model;
  const promptCache = buildPromptCacheIdentity(request.instructions ?? request.systemPrompt, request.tools, model, request.messages);
  const reasoningDisabled = request.reasoning === null || (request.reasoning === undefined && options.defaultReasoning === null);
  const reasoning = reasoningDisabled ? undefined : (request.reasoning ?? options.defaultReasoning ?? undefined);
  return dropUndefined({
    model,
    messages: buildChatMessages(request),
    tools: tools.length ? tools : undefined,
    tool_choice: request.toolChoice ?? (tools.length ? "auto" : undefined),
    max_tokens: request.maxOutputTokens ?? options.defaultMaxOutputTokens,
    reasoning_effort: chatReasoningEffortOption(request.model ?? options.model, reasoning),
    thinking: chatThinkingOption(request.model ?? options.model, reasoning, reasoningDisabled),
    metadata: options.includeMetadata === false ? undefined : request.metadata,
    service_tier: request.fastMode ? "priority" : request.serviceTier,
    prompt_cache_key: promptCache.key,
    ...((request.providerOptions?.chat as Record<string, unknown> | undefined) ?? {}),
  });
}

function chatReasoningEffortOption(_model: string, reasoning: ReasoningConfig | undefined): string | undefined {
  return reasoning?.effort;
}

function chatThinkingOption(_model: string, _reasoning: ReasoningConfig | undefined, _reasoningDisabled: boolean): Record<string, string> | undefined {
  return undefined;
}

export async function* normalizeChatStream(
  stream: ReadableStream<Uint8Array>,
  options: OpenAIChatMapperOptions,
): AsyncGenerator<ModelStreamEvent> {
  yield* withThinkingLifecycle(normalizeChatStreamEvents(stream, options));
}

async function* normalizeChatStreamEvents(
  stream: ReadableStream<Uint8Array>,
  options: OpenAIChatMapperOptions,
): AsyncGenerator<ModelStreamEvent> {
  const textBlocks: Extract<MessageBlock, { type: "text" }>[] = [];
  const choiceScopes = new Map<number, Record<string, unknown>>();
  const thinkingParts: string[] = [];
  const toolBuffers = new Map<number, ToolBuffer>();
  const announcedToolCalls = new Set<number>();
  let responseId: string | undefined;
  let usage = undefined as ReturnType<typeof normalizeUsage>;
  let stopReason: string | undefined;
  let awaitingRead = true;

  try {
  for await (const sse of decodeSSE(stream, options.streamIdleTimeoutMs ?? 120000)) {
    awaitingRead = false;
    if (!sse.data || typeof sse.data !== "object" || Array.isArray(sse.data)) throw new ModelAPIError({ provider: "openai", category: "network", message: "Invalid JSON in OpenAI SSE event" });
    const event = sse.data as Record<string, unknown>;
    const type = asString(event.type ?? sse.event);
    yield { type: "provider_event", event };
    if (type === "error") throw normalizeOpenAIStreamError(event, options.providerName ?? "openai");
    responseId = asString(event.id) ?? responseId;
    const chunkUsage = normalizeUsage(event.usage);
    if (chunkUsage) {
      usage = chunkUsage;
      yield { type: "usage", usage };
    }
    const choices = Array.isArray(event.choices) ? event.choices : [];

    for (const choice of choices as Record<string, unknown>[]) {
      const delta = choice.delta as Record<string, unknown> | undefined;
      const choiceIndex = asNumber(choice.index) ?? 0;
      const scope = { ...choiceScopes.get(choiceIndex) };
      for (const key of ["role", "channel", "phase"]) {
        const value = delta?.[key] ?? choice[key] ?? event[key];
        if (value !== undefined) scope[key] = value;
      }
      choiceScopes.set(choiceIndex, scope);
      // Some compatible chunks include the last reasoning text and first answer
      // together. Publish thinking first so the answer boundary really ends it.
      const reasoningContent = asString(delta?.reasoning_content) ?? asString(delta?.reasoning);
      if (reasoningContent) {
        thinkingParts.push(reasoningContent);
        yield { type: "thinking_delta", text: reasoningContent };
      }
      const content = asString(delta?.content);
      if (content) {
        const visible = allowsVisibleChatContent(event, choice, scope);
        appendChatText(textBlocks, content, visible);
        yield { type: "assistant_delta", text: content, ...(visible ? { displayChannel: "visible" as const } : {}) };
      }

      const toolCalls = Array.isArray(delta?.tool_calls) ? delta?.tool_calls : [];
      for (const toolCall of toolCalls as Record<string, unknown>[]) {
        const index = asNumber(toolCall.index) ?? toolBuffers.size;
        const fn = toolCall.function as Record<string, unknown> | undefined;
        const buffer = toolBuffers.get(index) ?? {
          callId: asString(toolCall.id) ?? `call_${index}`,
          name: asString(fn?.name) ?? "unknown_tool",
          argumentsBuffer: "",
        };
        buffer.callId = asString(toolCall.id) ?? buffer.callId;
        buffer.name = asString(fn?.name) ?? buffer.name;
        const argsDelta = asString(fn?.arguments) ?? "";
        buffer.argumentsBuffer += argsDelta;
        toolBuffers.set(index, buffer);
        // Header-only chunks already identify the call; do not wait for JSON input.
        if (!announcedToolCalls.has(index) && asString(fn?.name)) {
          announcedToolCalls.add(index);
          yield { type: "tool_call_started", callId: buffer.callId, name: buffer.name };
        }
        if (argsDelta) yield { type: "tool_call_delta", callId: buffer.callId, name: buffer.name, argumentsDelta: argsDelta };
      }

      const finishReason = asString(choice.finish_reason);
      if (finishReason) { stopReason = finishReason; yield { type: "assistant_text_done" }; }
      if (finishReason === "tool_calls") {
        for (const buffer of toolBuffers.values()) yield { type: "tool_use", toolUse: toToolUse(buffer) };
      }
    }
    awaitingRead = true;
  }

  } catch (error) {
    // include_usage arrives after finish_reason. Keep reading for accounting,
    // but a transport-only failure during this trailer cannot undo completion.
    const normalized = normalizeUnknownError(error, options.providerName ?? "openai");
    if (!awaitingRead || !stopReason || !["network", "timeout"].includes(normalized.category)) throw error;
  }
  if (!stopReason) throw new ModelAPIError({ provider: options.providerName ?? "openai", category: "network", message: "Chat stream closed before finish_reason" });
  const thinking = thinkingParts.join("").trim();
  if (thinking) yield { type: "assistant_message", message: createThinkingMessage(thinking) };
  if (textBlocks.length) yield { type: "assistant_message", message: { ...createTextMessage("assistant", ""), blocks: textBlocks } };
  if (stopReason === "length" || stopReason === "content_filter") yield { type: "response_incomplete", reason: stopReason === "length" ? "max_output_tokens" : stopReason, usage };
  else yield { type: "response_completed", responseId, stopReason, usage };
}

export function* normalizeChatObject(response: HttpJsonResponse<Record<string, unknown>>): Generator<ModelStreamEvent> {
  const body = response.body;
  const responseId = asString(body.id);
  if (responseId) yield { type: "response_started", responseId };
  const choices = Array.isArray(body.choices) ? body.choices : [];
  let stopReason: string | undefined;
  for (const choice of choices as Record<string, unknown>[]) {
    stopReason = asString(choice.finish_reason) ?? stopReason;
    const message = choice.message as Record<string, unknown> | undefined;
    const reasoningContent = asString(message?.reasoning_content) ?? asString(message?.reasoning);
    if (reasoningContent) yield { type: "assistant_message", message: createThinkingMessage(reasoningContent) };
    const content = asString(message?.content);
    if (content) {
      const blocks: Extract<MessageBlock, { type: "text" }>[] = [];
      appendChatText(blocks, content, allowsVisibleChatContent(body, choice, message));
      yield { type: "assistant_message", message: { ...createTextMessage("assistant", ""), blocks } };
    }
    const toolCalls = Array.isArray(message?.tool_calls) ? message?.tool_calls : [];
    for (const toolCall of toolCalls as Record<string, unknown>[]) {
      const fn = toolCall.function as Record<string, unknown> | undefined;
      yield {
        type: "tool_use",
        toolUse: toToolUse({
          callId: asString(toolCall.id) ?? "call_unknown",
          name: asString(fn?.name) ?? "unknown_tool",
          argumentsBuffer: asString(fn?.arguments) ?? "{}",
        }),
      };
    }
  }
  const usage = normalizeUsage(body.usage);
  if (usage) yield { type: "usage", usage };
  if (stopReason === "length" || stopReason === "content_filter") yield { type: "response_incomplete", reason: stopReason === "length" ? "max_output_tokens" : stopReason, usage };
  else yield { type: "response_completed", responseId, stopReason: stopReason ?? "completed", usage };
}

// Chat content is public by contract, but compatible servers may explicitly
// label private channels. Never authorize reasoning fields or an analysis channel.
function allowsVisibleChatContent(...scopes: (Record<string, unknown> | undefined)[]): boolean {
  return scopes.every(scope => !scope || (
    (scope.role === undefined || scope.role === "assistant") &&
    (scope.channel === undefined || ["commentary", "answer", "final"].includes(String(scope.channel))) &&
    (scope.phase === undefined || ["commentary", "answer", "final", "final_answer"].includes(String(scope.phase)))
  ));
}

function appendChatText(blocks: Extract<MessageBlock, { type: "text" }>[], text: string, visible: boolean): void {
  const displayChannel = visible ? "visible" : undefined;
  const last = blocks.at(-1);
  if (last && last.displayChannel === displayChannel) last.text += text;
  else blocks.push({ type: "text", text, ...(visible ? { displayChannel: "visible" as const } : {}) });
}
