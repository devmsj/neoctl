import { existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { getNeoctlHome } from "../paths.js";

export type ImageRetention = "next_turn" | "while_relevant" | "pinned";

export interface ImageNote {
  caption?: string;
  purpose?: string;
  detectedText?: string[];
  tags?: string[];
  /** Model-chosen pixel retention decision for this image. */
  retention?: ImageRetention;
  /** For while_relevant retention, number of assistant turns to keep pixels directly visible. */
  ttlTurns?: number;
  updatedAt?: string;
}

export interface ImageNotesFile {
  byStoragePath: Record<string, ImageNote>;
}

const METADATA_FILE = "metadata.json";

export function normalizeImageStoragePath(storagePath: string): string {
  return path.resolve(storagePath);
}

export function imageMetadataPathForStoragePath(storagePath: string): string {
  return path.join(path.dirname(normalizeImageStoragePath(storagePath)), METADATA_FILE);
}

export function defaultImageMetadataPath(agentId = "main"): string {
  return path.join(getNeoctlHome(), "attachments", agentId, "images", METADATA_FILE);
}

export function readImageNoteForStoragePathSync(storagePath: string): ImageNote | undefined {
  const metadataPath = imageMetadataPathForStoragePath(storagePath);
  const notes = readImageNotesFileSync(metadataPath);
  return notes.byStoragePath[normalizeImageStoragePath(storagePath)];
}

export async function writeImageNoteForStoragePath(storagePath: string, note: ImageNote): Promise<ImageNote> {
  const normalizedStoragePath = normalizeImageStoragePath(storagePath);
  const metadataPath = imageMetadataPathForStoragePath(normalizedStoragePath);
  const notes = await readImageNotesFile(metadataPath);
  const previous = notes.byStoragePath[normalizedStoragePath] ?? {};
  const merged = normalizeImageNote({
    ...previous,
    ...note,
    updatedAt: new Date().toISOString(),
  });
  notes.byStoragePath[normalizedStoragePath] = merged;
  await fs.mkdir(path.dirname(metadataPath), { recursive: true });
  await fs.writeFile(metadataPath, `${JSON.stringify(notes, null, 2)}\n`, "utf8");
  return merged;
}

export function normalizeImageNote(note: ImageNote): ImageNote {
  const normalized: ImageNote = {};
  if (note.caption?.trim()) normalized.caption = compactText(note.caption, 500);
  if (note.purpose?.trim()) normalized.purpose = compactText(note.purpose, 300);
  if (Array.isArray(note.detectedText)) {
    const detectedText = dedupe(note.detectedText.map((item) => compactText(item, 160)).filter(Boolean));
    if (detectedText.length > 0) normalized.detectedText = detectedText.slice(0, 20);
  }
  if (Array.isArray(note.tags)) {
    const tags = dedupe(note.tags.map((tag) => tag.trim().toLowerCase().replace(/\s+/gu, "-")).filter(Boolean)).sort();
    if (tags.length > 0) normalized.tags = tags.slice(0, 20);
  }
  if (isImageRetention(note.retention)) normalized.retention = note.retention;
  if (note.ttlTurns !== undefined && Number.isFinite(note.ttlTurns)) {
    normalized.ttlTurns = Math.max(1, Math.min(12, Math.round(note.ttlTurns)));
  }
  if (note.updatedAt?.trim()) normalized.updatedAt = note.updatedAt;
  return normalized;
}

async function readImageNotesFile(metadataPath: string): Promise<ImageNotesFile> {
  try {
    const raw = await fs.readFile(metadataPath, "utf8");
    return normalizeImageNotesFile(JSON.parse(raw));
  } catch {
    return { byStoragePath: {} };
  }
}

function readImageNotesFileSync(metadataPath: string): ImageNotesFile {
  if (!existsSync(metadataPath)) return { byStoragePath: {} };
  try {
    return normalizeImageNotesFile(JSON.parse(readFileSync(metadataPath, "utf8")));
  } catch {
    return { byStoragePath: {} };
  }
}

function normalizeImageNotesFile(value: unknown): ImageNotesFile {
  if (!value || typeof value !== "object") return { byStoragePath: {} };
  const record = value as Record<string, unknown>;
  const raw = record.byStoragePath;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { byStoragePath: {} };
  const byStoragePath: Record<string, ImageNote> = {};
  for (const [key, note] of Object.entries(raw as Record<string, unknown>)) {
    if (!note || typeof note !== "object" || Array.isArray(note)) continue;
    byStoragePath[normalizeImageStoragePath(key)] = normalizeImageNote(note as ImageNote);
  }
  return { byStoragePath };
}

function isImageRetention(value: unknown): value is ImageRetention {
  return value === "next_turn" || value === "while_relevant" || value === "pinned";
}

function compactText(value: string, max: number): string {
  const compacted = value.replace(/\s+/gu, " ").trim();
  return compacted.length > max ? `${compacted.slice(0, max - 1)}…` : compacted;
}

function dedupe(items: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of items) {
    if (seen.has(item)) continue;
    seen.add(item);
    result.push(item);
  }
  return result;
}
