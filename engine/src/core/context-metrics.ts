import type { ToolDefinition } from "../tools/tool.js";
import type { ContextMetrics } from "../types/events.js";
import type { Message, MessageBlock } from "../types/messages.js";
import { resolveContextWindowTokens } from "../model/context-window.js";
import { resolveImageBlockDataLengthSync } from "./image-storage.js";

let _encode: ((text: string) => number[]) | undefined;
let _encoderLoadFailed = false;

function getEncoder(): ((text: string) => number[]) | undefined {
  if (_encode || _encoderLoadFailed) return _encode;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("gpt-tokenizer");
    _encode = mod.encode ?? mod.default?.encode;
    if (!_encode) _encoderLoadFailed = true;
  } catch {
    _encoderLoadFailed = true;
  }
  return _encode;
}

const TOKEN_CACHE_MAX = 128;
const _tokenCache = new Map<string, number>();

function cachedTokenCount(text: string): number {
  if (!text) return 0;
  const cacheKey = text.length <= 4096 ? text : undefined;
  if (cacheKey) {
    const cached = _tokenCache.get(cacheKey);
    if (cached !== undefined) return cached;
  }
  const encode = getEncoder();
  const count = encode ? encode(text).length : heuristicTokenCount(text);
  if (cacheKey) {
    if (_tokenCache.size >= TOKEN_CACHE_MAX) {
      const first = _tokenCache.keys().next().value;
      if (first !== undefined) _tokenCache.delete(first);
    }
    _tokenCache.set(cacheKey, count);
  }
  return count;
}

export interface BuildContextMetricsInput {
  model?: string;
  messages: readonly Message[];
  systemPrompt: string;
  tools: readonly ToolDefinition[];
  cachedToolsAndPromptTokens?: number;
}

export function buildContextMetrics(input: BuildContextMetricsInput): ContextMetrics {
  let estimatedInputTokens: number;
  let estimatedChars: number;

  if (input.cachedToolsAndPromptTokens !== undefined) {
    const messageSerialized = input.messages.map(serializeMessageForMetrics).join("\n");
    estimatedChars = input.systemPrompt.length + messageSerialized.length;
    estimatedInputTokens = input.cachedToolsAndPromptTokens + estimateTextTokens(messageSerialized);
  } else {
    const serialized = [
      input.systemPrompt,
      ...input.messages.map(serializeMessageForMetrics),
      JSON.stringify(input.tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.inputSchema }))),
    ].join("\n");
    estimatedChars = serialized.length;
    estimatedInputTokens = estimateTextTokens(serialized);
  }

  const window = resolveContextWindowTokens(input.model);
  return {
    model: input.model,
    estimatedInputTokens,
    estimatedChars,
    messageCount: input.messages.length,
    toolCount: input.tools.length,
    contextWindowTokens: window.tokens,
    contextWindowSource: window.source,
    contextUsageRatio: window.tokens ? estimatedInputTokens / window.tokens : undefined,
    modelMetadata: window.model
      ? {
          id: window.model.id,
          provider: window.model.provider,
          maxOutputTokens: window.model.maxOutputTokens,
          knowledgeCutoff: window.model.knowledgeCutoff,
          reasoning: window.model.reasoning,
          imageInput: window.model.imageInput,
          source: window.model.source,
        }
      : undefined,
  };
}

export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  if (text.length <= 8192) return cachedTokenCount(text);
  let total = 0;
  for (let i = 0; i < text.length; i += 8192) {
    total += cachedTokenCount(text.slice(i, i + 8192));
  }
  return total;
}

export function computeStaticTokens(systemPrompt: string, tools: readonly ToolDefinition[]): number {
  const toolsSerialized = JSON.stringify(tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.inputSchema })));
  return estimateTextTokens(systemPrompt) + estimateTextTokens(toolsSerialized);
}

function heuristicTokenCount(text: string): number {
  if (!text) return 0;
  let tokens = 0;
  let asciiRun = 0;

  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code >= 0x4e00 && code <= 0x9fff) {
      tokens += Math.ceil(asciiRun / 4);
      asciiRun = 0;
      tokens += 2;
      continue;
    }
    if (code >= 0x3000 && code <= 0x303f || code >= 0xff00 && code <= 0xffef ||
        code >= 0xac00 && code <= 0xd7af || code >= 0x3400 && code <= 0x4dbf) {
      tokens += Math.ceil(asciiRun / 4);
      asciiRun = 0;
      tokens += 2;
      continue;
    }
    if (/\s/.test(char)) {
      tokens += Math.ceil(asciiRun / 4);
      asciiRun = 0;
      continue;
    }
    asciiRun += 1;
  }

  tokens += Math.ceil(asciiRun / 4);
  return Math.max(1, tokens);
}

function serializeMessageForMetrics(message: Message): string {
  return `${message.role}: ${message.blocks.map(serializeBlockForMetrics).join("\n")}`;
}

/**
 * Most vision APIs charge ~85 tokens per tile (typically 512x512).
 * A typical base64 image of ~200KB decodes to roughly 150K pixels ≈ ~1 tile ≈ 85 tokens.
 * Larger images get more tiles. We estimate based on base64 length as a proxy for pixel count.
 */
function estimateImageTokens(base64Length: number): number {
  const estimatedBytes = Math.floor(base64Length * 0.75);
  const tiles = Math.max(1, Math.ceil(estimatedBytes / 200_000));
  return tiles * 85;
}

function serializeBlockForMetrics(block: MessageBlock): string {
  if (block.type === "text") return block.text;
  if (block.type === "image") {
    const imageTokens = estimateImageTokens(resolveImageBlockDataLengthSync(block));
    return `${"x".repeat(imageTokens * 4)}`;
  }
  if (block.type === "thinking") return block.text;
  if (block.type === "tool_use") return `tool_use ${block.name} ${JSON.stringify(block.input)}`;
  return `tool_result ${block.name} ${JSON.stringify(block.output)}`;
}
