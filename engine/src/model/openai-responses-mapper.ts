import { createTextMessage, createThinkingMessage, type MessageBlock } from "../types/messages.js";
import { buildPromptCacheIdentity } from "../core/prompt-cache-key.js";
import type { HttpJsonResponse } from "./http-transport.js";
import { discardsPartialOutput, type ModelRequest, type ModelStreamEvent, type ReasoningConfig } from "./model-gateway.js";
import { decodeSSE } from "./sse-decoder.js";
import { withThinkingLifecycle } from "./thinking-lifecycle.js";
import { findModelMetadata } from "./context-window.js";
import { ModelAPIError } from "./errors.js";
import {
  asNumber,
  asString,
  buildResponsesInput,
  buildResponsesTools,
  dropUndefined,
  ensureToolBuffer,
  normalizeOpenAIStreamError,
  normalizeUsage,
  toToolUse,
  type ToolBuffer,
} from "./openai-mappers.js";

export interface OpenAIResponsesMapperOptions {
  model: string;
  defaultMaxOutputTokens?: number;
  defaultReasoning?: ReasoningConfig | null;
  streamIdleTimeoutMs?: number;
}

/** allowedTools=false uses standard tool_choice values for a backend that rejected allowed_tools. */
export function buildResponsesRequest(request: ModelRequest, options: OpenAIResponsesMapperOptions, build: { allowedTools?: boolean } = {}): Record<string, unknown> {
  const tools = buildResponsesTools(request.tools);
  const model = request.model ?? options.model;
  const promptCache = buildPromptCacheIdentity(request.instructions ?? request.systemPrompt, request.tools, model, request.messages);
  const explicitCaching = supportsExplicitPromptCaching(model);
  const stableRuntimeCount = request.messages[0]?.metadata?.cacheStableRuntimeContext === true ? 1 : 0;
  const stableRuntimeInput = buildResponsesInput(request.messages.slice(0, stableRuntimeCount), {
    markStableRuntimeContextBreakpoint: explicitCaching,
  });
  const conversationInput = buildResponsesInput(request.messages.slice(stableRuntimeCount));
  // The boundary is an internal cache marker, not part of the model instructions.
  // Send the full prompt on every request, including previous_response_id continuations.
  const instructions = [promptCache.stableSystemPrompt, promptCache.dynamicSystemPrompt].filter(Boolean).join("\n\n") || undefined;
  const input = [...stableRuntimeInput, ...conversationInput];
  const reasoningDisabled = request.reasoning === null || (request.reasoning === undefined && options.defaultReasoning === null);
  const reasoning = request.reasoning ?? options.defaultReasoning ?? undefined;
  const supportsReasoning = findModelMetadata(model)?.reasoning ?? (!!reasoning || /^(?:o[134](?:-|$)|gpt-[5-9](?:[.-]|$))/i.test(model));
  const visibleReasoning = !reasoningDisabled && reasoning?.effort !== "none" && supportsReasoning
    ? { ...reasoning, summary: reasoning?.summary ?? "auto" } : reasoning;
  const toolChoice = constrainedResponsesToolChoice(request.toolChoice, tools, build.allowedTools !== false);
  const body = dropUndefined({
    model,
    instructions,
    input,
    previous_response_id: request.previousResponseId,
    max_output_tokens: request.maxOutputTokens ?? options.defaultMaxOutputTokens,
    reasoning: reasoningDisabled ? undefined : visibleReasoning,
    text: request.textFormat ? { format: request.textFormat } : undefined,
    metadata: request.metadata,
    service_tier: request.fastMode ? "priority" : request.serviceTier,
    prompt_cache_key: promptCache.key,
    prompt_cache_options: explicitCaching ? { mode: "implicit" } : undefined,
    store: shouldStoreResponse(request, tools.length),
    ...((request.providerOptions?.responses as Record<string, unknown> | undefined) ?? {}),
    // The runtime owns tool execution. Keep provider options from replacing the
    // function catalog or enabling provider-hosted tools such as image_generation.
    tools: tools.length ? tools : undefined,
    tool_choice: toolChoice,
  });
  return body;
}

