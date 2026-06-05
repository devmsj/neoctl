import { createTextMessage, createThinkingMessage, type Message, type MessageBlock, type ToolUseRequest } from "../types/messages.js";
import type { ToolDefinition } from "../tools/tool.js";
import type { HttpJsonResponse } from "./http-transport.js";
import { categoryForStatus, ModelAPIError, type ModelAPIErrorCategory } from "./errors.js";
import type { ModelRequest, ModelStreamEvent, ModelUsage, ReasoningConfig } from "./model-gateway.js";
import { decodeSSE } from "./sse-decoder.js";
import { asNumber, asString, dropUndefined } from "./openai-mappers.js";
import { resolveImageBlockDataSync } from "../core/image-storage.js";

export interface AnthropicMapperOptions {
  model: string;
  defaultMaxOutputTokens?: number;
  defaultReasoning?: ReasoningConfig | null;
  streamIdleTimeoutMs?: number;
}

interface ToolBuffer {
  callId: string;
  name: string;
  argumentsBuffer: string;
}

export function buildAnthropicRequest(request: ModelRequest, options: AnthropicMapperOptions): Record<string, unknown> {
  const tools = buildAnthropicTools(request.tools);
  const reasoningDisabled = request.reasoning === null || (request.reasoning === undefined && options.defaultReasoning === null);
  const reasoning = reasoningDisabled ? undefined : (request.reasoning ?? options.defaultReasoning ?? undefined);
  const built = buildAnthropicMessages(request.messages, request.instructions ?? request.systemPrompt);
  return dropUndefined({
    model: request.model ?? options.model,
    system: built.system,
    messages: built.messages,
    tools: tools.length ? tools : undefined,
    tool_choice: anthropicToolChoice(request.toolChoice, tools.length),
    max_tokens: request.maxOutputTokens ?? options.defaultMaxOutputTokens,
    thinking: anthropicThinkingOption(reasoningDisabled, reasoning),
    ...((request.providerOptions?.anthropic as Record<string, unknown> | undefined) ?? {}),
  });
}

