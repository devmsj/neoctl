import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { persistMessageImages, resolveImageBlockDataResultSync } from "./image-storage.js";
import { buildImageRegistry, mergeImageRegistries, resolveImageRefResult } from "./image-registry.js";
import { SessionStore } from "../session/session-store.js";
import { toDisplayImageBlock } from "../ui/display-message.js";
import type { Message, MessageBlock } from "../types/messages.js";

const PIXEL_A = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const PIXEL_B = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlHkAAAAASUVORK5CYII=";

async function main(): Promise<void> {
  const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "neoctl-image-integrity-"));
  try {
    const source: MessageBlock[] = [
      { type: "image", imageId: "image_00000000-0000-4000-a000-000000000001", label: "[img#1]", mimeType: "image/png", data: PIXEL_A },
      { type: "image", imageId: "image_00000000-0000-4000-a000-000000000002", label: "[img#1]", mimeType: "image/png", data: PIXEL_B },
    ];
    const persisted = await persistMessageImages(source, { sessionDir });
    const first = persisted[0];
    const second = persisted[1];
    assert.equal(first.type, "image");
    assert.equal(second.type, "image");
    assert.notEqual(first.storage?.path, second.storage?.path);
    assert.equal(first.imageId, source[0].type === "image" ? source[0].imageId : undefined);
    assert.match(first.storage?.contentHash ?? "", /^[0-9a-f]{64}$/u);
    assert.equal(resolveImageBlockDataResultSync(first).available, true);
    const conflictingInline = resolveImageBlockDataResultSync({ ...first, data: PIXEL_B });
    assert.equal(conflictingInline.available, false);
    assert.equal(conflictingInline.available ? undefined : conflictingInline.error, "content-hash-mismatch");

    const messages: Message[] = [message("m1", first), message("m2", second)];
    const registry = buildImageRegistry(messages);
    assert.equal(resolveImageRefResult(registry, first.imageId ?? "").status, "resolved");
    const duplicateLabel = resolveImageRefResult(registry, "[img#1]");
    assert.equal(duplicateLabel.status, "ambiguous");

    // Simulate a full core restart: only transcript JSON and attachment files survive.
    const rootDir = path.join(sessionDir, "sessions");
    const store = await SessionStore.open({ agentId: "main", rootDir, sessionId: "restart-session" });
    for (const item of messages) store.recordMessage(item);
    const restarted = await SessionStore.open({ agentId: "main", rootDir, sessionId: "restart-session", resume: true });
    const restartedMessages = restarted.getInitialMessages();
    const restartedImages = restartedMessages.flatMap((item) => item.blocks.filter((block) => block.type === "image"));
    assert.deepEqual(restartedImages.map((block) => block.imageId), [first.imageId, second.imageId]);
    assert.deepEqual(restartedImages.map((block) => block.storage?.path), [first.storage?.path, second.storage?.path]);
    assert.deepEqual(buildImageRegistry(restartedMessages).images.map((entry) => entry.imageId), [first.imageId, second.imageId]);

    const previous = { images: [{ ...registry.images[0], id: "img_8" }] };
    const merged = mergeImageRegistries(previous, { images: [registry.images[0], registry.images[1]] });
    assert.deepEqual(merged.images.map((entry) => entry.id), ["img_8", "img_9"]);
    assert.equal(merged.images[0].imageId, first.imageId);

    await fs.writeFile(first.storage!.path, PIXEL_B, "utf8");
    const corrupt = resolveImageBlockDataResultSync(first);
    assert.equal(corrupt.available, false);
    assert.equal(corrupt.available ? undefined : corrupt.error, "content-hash-mismatch");
    const display = toDisplayImageBlock(first);
    assert.equal(display?.available, false);
    assert.equal(display?.thumbnail, undefined);

    console.log("smoke-image-integrity: ok");
  } finally {
    await fs.rm(sessionDir, { recursive: true, force: true });
  }
}

function message(id: string, block: MessageBlock): Message {
  return { id, role: "user", createdAt: new Date(0).toISOString(), blocks: [block] };
}

void main();
