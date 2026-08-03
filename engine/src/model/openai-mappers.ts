import type { Message, MessageBlock, ToolUseRequest } from "../types/messages.js";
import type { ToolDefinition } from "../tools/tool.js";
import { categoryForStatus, ModelAPIError, type ModelAPIErrorCategory } from "./errors.js";
import type { ModelRequest, ModelUsage } from "./model-gateway.js";
import { resolveImageBlockDataSync } from "../core/image-storage.js";

export interface ToolBuffer {
  callId: string;
  name: string;
  argumentsBuffer: string;
}

export function buildResponsesInput(messages: readonly Message[]): unknown[] {
  const input: unknown[] = [];
  const pairs = collectToolPairs(messages);

  for (const message of messages) {
    if (message.role === "progress") continue;

    const text = textFromBlocks(message.blocks);
    if (message.role === "assistant") {
      if (text) input.push({ role: "assistant", content: [{ type: "output_text", text }] });
      for (const block of message.blocks) {
        if (block.type === "tool_use" && pairs.pairedIds.has(block.id)) input.push(toResponsesFunctionCall(block));
      }
      continue;
    }

    for (const block of message.blocks) {
      if (block.type === "tool_result" && pairs.pairedIds.has(block.toolUseId)) {
        input.push({ type: "function_call_output", call_id: block.toolUseId, output: serializeToolOutput(block.output) });
      }
    }

    const content = responsesInputContentFromBlocks(message.blocks);
    if (content.length === 0) continue;
    if (message.role === "system") {
      input.push({ role: "developer", content });
    } else if (message.role !== "tool_result") {
      input.push({ role: "user", content });
    }
  }
  return input;
}

export interface BuildChatMessagesOptions {
  includeReasoningContent?: boolean;
}

export function buildChatMessages(request: ModelRequest, options: BuildChatMessagesOptions = {}): unknown[] {
  const messages: unknown[] = [];
  const pairs = collectToolPairs(request.messages);
  const instructions = request.instructions ?? request.systemPrompt;
  let pendingReasoningContent: string | undefined;
  if (instructions) messages.push({ role: "system", content: instructions });

  for (const message of request.messages) {
    const text = textFromBlocks(message.blocks);
    const toolUses = message.blocks.filter(
      (block): block is { type: "tool_use"; id: string; name: string; input: unknown } =>
        block.type === "tool_use" && pairs.pairedIds.has(block.id),
    );

    if (message.role === "system" && text) messages.push({ role: "system", content: text });
    if (message.role === "user") {
      const content = chatInputContentFromBlocks(message.blocks);
      if (Array.isArray(content) ? content.length > 0 : content) messages.push({ role: "user", content });
    }
    if (message.role === "assistant") {
      const reasoningContent = options.includeReasoningContent ? thinkingFromBlocks(message.blocks) ?? pendingReasoningContent : undefined;
      if (toolUses.length) {
        messages.push({
          role: "assistant",
          content: text || null,
          reasoning_content: reasoningContent,
          tool_calls: toolUses.map(toChatToolCall),
        });
        pendingReasoningContent = undefined;
      } else if (text) {
        messages.push({ role: "assistant", content: text, reasoning_content: reasoningContent });
        pendingReasoningContent = undefined;
      } else if (reasoningContent) {
        pendingReasoningContent = reasoningContent;
      }
    }

    for (const block of message.blocks) {
      if (block.type === "tool_result" && pairs.pairedIds.has(block.toolUseId)) {
        pendingReasoningContent = undefined;
        messages.push({ role: "tool", tool_call_id: block.toolUseId, content: serializeToolOutput(block.output) });
      }
    }
  }
  return messages;
}

export function buildResponsesTools(tools: readonly ToolDefinition[]): unknown[] {
  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: normalizeSchema(tool.inputSchema),
    strict: tool.strict ?? false,
  }));
}

export function buildChatTools(tools: readonly ToolDefinition[]): unknown[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: normalizeSchema(tool.inputSchema),
    },
  }));
}

export function toToolUse(buffer: ToolBuffer): ToolUseRequest {
  return { id: buffer.callId, name: buffer.name, input: parseArguments(buffer.argumentsBuffer) };
}

export function extractResponsesMessageText(item: Record<string, unknown>): string {
  const content = Array.isArray(item.content) ? item.content : [];
  return content
    .map((part) => {
      const record = part as Record<string, unknown>;
      return asString(record.text) ?? asString(record.output_text) ?? "";
    })
    .join("");
}

export function ensureToolBuffer(buffers: Map<number, ToolBuffer>, outputIndex: number): ToolBuffer {
  const existing = buffers.get(outputIndex);
  if (existing) return existing;
  const created = { callId: `call_${outputIndex}`, name: "unknown_tool", argumentsBuffer: "" };
  buffers.set(outputIndex, created);
  return created;
}

export function normalizeUsage(raw: unknown): ModelUsage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const usage = raw as Record<string, unknown>;
  const inputTokens = asNumber(usage.input_tokens ?? usage.prompt_tokens);
  const outputTokens = asNumber(usage.output_tokens ?? usage.completion_tokens);
  return {
    inputTokens,
    outputTokens,
    totalTokens: asNumber(usage.total_tokens) ?? sum(inputTokens, outputTokens),
    reasoningTokens: asNumber((usage.output_tokens_details as Record<string, unknown> | undefined)?.reasoning_tokens),
    cachedTokens: asNumber(
      (usage.input_tokens_details as Record<string, unknown> | undefined)?.cached_tokens ??
      (usage.prompt_tokens_details as Record<string, unknown> | undefined)?.cached_tokens,
    ),
    raw,
  };
}