function supportsExplicitPromptCaching(model: string): boolean {
  const match = /(?:^|[-_])gpt-(\d+)\.(\d+)(?:[-_]|$)/i.exec(model);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 5 || (major === 5 && minor >= 6);
}

export async function* normalizeResponsesStream(
  stream: ReadableStream<Uint8Array>,
  options: OpenAIResponsesMapperOptions,
): AsyncGenerator<ModelStreamEvent> {
  yield* withThinkingLifecycle(normalizeResponsesStreamEvents(stream, options));
}

async function* normalizeResponsesStreamEvents(
  stream: ReadableStream<Uint8Array>,
  options: OpenAIResponsesMapperOptions,
): AsyncGenerator<ModelStreamEvent> {
  const textBlocks: Extract<MessageBlock, { type: "text" }>[] = [];
  const thinkingParts: string[] = [];
  const toolBuffers = new Map<number, ToolBuffer>();
  const announcedToolCalls = new Set<number>();
  let responseId: string | undefined;
  let reasoningPartKey: string | undefined;
  const outputItems = new Map<string | number, Record<string, unknown>>();
  const contentParts = new Map<string, Record<string, unknown>>();
  const reasoningTextByPart = new Map<string, string>();
  const completedReasoning = new Map<string | number, Record<string, unknown>>();
  const refusals = new Map<string, string>();
  function* publishReasoning(text: string, key: string, snapshot = false): Generator<ModelStreamEvent> {
    if (!text) return;
    const previous = reasoningTextByPart.get(key) ?? "";
    const delta = snapshot ? (text.startsWith(previous) ? text.slice(previous.length) : previous ? "" : text) : text;
    reasoningTextByPart.set(key, snapshot ? text : previous + text);
    if (!delta) return;
    const separated = reasoningPartKey !== undefined && reasoningPartKey !== key ? `\n\n${delta}` : delta;
    reasoningPartKey = key;
    thinkingParts.push(separated);
    yield { type: "thinking_delta", text: separated };
  }
  function* publishReasoningItem(item: Record<string, unknown>, fallback: string | number): Generator<ModelStreamEvent> {
    const id = asString(item.id) ?? String(fallback);
    completedReasoning.set(id, item);
    let structured = false;
    for (const field of ["summary", "content"] as const) {
      const parts = Array.isArray(item[field]) ? item[field] as unknown[] : [];
      for (const [index, part] of parts.entries()) {
        const text = typeof part === "string" ? part : part && typeof part === "object" ? extractReasoningText(part as Record<string, unknown>) : "";
        if (text) { structured = true; yield* publishReasoning(text, `${id}:${field}:${index}`, true); }
      }
    }
    if (!structured) yield* publishReasoning(extractReasoningText(item), `${id}:content:0`, true);
  }

  for await (const sse of decodeSSE(stream, options.streamIdleTimeoutMs ?? 120000)) {
    if (!sse.data || typeof sse.data !== "object" || Array.isArray(sse.data)) throw new ModelAPIError({ provider: "openai", category: "network", message: "Invalid JSON in OpenAI SSE event" });
    const event = sse.data as Record<string, unknown>;
    const type = asString(event.type ?? sse.event);
    assertNoNativeImageGenerationResponse(event, type);
    yield { type: "provider_event", event };

    if (type === "response.created") {
      const response = event.response as Record<string, unknown> | undefined;
      responseId = asString(response?.id);
      if (responseId) yield { type: "response_started", responseId };
    }

    const itemKey = asString(event.item_id) ?? asNumber(event.output_index) ?? 0;
    if (type === "response.output_item.added" || type === "response.output_item.done") {
      const item = event.item as Record<string, unknown> | undefined;
      if (item) {
        outputItems.set(asNumber(event.output_index) ?? 0, item);
        if (typeof item.id === "string") outputItems.set(item.id, item);
      }
    }
    if (type === "response.content_part.added" && event.part && typeof event.part === "object") {
      contentParts.set(`${itemKey}:${asNumber(event.content_index) ?? 0}`, event.part as Record<string, unknown>);
    }

    if (type === "response.output_text.delta") {
      const delta = asString(event.delta) ?? "";
      if (delta) {
        const item = outputItems.get(itemKey) ?? outputItems.get(asNumber(event.output_index) ?? 0);
        const part = contentParts.get(`${itemKey}:${asNumber(event.content_index) ?? 0}`);
        const visible = allowsVisibleOutput(event, item, part) && (!item || item.type === "message") && (!part || part.type === "output_text");
        const display = visible ? { displayChannel: "visible" as const } : {};
        appendTextBlock(textBlocks, delta, visible);
        yield { type: "assistant_delta", text: delta, ...display };
      }
    }

    if (type === "response.output_text.done" || (type === "response.output_item.done" && (event.item as Record<string, unknown> | undefined)?.type === "message")) {
      yield { type: "assistant_text_done" };
    }

    // A refusal is a standard message content part, never visible answer text.
    if (type === "response.refusal.delta" || type === "response.refusal.done") {
      const key = `${itemKey}:${asNumber(event.content_index) ?? 0}`;
      const text = type === "response.refusal.done" ? asString(event.refusal) : (refusals.get(key) ?? "") + (asString(event.delta) ?? "");
      if (text !== undefined) refusals.set(key, text);
    }
    if (type === "response.output_item.done" && (event.item as Record<string, unknown> | undefined)?.type === "message") {
      const item = event.item as Record<string, unknown>;
      const content = item.content;
      for (const [index, part] of (Array.isArray(content) ? content as Record<string, unknown>[] : []).entries()) {
        // Same key as refusal.delta/done (item id + content index) so a part is collected once.
        const key = `${asString(item.id) ?? itemKey}:${index}`;
        if (part?.type === "refusal" && typeof part.refusal === "string" && !refusals.get(key)) refusals.set(key, part.refusal);
      }
    }

    const reasoningEvent = { ...event, item_id: event.item_id ?? outputItems.get(asNumber(event.output_index) ?? 0)?.id };
    if (isReasoningDeltaEvent(type)) {
      yield* publishReasoning(extractThinkingDelta(event), reasoningPartKeyForEvent(type, reasoningEvent)!);
    }
    if (type?.startsWith("response.reasoning") && (type.endsWith(".done") || type.endsWith(".added"))) {
      const part = event.part && typeof event.part === "object" ? event.part as Record<string, unknown> : event;
      yield* publishReasoning(extractReasoningText(part), reasoningPartKeyForEvent(type, reasoningEvent)!, true);
      if (type.endsWith(".done")) yield { type: "thinking_done" };
    }
    if (type === "response.output_item.done" && (event.item as Record<string, unknown> | undefined)?.type === "reasoning") {
      yield* publishReasoningItem(event.item as Record<string, unknown>, itemKey);
      yield { type: "thinking_done" };
    }

    if (type === "response.output_item.added") {
      const item = event.item as Record<string, unknown> | undefined;
      if (item?.type === "function_call") {
        const outputIndex = asNumber(event.output_index) ?? toolBuffers.size;
        toolBuffers.set(outputIndex, {
          callId: asString(item.call_id) ?? asString(item.id) ?? `call_${outputIndex}`,
          name: asString(item.name) ?? "unknown_tool",
          argumentsBuffer: asString(item.arguments) ?? "",
        });
        const buffer = toolBuffers.get(outputIndex)!;
        if (!announcedToolCalls.has(outputIndex) && asString(item.name)) {
          announcedToolCalls.add(outputIndex);
          yield { type: "tool_call_started", callId: buffer.callId, name: buffer.name };
        }
      }
    }

    if (type === "response.function_call_arguments.delta") {
      const outputIndex = asNumber(event.output_index) ?? 0;
      const delta = asString(event.delta) ?? "";
      const buffer = ensureToolBuffer(toolBuffers, outputIndex);
      buffer.argumentsBuffer += delta;
      yield { type: "tool_call_delta", callId: buffer.callId, name: buffer.name, argumentsDelta: delta };
    }

    if (type === "response.function_call_arguments.done") {
      const outputIndex = asNumber(event.output_index) ?? 0;
      const buffer = ensureToolBuffer(toolBuffers, outputIndex);
      buffer.argumentsBuffer = asString(event.arguments) ?? buffer.argumentsBuffer;
    }

    if (type === "response.output_item.done") {
      const item = event.item as Record<string, unknown> | undefined;
      if (item?.type === "function_call") {
        const outputIndex = asNumber(event.output_index) ?? 0;
        const buffer = toolBuffers.get(outputIndex) ?? {
          callId: asString(item.call_id) ?? asString(item.id) ?? `call_${outputIndex}`,
          name: asString(item.name) ?? "unknown_tool",
          argumentsBuffer: asString(item.arguments) ?? "{}",
        };
        // The finished item carries the complete arguments; some compatible
        // servers send them only here, without argument delta events.
        const finalArguments = asString(item.arguments);
        if (finalArguments) buffer.argumentsBuffer = finalArguments;
        yield { type: "tool_use", toolUse: toToolUse(buffer) };
      }
    }

    if (type === "response.completed") {
      const response = event.response as Record<string, unknown> | undefined;
      responseId = asString(response?.id) ?? responseId;
      for (const [index, item] of ((Array.isArray(response?.output) ? response.output : []) as Record<string, unknown>[]).entries()) {
        if (item.type === "reasoning") yield* publishReasoningItem(item, index);
      }
      yield { type: "thinking_done" };
      const thinking = collectThinkingFromResponse({ output: [...completedReasoning.values()] }, thinkingParts);
      if (thinking) yield { type: "assistant_message", message: createThinkingMessage(thinking) };
      const refusal = [...refusals.values()].join("\n").trim() || refusalFromOutput(response?.output);
      const usage = normalizeUsage(response?.usage);
      if (refusal) {
        // A "completed" response that only carries a refusal is not a successful answer.
        if (usage) yield { type: "usage", usage };
        yield { type: "response_incomplete", responseId, reason: "refusal", detail: refusal, usage };
        return;
      }
      if (textBlocks.length) yield { type: "assistant_message", message: { ...createTextMessage("assistant", ""), blocks: textBlocks } };
      if (usage) yield { type: "usage", usage };
      yield { type: "response_completed", responseId, stopReason: asString(response?.status) ?? "completed", usage };
      return;
    }

    if (type === "response.incomplete") {
      const response = event.response as Record<string, unknown> | undefined;
      for (const [index, item] of ((Array.isArray(response?.output) ? response.output : []) as Record<string, unknown>[]).entries()) {
        if (item.type === "reasoning") yield* publishReasoningItem(item, index);
      }
      yield { type: "thinking_done" };
      const thinking = collectThinkingFromResponse({ output: [...completedReasoning.values()] }, thinkingParts);
      if (thinking) yield { type: "assistant_message", message: createThinkingMessage(thinking) };
      const reason = asString((response?.incomplete_details as Record<string, unknown> | undefined)?.reason);
      // Truncated text stays in history so a continuation has the context it
      // extends; filtered output is discarded.
      if (textBlocks.length && !discardsPartialOutput(reason)) yield { type: "assistant_message", message: { ...createTextMessage("assistant", ""), blocks: textBlocks } };
      const usage = normalizeUsage(response?.usage);
      yield {
        type: "response_incomplete",
        responseId: asString(response?.id) ?? responseId,
        reason,
        usage,
      };
      return;
    }

    if (type === "response.failed") {
      throw normalizeOpenAIStreamError((event.response as Record<string, unknown> | undefined) ?? event);
    }
    if (type === "error") {
      throw normalizeOpenAIStreamError(event);
    }
  }
  throw new ModelAPIError({ provider: "openai", category: "network", message: "Responses stream closed before response completion" });
}