export async function* normalizeAnthropicStream(
  stream: ReadableStream<Uint8Array>,
  options: AnthropicMapperOptions,
): AsyncGenerator<ModelStreamEvent> {
  const textParts: string[] = [];
  const thinkingParts: string[] = [];
  const thinkingSignatures = new Map<number, string>();
  const toolBuffers = new Map<number, ToolBuffer>();
  const emittedToolUses = new Set<string>();
  let responseId: string | undefined;
  let stopReason: string | undefined;
  let usage: ModelUsage | undefined;

  for await (const sse of decodeSSE(stream, options.streamIdleTimeoutMs ?? 120000)) {
    const event = sse.data as Record<string, unknown>;
    const type = asString(event.type ?? sse.event);
    yield { type: "provider_event", event };

    if (type === "error") throw normalizeAnthropicStreamError(event);

    if (type === "message_start") {
      const message = asRecord(event.message);
      responseId = asString(message?.id) ?? responseId;
      if (responseId) yield { type: "response_started", responseId };
      const nextUsage = normalizeAnthropicUsage(message?.usage);
      if (nextUsage) {
        usage = nextUsage;
        yield { type: "usage", usage };
      }
      continue;
    }

    if (type === "content_block_start") {
      const index = asNumber(event.index) ?? toolBuffers.size;
      const block = asRecord(event.content_block);
      if (block?.type === "tool_use") {
        toolBuffers.set(index, {
          callId: asString(block.id) ?? `toolu_${index}`,
          name: asString(block.name) ?? "unknown_tool",
          argumentsBuffer: hasUsableInitialToolInput(block.input) ? serializeInitialToolInput(block.input) : "",
        });
      }
      continue;
    }

    if (type === "content_block_delta") {
      const index = asNumber(event.index) ?? toolBuffers.size;
      const delta = asRecord(event.delta);
      const deltaType = asString(delta?.type);
      if (deltaType === "text_delta") {
        const text = asString(delta?.text) ?? "";
        if (text) {
          textParts.push(text);
          yield { type: "assistant_delta", text };
        }
        continue;
      }
      if (deltaType === "thinking_delta") {
        const thinking = asString(delta?.thinking) ?? asString(delta?.text) ?? "";
        if (thinking) {
          thinkingParts.push(thinking);
          yield { type: "thinking_delta", text: thinking };
        }
        continue;
      }
      if (deltaType === "signature_delta") {
        const signature = asString(delta?.signature);
        if (signature) thinkingSignatures.set(index, signature);
        continue;
      }
      if (deltaType === "input_json_delta") {
        const buffer = toolBuffers.get(index) ?? { callId: `toolu_${index}`, name: "unknown_tool", argumentsBuffer: "" };
        const partialJson = asString(delta?.partial_json) ?? "";
        buffer.argumentsBuffer += partialJson;
        toolBuffers.set(index, buffer);
        if (partialJson) yield { type: "tool_call_delta", callId: buffer.callId, name: buffer.name, argumentsDelta: partialJson };
        continue;
      }
      continue;
    }

    if (type === "message_delta") {
      const delta = asRecord(event.delta);
      stopReason = asString(delta?.stop_reason) ?? stopReason;
      const nextUsage = normalizeAnthropicUsage(event.usage);
      if (nextUsage) {
        usage = nextUsage;
        yield { type: "usage", usage };
      }
      continue;
    }

    if (type === "message_stop") {
      for (const buffer of toolBuffers.values()) {
        if (emittedToolUses.has(buffer.callId)) continue;
        emittedToolUses.add(buffer.callId);
        yield { type: "tool_use", toolUse: toToolUse(buffer) };
      }
      const text = textParts.join("");
      if (text) yield { type: "assistant_message", message: createTextMessage("assistant", text) };
      const thinking = thinkingParts.join("").trim();
      if (thinking) {
        const signature = [...thinkingSignatures.values()].find(Boolean);
        yield { type: "assistant_message", message: createThinkingMessage(thinking, signature) };
      }
      if (stopReason === "max_tokens" || stopReason === "pause_turn") {
        yield { type: "response_incomplete", responseId, reason: normalizeStopReason(stopReason), usage };
      } else {
        yield { type: "response_completed", responseId, stopReason, usage };
      }
      return;
    }
  }

  for (const buffer of toolBuffers.values()) {
    if (emittedToolUses.has(buffer.callId)) continue;
    emittedToolUses.add(buffer.callId);
    yield { type: "tool_use", toolUse: toToolUse(buffer) };
  }
  const text = textParts.join("");
  if (text) yield { type: "assistant_message", message: createTextMessage("assistant", text) };
  const thinking = thinkingParts.join("").trim();
  if (thinking) {
    const signature = [...thinkingSignatures.values()].find(Boolean);
    yield { type: "assistant_message", message: createThinkingMessage(thinking, signature) };
  }
  if (stopReason === "max_tokens" || stopReason === "pause_turn") {
    yield { type: "response_incomplete", responseId, reason: normalizeStopReason(stopReason), usage };
  } else {
    yield { type: "response_completed", responseId, stopReason, usage };
  }
}

export function* normalizeAnthropicObject(response: HttpJsonResponse<Record<string, unknown>>): Generator<ModelStreamEvent> {
  const body = response.body;
  const responseId = asString(body.id);
  if (responseId) yield { type: "response_started", responseId };

  const content = Array.isArray(body.content) ? body.content : [];
  const textParts: string[] = [];
  const thinkingParts: string[] = [];

  for (const item of content) {
    const block = asRecord(item);
    if (!block) continue;
    if (block.type === "text") {
      const text = asString(block.text) ?? "";
      if (text) textParts.push(text);
      continue;
    }
    if (block.type === "thinking") {
      const thinking = asString(block.thinking) ?? asString(block.text) ?? "";
      if (thinking) thinkingParts.push(thinking);
      continue;
    }
    if (block.type === "tool_use") {
      yield {
        type: "tool_use",
        toolUse: {
          id: asString(block.id) ?? "toolu_unknown",
          name: asString(block.name) ?? "unknown_tool",
          input: block.input ?? {},
        },
      };
    }
  }

  const text = textParts.join("");
  if (text) yield { type: "assistant_message", message: createTextMessage("assistant", text) };
  const thinking = thinkingParts.join("").trim();
  if (thinking) yield { type: "assistant_message", message: createThinkingMessage(thinking, asString(findThinkingSignature(content))) };

  const usage = normalizeAnthropicUsage(body.usage);
  if (usage) yield { type: "usage", usage };

  const stopReason = asString(body.stop_reason);
  if (stopReason === "max_tokens" || stopReason === "pause_turn") {
    yield { type: "response_incomplete", responseId, reason: normalizeStopReason(stopReason), usage };
  } else {
    yield { type: "response_completed", responseId, stopReason, usage };
  }
}