export function dropUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function normalizeOpenAIStreamError(event: Record<string, unknown>, provider = "openai"): ModelAPIError {
  const error = isRecord(event.error) ? event.error : event;
  const status = asNumber(error.status ?? event.status);
  const type = asString(error.type);
  const code = asString(error.code);
  const message = asString(error.message) ?? JSON.stringify(error);
  return new ModelAPIError({
    category: status !== undefined ? categoryForStatus(status, error) : categoryForOpenAIError(type, code, message),
    provider,
    message,
    status,
    code,
    raw: event,
  });
}

function collectToolPairs(messages: readonly Message[]): { pairedIds: Set<string> } {
  const toolUseIds = new Set<string>();
  const toolResultIds = new Set<string>();

  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.type === "tool_use") toolUseIds.add(block.id);
      if (block.type === "tool_result") toolResultIds.add(block.toolUseId);
    }
  }

  return {
    pairedIds: new Set([...toolUseIds].filter((id) => toolResultIds.has(id))),
  };
}

function categoryForOpenAIError(type: string | undefined, code: string | undefined, message: string): ModelAPIErrorCategory {
  const text = `${type ?? ""} ${code ?? ""} ${message}`.toLowerCase();
  if (text.includes("overloaded") || text.includes("service_unavailable")) return "overloaded";
  if (text.includes("rate_limit")) return "rate_limit";
  if (text.includes("timeout")) return "timeout";
  if (text.includes("context") && text.includes("length")) return "context_length";
  if (text.includes("max_output_tokens")) return "max_output_tokens";
  if (text.includes("permission")) return "permission_denied";
  if (text.includes("auth") || text.includes("api_key")) return "auth_unavailable";
  if (text.includes("server")) return "server_error";
  return "provider_bug";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function textFromBlocks(blocks: readonly MessageBlock[]): string {
  return blocks.filter((block): block is { type: "text"; text: string } => block.type === "text").map((block) => block.text).join("\n");
}

function thinkingFromBlocks(blocks: readonly MessageBlock[]): string | undefined {
  const text = blocks.filter((block): block is { type: "thinking"; text: string } => block.type === "thinking").map((block) => block.text).join("\n").trim();
  return text || undefined;
}

function responsesInputContentFromBlocks(blocks: readonly MessageBlock[]): Record<string, unknown>[] {
  const content: Record<string, unknown>[] = [];
  for (const block of blocks) {
    if (block.type === "text" && block.text) content.push({ type: "input_text", text: block.text });
    if (block.type === "image") {
      const imageUrl = imageDataUrl(block);
      if (imageUrl) content.push({ type: "input_image", image_url: imageUrl });
      const storageText = imageStorageText(block);
      if (storageText) content.push({ type: "input_text", text: storageText });
    }
  }
  return content;
}

function chatInputContentFromBlocks(blocks: readonly MessageBlock[]): string | Record<string, unknown>[] {
  const content: Record<string, unknown>[] = [];
  for (const block of blocks) {
    if (block.type === "text" && block.text) content.push({ type: "text", text: block.text });
    if (block.type === "image") {
      const imageUrl = imageDataUrl(block);
      if (imageUrl) content.push({ type: "image_url", image_url: { url: imageUrl } });
      const storageText = imageStorageText(block);
      if (storageText) content.push({ type: "text", text: storageText });
    }
  }
  if (content.every((part) => part.type === "text")) return content.map((part) => String(part.text ?? "")).join("\n");
  return content;
}

function imageStorageText(block: { label?: string; storage?: { path: string; format: string } }): string | undefined {
  if (!block.storage?.path) return undefined;
  const label = block.label ? `${block.label} ` : "";
  return `${label}image payload is stored as ${block.storage.format} at ${block.storage.path}; use the load_image tool with this image label/id for visual inspection, or view/read only if you need the stored base64 text.`;
}

function imageDataUrl(block: { mimeType: string; data: string; storage?: { path: string; format: string } }): string {
  const data = resolveImageBlockDataSync(block);
  if (!data) return "";
  if (data.startsWith("data:")) return data;
  return `data:${block.mimeType};base64,${data}`;
}

function toResponsesFunctionCall(block: { type: "tool_use"; id: string; name: string; input: unknown }): Record<string, unknown> {
  return {
    type: "function_call",
    call_id: block.id,
    name: block.name,
    arguments: serializeToolInput(block.input),
  };
}

function toChatToolCall(block: { type: "tool_use"; id: string; name: string; input: unknown }): Record<string, unknown> {
  return {
    id: block.id,
    type: "function",
    function: {
      name: block.name,
      arguments: serializeToolInput(block.input),
    },
  };
}

function serializeToolInput(input: unknown): string {
  return typeof input === "string" ? input : JSON.stringify(input ?? {});
}

function serializeToolOutput(output: unknown): string {
  return typeof output === "string" ? output : JSON.stringify(output);
}

function normalizeSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== "object") return { type: "object", properties: {}, additionalProperties: false };
  return schema;
}

function parseArguments(value: string): unknown {
  if (!value.trim()) return {};
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`Tool call arguments are not valid JSON: ${value}`);
  }
}

function sum(left?: number, right?: number): number | undefined {
  if (left === undefined && right === undefined) return undefined;
  return (left ?? 0) + (right ?? 0);
}
