import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pngPixel } from "../fixtures/png-pixel.js";
import { imageContextWarning } from "../../src/core/image-context-limit.js";
import { SessionImageStore } from "../../src/core/session-images.js";
import { createLoadImageTool } from "../../src/tools/builtins/image-loader-tool.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { InMemoryAppState } from "../../src/app/app-state.js";
import { buildWebPromptPayload } from "../../src/web/index.js";
import { createTextMessage } from "../../src/types/messages.js";
import { messageFileAttachments } from "../../src/web/file-attachments.js";

const wide = pngPixel(0, 3001, 1);
const tall = pngPixel(0, 1, 3002);
test("context image limit checks either edge, permits exactly 3000 and actual MIME", () => {
  for (const bytes of [wide, tall]) assert.match(imageContextWarning(`data:image/jpeg;base64,${bytes.toString("base64")}`)!, /3000.*pixels were not added/s);
  for (const bytes of [pngPixel(), pngPixel(0, 3000, 1), pngPixel(0, 1, 3000)]) assert.equal(imageContextWarning(bytes.toString("base64")), undefined);
});

test("JPEG, GIF, lossy/lossless and animated WebP dimensions are blocked", async () => {
  // Pillow-generated 3001×1 originals; no image library is needed at test runtime.
  const fixtures = JSON.parse(await fs.readFile(new URL("../fixtures/oversized-images.json", import.meta.url), "utf8")) as Record<string, string>;
  for (const [format, data] of Object.entries(fixtures)) assert.match(imageContextWarning(data)!, /3001×1.*3000/, format);
});

test("inspect skips oversized external and registered images, preserves good refs, returns warning only when all blocked", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "neo-image-limit-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const big = path.join(dir, "oversized.jpg"), good = path.join(dir, "good.png");
  await fs.writeFile(big, tall); await fs.writeFile(good, pngPixel());
  const imageStore = await SessionImageStore.open(dir);
  const registered = await imageStore.importFile(wide.toString("base64"), "image/png", path.join(dir, "history.png"), "history.png");
  const context = { agentId: "test", imageStore, tools: new ToolRegistry(), appState: new InMemoryAppState("test", dir), messages: [], emit() {} };
  const tool = createLoadImageTool();
  const blocked = await tool.call!({ imageRefs: [big, registered.imageId!] }, context, {});
  assert.equal(blocked.ok, true); assert.equal(blocked.newMessages, undefined);
  assert.equal((blocked.output as { warnings: string[] }).warnings.length, 2);
  const rendered = tool.renderToolResultMessage!(blocked, { id: "call", name: "image_inspect", input: {} });
  assert.match(JSON.stringify(rendered), /Warning:.*3000/);
  assert.doesNotMatch(JSON.stringify(rendered), /You can now see/);
  const mixed = await tool.call!({ imageRefs: [big, good] }, context, {});
  assert.equal(mixed.ok, true);
  assert.equal(mixed.newMessages?.flatMap(m => m.blocks).filter(b => b.type === "image").length, 1);
  assert.equal((mixed.output as { warnings: string[] }).warnings.length, 1);
  assert.deepEqual(await fs.readFile(big), tall);
});

test("user oversized images become exact-byte files with processing notice; normal images remain inline", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "neo-user-image-limit-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const attachments = [wide, pngPixel(), tall].map((bytes, i) => ({ kind: "image" as const, imageId: `image_${i}`, label: `[img#${i + 1}]`, mimeType: "image/png", data: bytes.toString("base64") }));
  const display = "Compare [img#1] [img#2] [img#3]";
  const result = await buildWebPromptPayload(display, attachments, dir);
  assert.equal(result.displayText, display);
  const images = result.blocks!.filter(b => b.type === "image");
  assert.equal(images.length, 1); assert.equal(images[0].data, attachments[1].data);
  assert.match(result.text, /System image notice.*3000/s);
  assert.match(result.text, /Resize or split.*image_inspect/s);
  assert.ok(!JSON.stringify(result.blocks).includes(attachments[0].data));
  const files = messageFileAttachments({ ...createTextMessage("user", result.text), blocks: result.blocks! });
  assert.equal(files.length, 2);
  assert.deepEqual(await fs.readFile(files[0].absolutePath), wide);
  assert.deepEqual(await fs.readFile(files[1].absolutePath), tall);
  const only = await buildWebPromptPayload("[img#1]", [attachments[0]], dir);
  assert.equal(only.blocks!.filter(b => b.type === "image").length, 0);
  const boundary = await buildWebPromptPayload("[img#1]", [{ ...attachments[0], data: pngPixel(0, 3000, 1).toString("base64") }], dir);
  assert.equal(boundary.blocks!.filter(b => b.type === "image").length, 1);
});
