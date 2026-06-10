import { readFileSync } from "node:fs";
import type { Message, MessageBlock } from "../types/messages.js";
import { readImageNoteForStoragePathSync, type ImageNote } from "./image-notes.js";

export interface ImageEntry {
  id: string;
  label?: string;
  mimeType: string;
  storagePath?: string;
  storageFormat?: "base64" | "data-url";
  sourceMessageId: string;
  sourceRole: string;
  origin: "user" | "generated" | "tool" | "unknown";
  /** Approximate index within the conversation timeline. */
  turnIndex: number;
  /** Text from the same source message, useful for choosing which image to load without sending pixels. */
  sourceTextSnippet?: string;
  /** Agent-authored semantic note recorded after visually inspecting the image. */
  note?: ImageNote;
}

export interface ImageRegistry {
  images: ImageEntry[];
}

/**
 * Scan messages and build a registry of all images encountered.
 * Each image block gets a stable entry with enough info to reload later.
 */
export function buildImageRegistry(messages: readonly Message[], startingTurnIndex = 0): ImageRegistry {
  const images: ImageEntry[] = [];
  let turnIndex = startingTurnIndex;

  for (const message of messages) {
    const sourceTextSnippet = extractMessageTextSnippet(message);
    for (const block of message.blocks) {
      if (block.type !== "image") continue;
      const storagePath = block.storage?.path;
      images.push({
        id: `img_${images.length + 1}`,
        label: block.label,
        mimeType: block.mimeType,
        storagePath,
        storageFormat: block.storage?.format,
        sourceMessageId: message.id,
        sourceRole: message.role,
        origin: inferImageOrigin(message, block),
        turnIndex,
        sourceTextSnippet,
        note: storagePath ? readImageNoteForStoragePathSync(storagePath) : undefined,
      });
    }
    turnIndex += 1;
  }

  return { images };
}

/**
 * Merge a previous registry (from a compact boundary) with newly extracted entries,
 * deduplicating by storagePath when available.
 */
export function mergeImageRegistries(previous: ImageRegistry, current: ImageRegistry): ImageRegistry {
  const seen = new Set<string>();
  const merged: ImageEntry[] = [];

  for (const entry of previous.images) {
    const key = entry.storagePath ?? `${entry.sourceMessageId}:${entry.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(entry);
  }

  for (const entry of current.images) {
    const key = entry.storagePath ?? `${entry.sourceMessageId}:${entry.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push({ ...entry, id: `img_${merged.length + 1}` });
  }

  return { images: merged };
}

/**
 * Extract a previously persisted ImageRegistry from a compact boundary message's metadata.
 */
export function extractRegistryFromBoundary(messages: readonly Message[]): ImageRegistry | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const meta = messages[i].metadata;
    if (meta?.compactBoundary && meta.imageRegistry) {
      return meta.imageRegistry as ImageRegistry;
    }
  }
  return undefined;
}

/**
 * Build a human-readable listing of available images for the model to reference.
 */
export function formatImageRegistryForContext(registry: ImageRegistry): string {
  if (registry.images.length === 0) return "";
  const lines = registry.images.map((entry) => {
    const label = entry.label ? `"${escapeInline(entry.label)}"` : `unlabeled`;
    const origin = entry.origin !== "unknown" ? `, origin=${entry.origin}` : "";
    const alias = entry.label && /^gen#\d+$/iu.test(entry.label.trim()) ? `${entry.label.trim()}: ` : "";
    const context = entry.sourceTextSnippet ? `, context="${escapeInline(truncate(entry.sourceTextSnippet, 160))}"` : "";
    const note = formatImageNoteInline(entry.note);
    const storage = entry.storagePath ? `, uri=neo://image/${entry.id}` : ", no stored payload";
    return `- ${alias}${entry.id}: ${label}, ${entry.mimeType}${origin}${context}${note}${storage}`;
  });
  return [
    "Available images from conversation history (use load_image tool with the id to examine any image):",
    ...lines,
  ].join("\n");
}

/**
 * Load the raw base64 data for an image entry. Returns undefined if unreadable.
 */
export function loadImageData(entry: ImageEntry): string | undefined {
  if (!entry.storagePath) return undefined;
  try {
    return readFileSync(entry.storagePath, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Resolve an image reference (id like "img_3", label, or storage path) against a registry.
 */
export function resolveImageRef(registry: ImageRegistry, ref: string): ImageEntry | undefined {
  const normalized = ref.trim().toLowerCase();

  const byId = registry.images.find((e) => e.id.toLowerCase() === normalized);
  if (byId) return byId;

  const genMatch = /^\[?gen#?(\d+)\]?$/i.exec(normalized);
  if (genMatch) {
    const canonical = `gen#${Number(genMatch[1])}`;
    const generated = registry.images.find((e) => e.label?.toLowerCase() === canonical);
    if (generated) return generated;
  }

  const numMatch = /^(?:\[?img[_#]?|image\s*)?(\d+)\]?$/i.exec(normalized);
  if (numMatch) {
    const idx = Number(numMatch[1]) - 1;
    if (idx >= 0 && idx < registry.images.length) return registry.images[idx];
  }

  const byLabel = registry.images.find((e) => e.label?.toLowerCase() === normalized);
  if (byLabel) return byLabel;

  const byPath = registry.images.find((e) =>
    e.storagePath?.toLowerCase() === normalized ||
    e.storagePath?.toLowerCase().endsWith(normalized),
  );
  if (byPath) return byPath;

  return undefined;
}

function inferImageOrigin(message: Message, _block: MessageBlock): ImageEntry["origin"] {
  if (message.role === "user") return "user";
  if (message.metadata?.generatedImages || message.metadata?.tool === "image2") return "generated";
  if (message.role === "tool_result") return "tool";
  if (message.role === "assistant") return "generated";
  return "unknown";
}

function extractMessageTextSnippet(message: Message): string | undefined {
  const text = message.blocks
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join(" ")
    .replace(/\s+/gu, " ")
    .trim();
  return text ? truncate(text, 240) : undefined;
}

function formatImageNoteInline(note: ImageEntry["note"]): string {
  if (!note) return "";
  const parts: string[] = [];
  if (note.caption) parts.push(`caption="${escapeInline(truncate(note.caption, 160))}"`);
  if (note.purpose) parts.push(`purpose="${escapeInline(truncate(note.purpose, 120))}"`);
  if (note.detectedText?.length) parts.push(`text="${escapeInline(truncate(note.detectedText.join(" | "), 160))}"`);
  if (note.tags?.length) parts.push(`tags=${note.tags.slice(0, 8).join(",")}`);
  if (note.retention) parts.push(`retention=${note.retention}${note.ttlTurns ? `:${note.ttlTurns}` : ""}`);
  return parts.length > 0 ? `, ${parts.join(", ")}` : "";
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function escapeInline(text: string): string {
  return text.replace(/[\r\n]+/gu, " ").replace(/"/gu, "'");
}