export function* normalizeResponsesObject(response: HttpJsonResponse<Record<string, unknown>>): Generator<ModelStreamEvent> {
  const body = response.body;
  if (body.status === "failed") throw normalizeOpenAIStreamError(body);
  assertNoNativeImageGenerationResponse(body);
  const responseId = asString(body.id);
  if (responseId) yield { type: "response_started", responseId };
  const output = Array.isArray(body.output) ? body.output : [];
  const textBlocks: Extract<MessageBlock, { type: "text" }>[] = [];
  const thinkingParts: string[] = [];

  for (const item of output as Record<string, unknown>[]) {
    if (item.type === "message") {
      const content = Array.isArray(item.content) ? item.content : [];
      for (const part of content as Record<string, unknown>[]) {
        const text = asString(part.text) ?? asString(part.output_text) ?? "";
        appendTextBlock(textBlocks, text, part.type === "output_text" && allowsVisibleOutput(body, item, part));
      }
    }
    if (item.type === "reasoning") thinkingParts.push(extractReasoningText(item));
    if (item.type === "function_call") {
      yield {
        type: "tool_use",
        toolUse: toToolUse({
          callId: asString(item.call_id) ?? asString(item.id) ?? "call_unknown",
          name: asString(item.name) ?? "unknown_tool",
          argumentsBuffer: asString(item.arguments) ?? "{}",
        }),
      };
    }
  }

  const thinking = collectThinkingFromResponse(body, thinkingParts);
  if (thinking) yield { type: "assistant_message", message: createThinkingMessage(thinking) };
  const refusal = refusalFromOutput(output);
  const incompleteReason = refusal ? "refusal" : body.status === "incomplete" ? asString((body.incomplete_details as Record<string, unknown> | undefined)?.reason) : undefined;
  if (textBlocks.length && !discardsPartialOutput(incompleteReason)) yield { type: "assistant_message", message: { ...createTextMessage("assistant", ""), blocks: textBlocks } };
  const usage = normalizeUsage(body.usage);
  if (usage) yield { type: "usage", usage };
  if (refusal || body.status === "incomplete") {
    yield { type: "response_incomplete", responseId, reason: incompleteReason, ...(refusal ? { detail: refusal } : {}), usage };
  } else {
    yield { type: "response_completed", responseId, stopReason: asString(body.status), usage };
  }
}