export function normalizeAnthropicStreamError(event: Record<string, unknown>): ModelAPIError {
  const error = asRecord(event.error) ?? event;
  const status = asNumber(error.status ?? event.status);
  const type = asString(error.type);
  const message = asString(error.message) ?? JSON.stringify(error);
  return new ModelAPIError({
    category: status !== undefined ? categoryForStatus(status, error) : categoryForAnthropicError(type, message),
    provider: "anthropic",
    message,
    status,
    code: type,
    raw: event,
  });
}

function buildAnthropicTools(tools: readonly ToolDefinition[]): unknown[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: normalizeSchema(tool.inputSchema),
  }));
}

function buildAnthropicMessages(messages: readonly Message[], systemPrompt: string | undefined): { system?: string; messages: unknown[] } {
  const systemParts: string[] = [];
  if (systemPrompt?.trim()) systemParts.push(systemPrompt.trim());

  const pairedIds = collectPairedToolIds(messages);
  const builtMessages: Array<{ role: "user" | "assistant"; content: unknown[] }> = [];

  const pushMessage = (role: "user" | "assistant", content: unknown[]): void => {
    if (content.length === 0) return;
    const last = builtMessages[builtMessages.length - 1];
    if (last?.role === role) {
      last.content.push(...content);
      return;
    }
    builtMessages.push({ role, content: [...content] });
  };

  for (const message of messages) {
    if (message.role === "progress") continue;

    if (message.role === "system") {
      const text = textFromBlocks(message.blocks).trim();
      if (text) systemParts.push(text);
      continue;
    }

    if (message.role === "assistant") {
      const content = anthropicAssistantContentFromBlocks(message.blocks, pairedIds);
      pushMessage("assistant", content);
      continue;
    }

    if (message.role === "tool_result") {
      const content = anthropicToolResultContentFromBlocks(message.blocks, pairedIds);
      pushMessage("user", content);
      continue;
    }

    const content = anthropicUserContentFromBlocks(message.blocks);
    pushMessage("user", content);
  }

  const system = systemParts.map((part) => part.trim()).filter(Boolean).join("\n\n").trim() || undefined;
  return { system, messages: builtMessages };
}

function anthropicAssistantContentFromBlocks(blocks: readonly MessageBlock[], pairedIds: Set<string>): unknown[] {
  const content: unknown[] = [];
  for (const block of blocks) {
    if (block.type === "text" && block.text) content.push({ type: "text", text: block.text });
    if (block.type === "tool_use" && pairedIds.has(block.id)) {
      content.push({ type: "tool_use", id: block.id, name: block.name, input: block.input ?? {} });
    }
  }
  return content;
}

function anthropicToolResultContentFromBlocks(blocks: readonly MessageBlock[], pairedIds: Set<string>): unknown[] {
  const content: unknown[] = [];
  for (const block of blocks) {
    if (block.type !== "tool_result" || !pairedIds.has(block.toolUseId)) continue;
    content.push(dropUndefined({
      type: "tool_result",
      tool_use_id: block.toolUseId,
      is_error: block.ok ? undefined : true,
      content: serializeToolOutput(block.output),
    }));
  }
  return content;
}

function anthropicUserContentFromBlocks(blocks: readonly MessageBlock[]): unknown[] {
  const content: unknown[] = [];
  for (const block of blocks) {
    if (block.type === "text" && block.text) content.push({ type: "text", text: block.text });
    if (block.type === "image") {
      const image = anthropicImageBlock(block);
      if (image) content.push(image);
      const storageText = imageStorageText(block);
      if (storageText) content.push({ type: "text", text: storageText });
    }
  }
  return content;
}

function anthropicImageBlock(block: { mimeType: string; data: string; storage?: { path: string; format: string } }): Record<string, unknown> | undefined {
  const mediaType = block.mimeType.trim();
  const base64 = base64Data(resolveImageBlockDataSync(block) ?? "");
  if (!mediaType || !base64) return undefined;
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: mediaType,
      data: base64,
    },
  };
}

function anthropicToolChoice(
  toolChoice: ModelRequest["toolChoice"],
  toolCount: number,
): Record<string, unknown> | undefined {
  if (toolCount === 0) return undefined;
  if (!toolChoice || toolChoice === "auto") return { type: "auto" };
  if (toolChoice === "required") return { type: "any" };
  if (toolChoice === "none") return undefined;
  if (toolChoice.type === "function") return { type: "tool", name: toolChoice.name };
  return undefined;
}

