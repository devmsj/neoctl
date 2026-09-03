import type { Message, MessageBlock } from "../types/messages.js";
import { resolveStoredImageDataSync } from "./image-storage.js";
import { readImageNoteForStoragePathSync, type ImageNote } from "./image-notes.js";

export interface ImageEntry {
  /** Stable human-friendly alias persisted in compact boundaries (for example img_3). */
  id: string;
  /** Immutable image occurrence identity stored on the source message block. */
  imageId?: string;
  label?: string;
  mimeType: string;
  storagePath?: string;
  storageFormat?: "base64" | "data-url";
  contentHash?: string;
  sourceMessageId: string;
  sourceBlockIndex?: number;
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
    for (const [sourceBlockIndex, block] of message.blocks.entries()) {
      if (block.type !== "image") continue;
      const storagePath = block.storage?.path;
      images.push({
        id: `img_${images.length + 1}`,
        imageId: block.imageId,
        label: block.label,
        mimeType: block.mimeType,
        storagePath,
        storageFormat: block.storage?.format,
        contentHash: block.storage?.contentHash,
        sourceMessageId: message.id,
        sourceBlockIndex,
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
  const usedAliases = new Set<string>();
  const merged: ImageEntry[] = [];
  let nextAlias = Math.max(0, ...previous.images.map((entry) => numericImageAlias(entry.id))) + 1;

  for (const entry of previous.images) {
    const key = imageEntryKey(entry);
    if (seen.has(key)) continue;
    if (usedAliases.has(entry.id.toLowerCase())) throw new Error(`Duplicate image registry id: ${entry.id}`);
    seen.add(key);
    usedAliases.add(entry.id.toLowerCase());
    merged.push(entry);
  }

  for (const entry of current.images) {
    const key = imageEntryKey(entry);
    if (seen.has(key)) continue;
    while (usedAliases.has(`img_${nextAlias}`)) nextAlias += 1;
    const id = `img_${nextAlias}`;
    nextAlias += 1;
    seen.add(key);
    usedAliases.add(id);
    merged.push({ ...entry, id });
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
  return resolveStoredImageDataSync({
    path: entry.storagePath,
    format: entry.storageFormat,
    contentHash: entry.contentHash,
  });
}

export type ImageRefResolution =
  | { status: "resolved"; entry: ImageEntry }
  | { status: "not-found" }
  | { status: "ambiguous"; candidates: ImageEntry[] };

/** Resolve exact identities first. Display labels and path suffixes only resolve when unique. */
export function resolveImageRefResult(registry: ImageRegistry, ref: string): ImageRefResolution {
  const normalized = ref.trim().toLowerCase();
  if (!normalized) return { status: "not-found" };

  const exactIdentity = uniqueResolution(registry.images.filter((entry) =>
    entry.id.toLowerCase() === normalized || entry.imageId?.toLowerCase() === normalized,
  ));
  if (exactIdentity.status !== "not-found") return exactIdentity;

  const genMatch = /^\[?gen#?(\d+)\]?$/i.exec(normalized);
  if (genMatch) {
    const canonical = `gen#${Number(genMatch[1])}`;
    const generated = uniqueResolution(registry.images.filter((entry) => entry.label?.toLowerCase() === canonical));
    if (generated.status !== "not-found") return generated;
  }

  const normalizedLabel = normalizeImageRefText(ref);
  const byLabel = uniqueResolution(registry.images.filter((entry) => normalizeImageRefText(entry.label) === normalizedLabel));
  if (byLabel.status !== "not-found") return byLabel;

  const byPath = uniqueResolution(registry.images.filter((entry) =>
    entry.storagePath?.toLowerCase() === normalized || entry.storagePath?.toLowerCase().endsWith(normalized),
  ));
  if (byPath.status !== "not-found") return byPath;

  // Compatibility fallback for old bare numeric references. It is intentionally last.
  const numMatch = /^(?:image\s*)?(\d+)$/i.exec(normalized);
  if (numMatch) {
    const idx = Number(numMatch[1]) - 1;
    if (idx >= 0 && idx < registry.images.length) return { status: "resolved", entry: registry.images[idx] };
  }

  return { status: "not-found" };
}

export function resolveImageRef(registry: ImageRegistry, ref: string): ImageEntry | undefined {
  const result = resolveImageRefResult(registry, ref);
  return result.status === "resolved" ? result.entry : undefined;
}

function uniqueResolution(candidates: ImageEntry[]): ImageRefResolution {
  if (candidates.length === 0) return { status: "not-found" };
  if (candidates.length === 1) return { status: "resolved", entry: candidates[0] };
  return { status: "ambiguous", candidates };
}

function imageEntryKey(entry: ImageEntry): string {
  if (entry.imageId) return `imageId:${entry.imageId.toLowerCase()}`;
  if (entry.storagePath) return `path:${entry.storagePath.toLowerCase()}`;
  return `block:${entry.sourceMessageId}:${entry.sourceBlockIndex ?? entry.label ?? "unknown"}`;
}

function numericImageAlias(id: string): number {
  const match = /^img_(\d+)$/iu.exec(id);
  return match ? Number(match[1]) : 0;
}

function normalizeImageRefText(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/^\[/u, "").replace(/\]$/u, "").replace(/^img#/u, "img_");
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