/** Joined text of standard `refusal` content parts in output message items. */
function refusalFromOutput(output: unknown): string {
  const parts: string[] = [];
  for (const item of Array.isArray(output) ? output as Record<string, unknown>[] : []) {
    if (item?.type !== "message" || !Array.isArray(item.content)) continue;
    for (const part of item.content as Record<string, unknown>[]) {
      if (part?.type === "refusal" && typeof part.refusal === "string" && part.refusal.trim()) parts.push(part.refusal.trim());
    }
  }
  return parts.join("\n");
}

function shouldStoreResponse(request: ModelRequest, toolCount: number): boolean {
  return Boolean(request.previousResponseId || toolCount > 0);
}

function constrainedResponsesToolChoice(
  requested: ModelRequest["toolChoice"],
  tools: unknown[],
  allowedTools: boolean,
): unknown {
  if (!tools.length || requested === "none") return requested;
  if (requested && typeof requested === "object") return requested;
  // allowed_tools keeps gateway-injected hosted tools out of reach. It is sent
  // to every backend; only one that rejected it gets the standard values.
  if (!allowedTools) return requested ?? "auto";
  return {
    type: "allowed_tools",
    mode: requested === "required" ? "required" : "auto",
    tools: tools.map((tool) => ({ type: "function", name: (tool as { name: string }).name })),
  };
}