function anthropicThinkingOption(
  reasoningDisabled: boolean,
  reasoning: ReasoningConfig | undefined,
): Record<string, unknown> | undefined {
  if (reasoningDisabled || reasoning?.effort === "none") return undefined;
  if (!reasoning?.effort) return undefined;
  return {
    type: "enabled",
    budget_tokens: thinkingBudgetTokens(reasoning.effort),
  };
}

function thinkingBudgetTokens(effort: NonNullable<ReasoningConfig["effort"]>): number {
  switch (effort) {
    case "minimal": return 1024;
    case "low": return 2048;
    case "medium": return 4096;
    case "high": return 8192;
    case "xhigh": return 16384;
    case "max": return 32768;
    default: return 1024;
  }
}

function normalizeAnthropicUsage(raw: unknown): ModelUsage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const usage = raw as Record<string, unknown>;
  const inputTokens = asNumber(usage.input_tokens);
  const outputTokens = asNumber(usage.output_tokens);
  const cacheCreationTokens = asNumber(usage.cache_creation_input_tokens);
  const cacheReadTokens = asNumber(usage.cache_read_input_tokens);
  return {
    inputTokens,
    outputTokens,
    totalTokens: sum(inputTokens, outputTokens),
    cachedTokens: sum(cacheCreationTokens, cacheReadTokens),
    raw,
  };
}

function normalizeStopReason(reason: string): string {
  if (reason === "max_tokens") return "max_output_tokens";
  return reason;
}

function findThinkingSignature(content: unknown[]): string | undefined {
  for (const item of content) {
    const block = asRecord(item);
    const signature = asString(block?.signature);
    if (signature) return signature;
  }
  return undefined;
}

function textFromBlocks(blocks: readonly MessageBlock[]): string {
  return blocks
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function collectPairedToolIds(messages: readonly Message[]): Set<string> {
  const toolUseIds = new Set<string>();
  const toolResultIds = new Set<string>();
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.type === "tool_use") toolUseIds.add(block.id);
      if (block.type === "tool_result") toolResultIds.add(block.toolUseId);
    }
  }
  return new Set([...toolUseIds].filter((id) => toolResultIds.has(id)));
}

function imageStorageText(block: { label?: string; storage?: { path: string; format: string } }): string | undefined {
  if (!block.storage?.path) return undefined;
  const label = block.label ? `${block.label} ` : "";
  return `${label}image payload is stored as ${block.storage.format} at ${block.storage.path}; use the load_image tool with this image label/id for visual inspection, or view/read only if you need the stored base64 text.`;
}

function base64Data(data: string): string {
  const trimmed = data.trim();
  const match = /^data:[^;]+;base64,(.*)$/i.exec(trimmed);
  return match ? match[1] : trimmed;
}

function hasUsableInitialToolInput(input: unknown): boolean {
  if (input === undefined || input === null) return false;
  if (typeof input === "string") return input.trim().length > 0;
  if (Array.isArray(input)) return input.length > 0;
  if (typeof input === "object") return Object.keys(input as Record<string, unknown>).length > 0;
  return true;
}

function serializeInitialToolInput(input: unknown): string {
  if (input === undefined) return "";
  if (typeof input === "string") return input;
  return JSON.stringify(input);
}

function toToolUse(buffer: ToolBuffer): ToolUseRequest {
  return { id: buffer.callId, name: buffer.name, input: parseArguments(buffer.argumentsBuffer) };
}

function parseArguments(value: string): unknown {
  if (!value.trim()) return {};
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`Tool call arguments are not valid JSON: ${value}`);
  }
}

function serializeToolOutput(output: unknown): string {
  return typeof output === "string" ? output : JSON.stringify(output);
}

function normalizeSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== "object") return { type: "object", properties: {}, additionalProperties: false };
  return schema;
}

function categoryForAnthropicError(type: string | undefined, message: string): ModelAPIErrorCategory {
  const text = `${type ?? ""} ${message}`.toLowerCase();
  if (text.includes("rate_limit")) return "rate_limit";
  if (text.includes("overloaded")) return "overloaded";
  if (text.includes("authentication") || text.includes("api key") || text.includes("auth")) return "auth_unavailable";
  if (text.includes("permission")) return "permission_denied";
  if (text.includes("context") && text.includes("length")) return "context_length";
  if (text.includes("max_tokens") || text.includes("max tokens")) return "max_output_tokens";
  if (text.includes("timeout")) return "timeout";
  if (text.includes("server")) return "server_error";
  return "provider_bug";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function sum(left?: number, right?: number): number | undefined {
  if (left === undefined && right === undefined) return undefined;
  return (left ?? 0) + (right ?? 0);
}
