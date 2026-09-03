import type { AgentEvent } from "../types/events.js";
import type { Message, MessageBlock } from "../types/messages.js";
import { resolveImageBlockDataResultSync, resolveImageBlockDataSync } from "../core/image-storage.js";

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
  imageId?: string;
  label?: string;
  mimeType: string;
  available: boolean;
  error?: string;
  /** Index in the source message block array; stable even when display-only blocks are omitted. */
  blockIndex?: number;
  /** Approximate original payload size decoded from base64, when available. */
  sizeBytes?: number;
  storagePath?: string;
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

export type DisplayAgentEvent =
  | Exclude<AgentEvent, { type: "message" }>
  | { type: "message"; message: DisplayMessage };

export interface DisplayImageAttachment {
  messageId: string;
  role: DisplayMessage["role"];
  createdAt: string;
  index: number;
  imageId?: string;
  label?: string;
  mimeType: string;
  available: boolean;
  error?: string;
  sizeBytes?: number;
  storagePath?: string;
  src?: string;
  thumbnailSrc?: string;
  originalSrc?: string;
}

export function imageBlockToDataUrl(block: Extract<MessageBlock, { type: "image" }>): string {
  const data = resolveImageBlockDataSync(block);
  if (!data) return "";
  if (data.startsWith("data:")) return data;
  return `data:${block.mimeType};base64,${data}`;
}

export function toDisplayAgentEvent(event: AgentEvent, options: DisplayMessageOptions = {}): DisplayAgentEvent {
  if (event.type !== "message") return event;
  return { ...event, message: toDisplayMessage(event.message, options) };
}

export function toDisplayAgentEvents(events: readonly AgentEvent[], options: DisplayMessageOptions = {}): DisplayAgentEvent[] {
  return events.map((event) => toDisplayAgentEvent(event, options));
}

export function toDisplayMessages(messages: readonly Message[], options: DisplayMessageOptions = {}): DisplayMessage[] {
  return messages.map((message) => toDisplayMessage(message, options));
}

export function toDisplayMessage(message: Message, options: DisplayMessageOptions = {}): DisplayMessage {
  const blocks = message.blocks
    .map((block, blockIndex) => toDisplayMessageBlock(block, options, blockIndex))
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

export function toDisplayMessageBlock(block: MessageBlock, options: DisplayMessageOptions = {}, blockIndex?: number): DisplayMessageBlock | undefined {
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
  if (block.type === "image") return toDisplayImageBlock(block, options, blockIndex);
  return undefined;
}

export function toDisplayImageBlock(block: Extract<MessageBlock, { type: "image" }>, options: DisplayMessageOptions = {}, blockIndex?: number): DisplayImageBlock | undefined {
  const imageMode = options.imageMode ?? "data-url";
  if (imageMode === "omit") return undefined;

  const resolution = resolveImageBlockDataResultSync(block);
  const data = resolution.available ? resolution.data : "";
  const base: DisplayImageBlock = {
    type: "image",
    imageId: block.imageId,
    label: block.label,
    mimeType: block.mimeType,
    available: resolution.available,
    error: resolution.available ? undefined : resolution.error,
    blockIndex,
    sizeBytes: resolution.available ? estimateBase64DecodedBytes(normalizeBase64ImageData(data)) : undefined,
    storagePath: block.storage?.path,
  };

  if (imageMode === "metadata-only" || !resolution.available) return base;

  const src = data.startsWith("data:") ? data : `data:${block.mimeType};base64,${data}`;
  return {
    ...base,
    thumbnail: { src, mimeType: block.mimeType },
    original: { src, mimeType: block.mimeType },
  };
}

export function extractDisplayImages(messages: readonly DisplayMessage[]): DisplayImageAttachment[] {
  const images: DisplayImageAttachment[] = [];
  for (const message of messages) {
    message.blocks.forEach((block, index) => {
      if (block.type !== "image") return;
      images.push({
        messageId: message.id,
        role: message.role,
        createdAt: message.createdAt,
        index: block.blockIndex ?? index,
        imageId: block.imageId,
        label: block.label,
        mimeType: block.mimeType,
        available: block.available,
        error: block.error,
        sizeBytes: block.sizeBytes,
        storagePath: block.storagePath,
        src: block.original?.src ?? block.thumbnail?.src,
        thumbnailSrc: block.thumbnail?.src,
        originalSrc: block.original?.src,
      });
    });
  }
  return images;
}

export function extractMessageImages(messages: readonly Message[], options: DisplayMessageOptions = {}): DisplayImageAttachment[] {
  return extractDisplayImages(toDisplayMessages(messages, options));
}

export function estimateBase64DecodedBytes(data: string): number | undefined {
  const normalized = normalizeBase64ImageData(data).trim().replace(/\s+/g, "");
  if (!normalized) return 0;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.length % 4 !== 0) return undefined;
  const padding = normalized.endsWith("==") ? 2 : normalized.endsWith("=") ? 1 : 0;
  return Math.max(0, (normalized.length / 4) * 3 - padding);
}

function normalizeBase64ImageData(data: string): string {
  const match = /^data:[^;]+;base64,(.*)$/i.exec(data.trim());
  return match?.[1] ?? data;
}
