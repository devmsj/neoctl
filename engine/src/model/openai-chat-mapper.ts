import { createTextMessage } from "../types/messages.js";
import type { HttpJsonResponse } from "./http-transport.js";
import type { ModelRequest, ModelStreamEvent } from "./model-gateway.js";
import { decodeSSE } from "./sse-decoder.js";
import {
  asNumber,
  asString,
  buildChatMessages,
  buildChatTools,
  dropUndefined,
  normalizeUsage,
  toToolUse,
  type ToolBuffer,
} from "./openai-mappers.js";

export interface OpenAIChatMapperOptions {
  model: string;
  defaultMaxOutputTokens?: number;
  streamIdleTimeoutMs?: number;
}

export function buildChatRequest(request: ModelRequest, options: OpenAIChatMapperOptions): Record<string, unknown> {
  const tools = buildChatTools(request.tools);
  return dropUndefined({
    model: request.model ?? options.model,
    messages: buildChatMessages(request),
    tools: tools.length ? tools : undefined,
    tool_choice: request.toolChoice ?? (tools.length ? "auto" : undefined),
    max_tokens: request.maxOutputTokens ?? options.defaultMaxOutputTokens,
    metadata: request.metadata,
    ...((request.providerOptions?.chat as Record<string, unknown> | undefined) ?? {}),
  });
}

export async function* normalizeChatStream(
  stream: ReadableStream<Uint8Array>,
  options: OpenAIChatMapperOptions,
): AsyncGenerator<ModelStreamEvent> {
  const textParts: string[] = [];
  const toolBuffers = new Map<number, ToolBuffer>();
  let responseId: string | undefined;

  for await (const sse of decodeSSE(stream, options.streamIdleTimeoutMs ?? 120000)) {
    const event = sse.data as Record<string, unknown>;
    yield { type: "provider_event", event };
    responseId = asString(event.id) ?? responseId;
    const choices = Array.isArray(event.choices) ? event.choices : [];

    for (const choice of choices as Record<string, unknown>[]) {
      const delta = choice.delta as Record<string, unknown> | undefined;
      const content = asString(delta?.content);
      if (content) {
        textParts.push(content);
        yield { type: "assistant_delta", text: content };
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
        if (argsDelta) yield { type: "tool_call_delta", callId: buffer.callId, name: buffer.name, argumentsDelta: argsDelta };
      }

      const finishReason = asString(choice.finish_reason);
      if (finishReason === "tool_calls") {
        for (const buffer of toolBuffers.values()) yield { type: "tool_use", toolUse: toToolUse(buffer) };
      }
    }
  }

  const text = textParts.join("");
  if (text) yield { type: "assistant_message", message: createTextMessage("assistant", text) };
  yield { type: "response_completed", responseId, stopReason: "completed" };
}

export function* normalizeChatObject(response: HttpJsonResponse<Record<string, unknown>>): Generator<ModelStreamEvent> {
  const body = response.body;
  const responseId = asString(body.id);
  if (responseId) yield { type: "response_started", responseId };
  const choices = Array.isArray(body.choices) ? body.choices : [];
  for (const choice of choices as Record<string, unknown>[]) {
    const message = choice.message as Record<string, unknown> | undefined;
    const content = asString(message?.content);
    if (content) yield { type: "assistant_message", message: createTextMessage("assistant", content) };
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
  yield { type: "response_completed", responseId, stopReason: "completed", usage };
}