function assertNoNativeImageGenerationResponse(value: Record<string, unknown>, eventType?: string): void {
  const output = Array.isArray(value.output) ? value.output : [];
  const item = value.item && typeof value.item === "object" ? value.item as Record<string, unknown> : undefined;
  const response = value.response && typeof value.response === "object" ? value.response as Record<string, unknown> : undefined;
  const responseOutput = Array.isArray(response?.output) ? response.output : [];
  const hasNativeImage = eventType?.startsWith("response.image_generation_call.") === true ||
    item?.type === "image_generation_call" ||
    [...output, ...responseOutput].some((entry) => entry && typeof entry === "object" && (entry as Record<string, unknown>).type === "image_generation_call");
  if (!hasNativeImage) return;
  throw new ModelAPIError({
    category: "provider_bug",
    provider: "openai",
    code: "unexpected_native_image_generation",
    message: "The model used OpenAI native image generation instead of the required application function tool image_create.",
    retryable: false,
    raw: value,
  });
}

function isReasoningDeltaEvent(type: string | undefined): boolean {
  return type === "response.reasoning_summary.delta" ||
    type === "response.reasoning_summary_text.delta" ||
    type === "response.reasoning_text.delta" ||
    type === "response.reasoning.delta";
}

function extractThinkingDelta(event: Record<string, unknown>): string {
  const delta = event.delta;
  if (typeof delta === "string") return delta;
  if (delta && typeof delta === "object") return extractReasoningText(delta as Record<string, unknown>);
  return asString(event.text) ?? asString(event.summary_text) ?? "";
}

