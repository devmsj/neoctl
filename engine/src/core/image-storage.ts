import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { getNeoctlHome } from "../paths.js";
import { createImageId, type MessageBlock } from "../types/messages.js";

export interface PersistMessageImagesOptions {
  sessionDir?: string;
  agentId?: string;
}

type ImageBlock = Extract<MessageBlock, { type: "image" }>;
type ImageStorageLike = { path: string; format?: string; contentHash?: string; storedBytes?: number };

export type ImageDataResolution =
  | { available: true; data: string }
  | { available: false; error: "missing-payload" | "storage-unreadable" | "storage-size-mismatch" | "invalid-payload" | "content-hash-mismatch" };

export function resolveStoredImageDataSync(storage: ImageStorageLike | undefined): string | undefined {
  const resolved = resolveStoredImageDataResultSync(storage);
  return resolved.available ? resolved.data : undefined;
}

export function resolveStoredImageDataResultSync(storage: ImageStorageLike | undefined): ImageDataResolution {
  if (!storage?.path) return { available: false, error: "missing-payload" };
  let data: string;
  try {
    data = readFileSync(storage.path, "utf8");
  } catch {
    return { available: false, error: "storage-unreadable" };
  }
  if (storage.storedBytes !== undefined && Buffer.byteLength(data, "utf8") !== storage.storedBytes) {
    return { available: false, error: "storage-size-mismatch" };
  }
  const parsed = parseImagePayload(data);
  if (!parsed) return { available: false, error: "invalid-payload" };
  if (storage.contentHash && hashBytes(parsed.bytes) !== storage.contentHash) {
    return { available: false, error: "content-hash-mismatch" };
  }
  return { available: true, data };
}

export function resolveImageBlockDataSync(block: { data: string; storage?: ImageStorageLike }): string | undefined {
  const resolved = resolveImageBlockDataResultSync(block);
  return resolved.available ? resolved.data : undefined;
}

export function resolveImageBlockDataResultSync(block: { data: string; storage?: ImageStorageLike }): ImageDataResolution {
  const inline = block.data.trim();
  if (!inline) return resolveStoredImageDataResultSync(block.storage);

  const inlinePayload = parseImagePayload(inline);
  if (!inlinePayload) return { available: false, error: "invalid-payload" };
  if (!block.storage?.path) return { available: true, data: inline };

  const stored = resolveStoredImageDataResultSync(block.storage);
  if (!stored.available) return stored;
  const storedPayload = parseImagePayload(stored.data);
  if (!storedPayload || hashBytes(storedPayload.bytes) !== hashBytes(inlinePayload.bytes)) {
    return { available: false, error: "content-hash-mismatch" };
  }
  return { available: true, data: inline };
}

export function resolveImageBlockDataLengthSync(block: { data: string; storage?: ImageStorageLike }): number {
  const inline = block.data.trim();
  if (inline) return inline.length;
  if (!block.storage?.path) return 0;
  try {
    return statSync(block.storage.path).size;
  } catch {
    return 0;
  }
}

export async function persistMessageImages(blocks: readonly MessageBlock[], options: PersistMessageImagesOptions = {}): Promise<MessageBlock[]> {
  let changed = false;
  const persisted: MessageBlock[] = [];

  for (const block of blocks) {
    if (block.type !== "image") {
      persisted.push(block);
      continue;
    }

    const stored = await persistImageBlock(block, options);
    persisted.push(stored);
    if (stored !== block) changed = true;
  }

  return changed ? persisted : [...blocks];
}

async function persistImageBlock(block: ImageBlock, options: PersistMessageImagesOptions): Promise<ImageBlock> {
  const imageId = block.imageId?.trim() || createImageId();
  const inline = block.data.trim();
  if (block.storage?.path) {
    const storedData = await fs.readFile(block.storage.path, "utf8");
    const parsed = requireValidImagePayload(storedData, block.mimeType);
    const contentHash = hashBytes(parsed.bytes);
    const storedBytes = Buffer.byteLength(storedData, "utf8");
    if (inline) {
      const inlineParsed = requireValidImagePayload(inline, block.mimeType);
      if (hashBytes(inlineParsed.bytes) !== contentHash) throw new Error(`Inline and stored image payload differ for ${imageId}`);
    }
    const unchanged = block.imageId === imageId
      && !inline
      && block.storage.contentHash === contentHash
      && block.storage.storedBytes === storedBytes;
    if (unchanged) return block;
    return {
      ...block,
      imageId,
      data: "",
      storage: { ...block.storage, contentHash, storedBytes },
    };
  }

  const parsed = requireValidImagePayload(inline, block.mimeType);
  const contentHash = hashBytes(parsed.bytes);
  const storedBytes = Buffer.byteLength(inline, "utf8");
  const directory = options.sessionDir
    ? path.join(options.sessionDir, "attachments", "images")
    : path.join(getNeoctlHome(), "attachments", options.agentId ?? "main", "images");
  await fs.mkdir(directory, { recursive: true });
  const filePath = path.join(directory, `${safeImageId(imageId)}-${contentHash.slice(0, 12)}.base64.txt`);
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeAndSync(temporaryPath, inline);
    const verifyData = await fs.readFile(temporaryPath, "utf8");
    const verified = requireValidImagePayload(verifyData, block.mimeType);
    if (Buffer.byteLength(verifyData, "utf8") !== storedBytes || hashBytes(verified.bytes) !== contentHash) {
      throw new Error(`Image persistence verification failed for ${imageId}`);
    }
    await fs.rename(temporaryPath, filePath);
    await syncFile(filePath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
  return {
    ...block,
    imageId,
    data: "",
    storage: {
      path: filePath,
      format: parsed.format,
      contentHash,
      storedBytes,
    },
  };
}

async function writeAndSync(filePath: string, data: string): Promise<void> {
  const handle = await fs.open(filePath, "wx");
  try {
    await handle.writeFile(data, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncFile(filePath: string): Promise<void> {
  const handle = await fs.open(filePath, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function requireValidImagePayload(data: string, expectedMimeType: string): { bytes: Buffer; format: "base64" | "data-url" } {
  const parsed = parseImagePayload(data);
  if (!parsed) throw new Error("Image payload must be non-empty, valid base64 data");
  if (!expectedMimeType.toLowerCase().startsWith("image/")) throw new Error(`Invalid image MIME type: ${expectedMimeType}`);
  if (parsed.mimeType && parsed.mimeType.toLowerCase() !== expectedMimeType.toLowerCase()) {
    throw new Error(`Image MIME type mismatch: block=${expectedMimeType}, payload=${parsed.mimeType}`);
  }
  return { bytes: parsed.bytes, format: parsed.format };
}

function parseImagePayload(data: string): { bytes: Buffer; format: "base64" | "data-url"; mimeType?: string } | undefined {
  const trimmed = data.trim();
  if (!trimmed) return undefined;
  const dataUrl = /^data:([^;,]+);base64,([\s\S]*)$/iu.exec(trimmed);
  const encoded = (dataUrl?.[2] ?? trimmed).replace(/\s+/gu, "");
  if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded)) return undefined;
  const bytes = Buffer.from(encoded, "base64");
  if (!bytes.length || bytes.toString("base64").replace(/=+$/u, "") !== encoded.replace(/=+$/u, "")) return undefined;
  return { bytes, format: dataUrl ? "data-url" : "base64", mimeType: dataUrl?.[1] };
}

function hashBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeImageId(imageId: string): string {
  return imageId.replace(/[^A-Za-z0-9._-]/gu, "_");
}
