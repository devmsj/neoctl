import { createTextMessage } from "../types/messages.js";
import type { HttpJsonResponse } from "./http-transport.js";
import type { ModelRequest, ModelStreamEvent, ReasoningConfig } from "./model-gateway.js";
import { decodeSSE } from "./sse-decoder.js";
import {
  asNumber,
  asString,
  buildResponsesInput,
  buildResponsesTools,
  dropUndefined,
  ensureToolBuffer,
  extractResponsesMessageText,
  normalizeUsage,
  toToolUse,
  type ToolBuffer,
} from "./openai-mappers.js";

export interface OpenAIResponsesMapperOptions {
  model: string;
  defaultMaxOutputTokens?: number;
  defaultReasoning?: ReasoningConfig;
  streamIdleTimeoutMs?: number;
}

export function buildResponsesRequest(request: ModelRequest, options: OpenAIResponsesMapperOptions): Record<string, unknown> {
  const tools = buildResponsesTools(request.tools);
  return dropUndefined({
    model: request.model ?? options.model,
    instructions: request.instructions ?? request.systemPrompt,
    input: buildResponsesInput(request.messages),
    tools: tools.length ? tools : undefined,
    tool_choice: request.toolChoice ?? (tools.length ? "auto" : undefined),
    previous_response_id: request.previousResponseId,
    max_output_tokens: request.maxOutputTokens ?? options.defaultMaxOutputTokens,
    reasoning: request.reasoning ?? options.defaultReasoning,
    text: request.textFormat ? { format: request.textFormat } : undefined,
    metadata: request.metadata,
    store: shouldStoreResponse(request, tools.length),
    ...((request.providerOptions?.responses as Record<string, unknown> | undefined) ?? {}),
  });
}

export async function* normalizeResponsesStream(
  stream: ReadableStream<Uint8Array>,
  options: OpenAIResponsesMapperOptions,
): AsyncGenerator<ModelStreamEvent> {
  const textParts: string[] = [];
  const toolBuffers = new Map<number, ToolBuffer>();
  let responseId: string | undefined;

  for await (const sse of decodeSSE(stream, options.streamIdleTimeoutMs ?? 120000)) {
    const event = sse.data as Record<string, unknown>;
    const type = asString(event.type ?? sse.event);
    yield { type: "provider_event", event };

    if (type === "response.created") {
      const response = event.response as Record<string, unknown> | undefined;
      responseId = asString(response?.id);
      if (responseId) yield { type: "response_started", responseId };
    }

    if (type === "response.output_text.delta") {
      const delta = asString(event.delta) ?? "";
      if (delta) {
        textParts.push(delta);
        yield { type: "assistant_delta", text: delta };
      }
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
        yield { type: "tool_use", toolUse: toToolUse(buffer) };
      }
    }

    if (type === "response.completed") {
      const response = event.response as Record<string, unknown> | undefined;
      responseId = asString(response?.id) ?? responseId;
      const text = textParts.join("");
      if (text) yield { type: "assistant_message", message: createTextMessage("assistant", text) };
      const usage = normalizeUsage(response?.usage);
      if (usage) yield { type: "usage", usage };
      yield { type: "response_completed", responseId, stopReason: asString(response?.status) ?? "completed", usage };
    }

    if (type === "response.incomplete") {
      const response = event.response as Record<string, unknown> | undefined;
      const usage = normalizeUsage(response?.usage);
      yield {
        type: "response_incomplete",
        responseId: asString(response?.id) ?? responseId,
        reason: asString((response?.incomplete_details as Record<string, unknown> | undefined)?.reason),
        usage,
      };
    }

    if (type === "error") {
      yield { type: "error", error: new Error(JSON.stringify(event.error ?? event)) };
    }
  }
}

export function* normalizeResponsesObject(response: HttpJsonResponse<Record<string, unknown>>): Generator<ModelStreamEvent> {
  const body = response.body;
  const responseId = asString(body.id);
  if (responseId) yield { type: "response_started", responseId };
  const output = Array.isArray(body.output) ? body.output : [];
  const textParts: string[] = [];

  for (const item of output as Record<string, unknown>[]) {
    if (item.type === "message") textParts.push(extractResponsesMessageText(item));
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

  const text = textParts.join("");
  if (text) yield { type: "assistant_message", message: createTextMessage("assistant", text) };
  const usage = normalizeUsage(body.usage);
  if (usage) yield { type: "usage", usage };
  if (body.status === "incomplete") {
    yield { type: "response_incomplete", responseId, reason: asString((body.incomplete_details as Record<string, unknown> | undefined)?.reason), usage };
  } else {
    yield { type: "response_completed", responseId, stopReason: asString(body.status), usage };
  }
}

function shouldStoreResponse(request: ModelRequest, toolCount: number): boolean {
  return Boolean(request.previousResponseId || toolCount > 0);
}