function collectThinkingFromResponse(response: Record<string, unknown> | undefined, streamedParts: string[]): string {
  const streamed = streamedParts.join("");
  const output = Array.isArray(response?.output) ? response.output : [];
  const fromOutput = output
    .map((item) => {
      const record = item as Record<string, unknown>;
      return record.type === "reasoning" ? extractReasoningText(record) : "";
    })
    .filter(Boolean)
    .join("\n\n");
  return (fromOutput || streamed).trim();
}

function reasoningPartKeyForEvent(type: string | undefined, event: Record<string, unknown>): string | undefined {
  const itemId = asString(event.item_id) ?? String(asNumber(event.output_index) ?? 0);
  if (type?.startsWith("response.reasoning_summary")) {
    return `${itemId}:summary:${asNumber(event.summary_index) ?? 0}`;
  }
  if (type?.startsWith("response.reasoning")) {
    return `${itemId}:content:${asNumber(event.content_index) ?? 0}`;
  }
  return undefined;
}

function extractReasoningText(item: Record<string, unknown>): string {
  const structuredParts: string[] = [];
  const direct = asString(item.text) ?? asString(item.summary_text);

  const summary = Array.isArray(item.summary) ? item.summary : [];
  structuredParts.push(...summary.map((part) => {
    if (typeof part === "string") return part;
    if (!part || typeof part !== "object") return "";
    const record = part as Record<string, unknown>;
    return asString(record.text) ?? asString(record.summary_text) ?? "";
  }).filter(Boolean));

  const content = Array.isArray(item.content) ? item.content : [];
  structuredParts.push(...content.map((part) => {
    if (typeof part === "string") return part;
    if (!part || typeof part !== "object") return "";
    const record = part as Record<string, unknown>;
    return asString(record.text) ?? asString(record.summary_text) ?? "";
  }).filter(Boolean));

  return structuredParts.length > 0 ? structuredParts.join("\n\n") : (direct ?? "");
}

// Only the Responses output_text contract supplies visibility. Explicit non-user
// channels/roles always win; missing markers on other providers remain private.
function allowsVisibleOutput(...scopes: (Record<string, unknown> | undefined)[]): boolean {
  return scopes.every((scope) => !scope || (
    (scope.role === undefined || scope.role === "assistant") &&
    (scope.channel === undefined || ["commentary", "answer", "final"].includes(String(scope.channel))) &&
    (scope.phase === undefined || ["commentary", "answer", "final", "final_answer"].includes(String(scope.phase)))
  ));
}

function appendTextBlock(blocks: Extract<MessageBlock, { type: "text" }>[], text: string, visible: boolean): void {
  if (!text) return;
  const displayChannel = visible ? "visible" : undefined;
  const last = blocks.at(-1);
  if (last && last.displayChannel === displayChannel) last.text += text;
  else blocks.push({ type: "text", text, ...(visible ? { displayChannel: "visible" as const } : {}) });
}
