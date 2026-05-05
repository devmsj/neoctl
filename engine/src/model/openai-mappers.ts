import type { Message, MessageBlock, ToolUseRequest } from "../types/messages";
import type { ToolDefinition } from "../tools/tool";
import type { ModelRequest, ModelUsage } from "./model-gateway";

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

    if (!text) continue;
    if (message.role === "system") {
      input.push({ role: "developer", content: [{ type: "input_text", text }] });
    } else if (message.role !== "tool_result") {
      input.push({ role: "user", content: [{ type: "input_text", text }] });
    }
  }
  return input;
}

export function buildChatMessages(request: ModelRequest): unknown[] {
  const messages: unknown[] = [];
  const pairs = collectToolPairs(request.messages);
  const instructions = request.instructions ?? request.systemPrompt;
  if (instructions) messages.push({ role: "system", content: instructions });

  for (const message of request.messages) {
    const text = textFromBlocks(message.blocks);
    const toolUses = message.blocks.filter(
      (block): block is { type: "tool_use"; id: string; name: string; input: unknown } =>
        block.type === "tool_use" && pairs.pairedIds.has(block.id),
    );

    if (message.role === "user" && text) messages.push({ role: "user", content: text });
    if (message.role === "assistant") {
      if (toolUses.length) {
        messages.push({
          role: "assistant",
          content: text || null,
          tool_calls: toolUses.map(toChatToolCall),
        });
      } else if (text) {
        messages.push({ role: "assistant", content: text });
      }
    }

    for (const block of message.blocks) {
      if (block.type === "tool_result" && pairs.pairedIds.has(block.toolUseId)) {
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
    cachedTokens: asNumber((usage.input_tokens_details as Record<string, unknown> | undefined)?.cached_tokens),
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

function textFromBlocks(blocks: readonly MessageBlock[]): string {
  return blocks.filter((block): block is { type: "text"; text: string } => block.type === "text").map((block) => block.text).join("\n");
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
