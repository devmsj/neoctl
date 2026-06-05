import { readFileSync, statSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { getNeoctlHome } from "../paths.js";
import type { MessageBlock } from "../types/messages.js";

export interface PersistMessageImagesOptions {
  sessionDir?: string;
  agentId?: string;
}

type ImageBlock = Extract<MessageBlock, { type: "image" }>;
type ImageStorageLike = { path: string; format?: string };

export function resolveStoredImageDataSync(storage: ImageStorageLike | undefined): string | undefined {
  if (!storage?.path) return undefined;
  try {
    return readFileSync(storage.path, "utf8");
  } catch {
    return undefined;
  }
}

export function resolveImageBlockDataSync(block: { data: string; storage?: ImageStorageLike }): string | undefined {
  const inline = block.data.trim();
  if (inline) return inline;
  return resolveStoredImageDataSync(block.storage);
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
  let imageIndex = 0;

  for (const block of blocks) {
    if (block.type !== "image" || block.storage?.path) {
      persisted.push(block);
      continue;
    }

    imageIndex += 1;
    const stored = await persistImageBlock(block, imageIndex, options);
    persisted.push(stored);
    changed = true;
  }

  return changed ? persisted : [...blocks];
}

async function persistImageBlock(block: ImageBlock, imageIndex: number, options: PersistMessageImagesOptions): Promise<ImageBlock> {
  const directory = options.sessionDir
    ? path.join(options.sessionDir, "attachments", "images")
    : path.join(getNeoctlHome(), "attachments", options.agentId ?? "main", "images");
  await fs.mkdir(directory, { recursive: true });
  const filePath = path.join(directory, `${new Date().toISOString().replace(/[:.]/g, "-")}-${imageIndex}-${randomSuffix()}.base64.txt`);
  await fs.writeFile(filePath, block.data, "utf8");
  return {
    ...block,
    data: "",
    storage: {
      path: filePath,
      format: block.data.trimStart().startsWith("data:") ? "data-url" : "base64",
    },
  };
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}
