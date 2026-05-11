import type { Message, MessageBlock } from "../types/messages.js";

export type DisplayImageMode = "data-url" | "metadata-only" | "omit";

export interface DisplayMessageOptions {
  /**
   * Controls how image blocks are represented for UI consumers.
   * - data-url: include data URLs that can be assigned directly to <img src>.
   * - metadata-only: include image metadata without embedding base64 image data.
   * - omit: omit image blocks from the projected message.
   */
  imageMode?: DisplayImageMode;
  /**
   * Include thinking blocks in the projected message. Defaults to true.
   */
  includeThinking?: boolean;
  /**
   * Include tool use blocks in the projected message. Defaults to true.
   */
  includeToolUse?: boolean;
  /**
   * Include tool result blocks in the projected message. Defaults to true.
   */
  includeToolResult?: boolean;
}

export type DisplayMessageBlock =
  | { type: "text"; text: string }
  | DisplayImageBlock
  | { type: "thinking"; text: string; signature?: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; toolUseId: string; name: string; ok: boolean; output: unknown };

export interface DisplayImageBlock {
  type: "image";
  label?: string;
  mimeType: string;
  /** Approximate original payload size decoded from base64, when available. */
  sizeBytes?: number;
  thumbnail?: DisplayImageSource;
  original?: DisplayImageSource;
}

export interface DisplayImageSource {
  /** Directly assignable to an <img src> attribute when imageMode is "data-url". */
  src: string;
  mimeType: string;
}

export interface DisplayMessage {
  id: string;
  role: Message["role"];
  createdAt: string;
  blocks: DisplayMessageBlock[];
  providerMessageId?: string;
  requestId?: string;
  usage?: Message["usage"];
  isMeta?: boolean;
  isApiErrorMessage?: boolean;
  metadata?: Message["metadata"];
}

export function imageBlockToDataUrl(block: Extract<MessageBlock, { type: "image" }>): string {
  return `data:${block.mimeType};base64,${block.data}`;
}

export function toDisplayMessages(messages: readonly Message[], options: DisplayMessageOptions = {}): DisplayMessage[] {
  return messages.map((message) => toDisplayMessage(message, options));
}

export function toDisplayMessage(message: Message, options: DisplayMessageOptions = {}): DisplayMessage {
  const blocks = message.blocks
    .map((block) => toDisplayMessageBlock(block, options))
    .filter((block): block is DisplayMessageBlock => block !== undefined);
  return {
    id: message.id,
    role: message.role,
    createdAt: message.createdAt,
    blocks,
    providerMessageId: message.providerMessageId,
    requestId: message.requestId,
    usage: message.usage,
    isMeta: message.isMeta,
    isApiErrorMessage: message.isApiErrorMessage,
    metadata: message.metadata,
  };
}

export function toDisplayMessageBlock(block: MessageBlock, options: DisplayMessageOptions = {}): DisplayMessageBlock | undefined {
  if (block.type === "text") return { type: "text", text: block.text };
  if (block.type === "thinking") {
    if (options.includeThinking === false) return undefined;
    return { type: "thinking", text: block.text, signature: block.signature };
  }
  if (block.type === "tool_use") {
    if (options.includeToolUse === false) return undefined;
    return { type: "tool_use", id: block.id, name: block.name, input: block.input };
  }
  if (block.type === "tool_result") {
    if (options.includeToolResult === false) return undefined;
    return { type: "tool_result", toolUseId: block.toolUseId, name: block.name, ok: block.ok, output: block.output };
  }
  if (block.type === "image") return toDisplayImageBlock(block, options);
  return undefined;
}

export function toDisplayImageBlock(block: Extract<MessageBlock, { type: "image" }>, options: DisplayMessageOptions = {}): DisplayImageBlock | undefined {
  const imageMode = options.imageMode ?? "data-url";
  if (imageMode === "omit") return undefined;

  const base: DisplayImageBlock = {
    type: "image",
    label: block.label,
    mimeType: block.mimeType,
    sizeBytes: estimateBase64DecodedBytes(block.data),
  };

  if (imageMode === "metadata-only") return base;

  const src = imageBlockToDataUrl(block);
  return {
    ...base,
    thumbnail: { src, mimeType: block.mimeType },
    original: { src, mimeType: block.mimeType },
  };
}

export function estimateBase64DecodedBytes(data: string): number | undefined {
  const normalized = data.trim().replace(/\s+/g, "");
  if (!normalized) return 0;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.length % 4 !== 0) return undefined;
  const padding = normalized.endsWith("==") ? 2 : normalized.endsWith("=") ? 1 : 0;
  return Math.max(0, (normalized.length / 4) * 3 - padding);
}
