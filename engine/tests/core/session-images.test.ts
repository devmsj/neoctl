import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionImageStore, resolveContextImage } from "../../src/core/session-images.js";
import { buildImageRegistry, mergeImageRegistries, formatImageRegistryForContext, type ImageRegistry } from "../../src/core/image-registry.js";
import { applyImageRetention } from "../../src/core/query.js";
import { QueryEngine, type QueryEngineOptions } from "../../src/core/query-engine.js";
import { DeterministicCompactor } from "../../src/context/compaction.js";
import { SessionStore } from "../../src/session/session-store.js";
import { createLoadImageTool, type LoadImageToolOutput } from "../../src/tools/builtins/image-loader-tool.js";
import { createOpenAIImageGenerationTool, type ImageGenerationToolOutput } from "../../src/tools/builtins/image-generation-tool.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { InMemoryAppState } from "../../src/app/app-state.js";
import type { ToolUseContext } from "../../src/tools/tool.js";
import { createTextMessage, type Message, type ImageMessageBlock } from "../../src/types/messages.js";
import type { ModelStreamEvent } from "../../src/model/model-gateway.js";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z0ioAAAAASUVORK5CYII=";
const other = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
function imageMessage(id: string, block: Partial<ImageMessageBlock> = {}): Message {
  return { id, role: "user", createdAt: new Date().toISOString(), isMeta: true, metadata: { imageRetention: "next_turn" }, blocks: [{ type: "image", mimeType: "image/png", data: png, label: "same.png", ...block }] };
}
function context(imageStore: SessionImageStore, messages: Message[] = []): ToolUseContext {
  return { agentId: "image-regression", tools: new ToolRegistry(), appState: new InMemoryAppState("test", process.cwd()), imageStore, messages, emit() {} };
}
async function temporary(t: { after(fn: () => Promise<void>): void }): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "neo-session-images-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test("inspect returns reusable identity; repeated file reads reuse it and changed bytes create a version", async t => {
  const dir = await temporary(t);
  const file = path.join(dir, "source.png");
  await fs.writeFile(file, Buffer.from(png, "base64"));
  const store = await SessionImageStore.open(dir);
  const tool = createLoadImageTool();
  const ctx = context(store);
  const first = await tool.call!({ imageRefs: [file], retention: "next_turn" }, ctx, {});
  const info = (first.output as LoadImageToolOutput).loadedImages[0];
  assert.match(info.id, /^image_/);
  assert.equal(info.alias, "img_1");
  assert.match(JSON.stringify(tool.renderToolResultMessage!(first, { id: "call", name: "image_inspect", input: {} })), new RegExp(info.id));
  for (const ref of [info.id, info.alias!, "[img#1]", "image 1"]) {
    assert.equal((await tool.call!({ imageRefs: [ref] }, ctx, {})).ok, true);
    assert.equal(resolveContextImage(ctx, ref).data, png);
  }
  await tool.call!({ imageRefs: [file] }, ctx, {});
  assert.equal(store.snapshot().images.length, 1);
  await fs.writeFile(file, Buffer.from(other, "base64"));
  const updated = await tool.call!({ imageRefs: [file] }, ctx, {});
  const second = (updated.output as LoadImageToolOutput).loadedImages[0];
  assert.notEqual(second.id, info.id);
  assert.equal(resolveContextImage(ctx, info.id).data, png);
  assert.equal(resolveContextImage(ctx, second.id).data, other);
  const listing = await tool.call!({ mode: "list", imageRefs: [], offset: 1, limit: 1 }, ctx, {});
  assert.deepEqual((listing.output as { images: { id: string }[] }).images.map(item => item.id), [second.id]);
  assert.equal((listing.output as { total: number }).total, 2);
});

test("seven successive compactions and restart retain exact source bytes independently of message window", async t => {
  const dir = await temporary(t);
  let store = await SessionImageStore.open(dir);
  let messages = [await store.persistMessage(imageMessage("original"))];
  const original = messages[0].blocks[0] as ImageMessageBlock;
  const compactor = new DeterministicCompactor();
  for (let i = 0; i < 7; i++) {
    messages.push(await store.persistMessage(imageMessage(`next-${i}`, { data: other })));
    messages = (await compactor.manualCompact(messages, { keepRecentTokenBudget: 0 })).messages;
    assert.equal(messages.flatMap(message => message.blocks).some(block => block.type === "image"), false);
    store = await SessionImageStore.open(dir);
    assert.equal(resolveContextImage(context(store, messages), original.imageId!).data, png);
    assert.equal(resolveContextImage(context(store, []), original.imageAlias!).data, png);
    const edit = createOpenAIImageGenerationTool();
    assert.equal((await edit.validateInput!({ mode: "edit", semanticName: "source-check", prompt: "test", imageRefs: [original.imageId!] }, context(store, messages))).ok, true);
  }
  assert.equal(store.snapshot().images.length, 8);
});

test("retention removes only pixels and exposes immutable per-image identities, never local img_1", async t => {
  const dir = await temporary(t);
  const store = await SessionImageStore.open(dir);
  const first = await store.persistMessage(imageMessage("first"));
  const second = await store.persistMessage(imageMessage("second", { data: other }));
  const messages = applyImageRetention([first, second, createTextMessage("assistant", "a"), createTextMessage("assistant", "b")]);
  const text = JSON.stringify(messages);
  assert.match(text, new RegExp((second.blocks[0] as ImageMessageBlock).imageId!));
  assert.doesNotMatch(text, /use load_image|with img_1/);
  assert.equal(messages.flatMap(message => message.blocks).some(block => block.type === "image"), false);
  assert.equal(resolveContextImage(context(store, messages), "img_2").data, other);
});

test("legacy migration repairs checkpoint links by source occurrence and preserves historical aliases", async t => {
  const dir = await temporary(t);
  const sourceDir = path.join(dir, "source");
  const oldStore = await SessionImageStore.open(sourceDir);
  const original = await oldStore.persistMessage(imageMessage("old"));
  const entry = buildImageRegistry([original]).images[0];
  const boundary: Message = { ...createTextMessage("system", "checkpoint"), metadata: { compactBoundary: true, imageRegistry: { images: [{ ...entry, id: "img_696", imageId: undefined, storagePath: undefined, storageFormat: undefined, contentHash: undefined }] } } };
  const transcript = [{ type: "message", message: original }, { type: "compact", replacementMessages: [boundary] }, { type: "compact", replacementMessages: [boundary] }];
  await fs.writeFile(path.join(dir, "transcript.jsonl"), transcript.map(item => JSON.stringify(item)).join("\n") + "\n");
  const before = await fs.readFile(path.join(dir, "transcript.jsonl"), "utf8");
  const restored = await SessionImageStore.open(dir);
  assert.equal(resolveContextImage(context(restored), "img_696").data, png);
  assert.equal(restored.snapshot().images[0].imageId, entry.imageId);
  const next = await restored.persistMessage(imageMessage("new"));
  assert.equal((next.blocks[0] as ImageMessageBlock).imageAlias, "img_697");
  assert.equal(await fs.readFile(path.join(dir, "transcript.jsonl"), "utf8"), before);
  assert.equal(resolveContextImage(context(await SessionImageStore.open(dir)), "img_696").data, png);
});

test("concurrent imports allocate unique persistent aliases and deduplicate repeated same-file imports", async t => {
  const dir = await temporary(t);
  const store = await SessionImageStore.open(dir);
  const blocks = await Promise.all(Array.from({ length: 12 }, (_, i) => store.importFile(png, "image/png", `source-${i}`, "same.png")));
  assert.equal(new Set(blocks.map(block => block.imageAlias)).size, 12);
  const repeats = await Promise.all(Array.from({ length: 12 }, () => store.importFile(png, "image/png", "source-0", "same.png")));
  assert.ok(repeats.every(block => block.imageId === blocks[0].imageId));
  assert.equal((await SessionImageStore.open(dir)).snapshot().images.length, 12);
  assert.throws(() => resolveContextImage(context(store), "same.png"), /ambiguous/);
});

test("generated images expose stable IDs and survive export deletion; payload failures are not unknown references", async t => {
  const dir = await temporary(t);
  const store = await SessionImageStore.open(dir);
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ data: [{ b64_json: png }] })));
  const tool = createOpenAIImageGenerationTool({ apiKey: "test-key" });
  const ctx = context(store);
  const result = await tool.call!({ semanticName: "stable-generated-cat", prompt: "cat", outputDir: dir }, ctx, {});
  assert.equal(result.ok, true);
  const image = (result.output as ImageGenerationToolOutput).images[0];
  assert.ok(image.imageId);
  const message = tool.renderToolResultMessage!(result, { id: "create", name: "image_create", input: {} })!;
  assert.equal((message.blocks.find(block => block.type === "image") as ImageMessageBlock).imageId, image.imageId);
  await fs.unlink(image.path!);
  assert.equal(resolveContextImage(context(await SessionImageStore.open(dir)), image.imageId!).data, png);
  await fs.writeFile(image.storagePath!, other);
  assert.throws(() => resolveContextImage(ctx, image.imageId!), /payload unavailable.*reference exists/);
  assert.throws(() => resolveContextImage(ctx, "missing"), /Unknown image reference/);
});

test("legacy incomplete merge enriches same occurrence without creating a second alias; listings are bounded", () => {
  const raw = buildImageRegistry([imageMessage("same")]);
  const enriched = buildImageRegistry([imageMessage("same", { imageId: "image-fixed", storage: { path: "payload", format: "base64" } })]);
  const merged = mergeImageRegistries(raw, enriched);
  assert.equal(merged.images.length, 1);
  assert.equal(merged.images[0].id, "img_1");
  assert.equal(merged.images[0].imageId, "image-fixed");
  const many = { images: Array.from({ length: 700 }, (_, i) => ({ ...merged.images[0], id: `img_${i + 1}` })) };
  const text = formatImageRegistryForContext(many);
  assert.equal(text.split("\n").filter(line => line.startsWith("- ")).length, 20);
  assert.match(text, /mode=list/);
});

test("QueryEngine tool, runtime, transcript and restored catalog share one identity", async t => {
  const root = await temporary(t);
  const sessionId = "lifecycle";
  const store = await SessionStore.open({ agentId: "test", rootDir: root, sessionId });
  store.recordTitle("Image lifecycle", "initial"); store.recordTitle("Image lifecycle", "refinement");
  const tools = new ToolRegistry();
  tools.register({ name: "raw_image", description: "inline fixture", inputSchema: { type: "object" }, metadata: { readOnly: true, concurrent: true, visible: true },
    async call() { return { ok: true, output: "loaded", newMessages: [imageMessage("raw-tool-image")] }; },
  });
  let turn = 0;
  let runtimeBlock: ImageMessageBlock | undefined;
  const options: QueryEngineOptions = { agentId: "test", tools, cwd: root, model: "gpt-4o", session: { rootDir: root, sessionId, resume: true },
    contextManager: { async build() { return { systemPrompt: "test", promptSections: [], userContext: { currentDate: "2026-10-20" }, systemContext: { cwd: root, platform: process.platform } }; } },
    compactor: new DeterministicCompactor(),
    modelGateway: { async *stream(request): AsyncIterable<ModelStreamEvent> {
      turn++;
      if (turn === 1) yield { type: "tool_use", toolUse: { id: "raw", name: "raw_image", input: {} } };
      else {
        runtimeBlock = request.messages.flatMap(message => message.blocks).find(block => block.type === "image") as ImageMessageBlock | undefined;
        yield { type: "assistant_message", message: createTextMessage("assistant", "done") };
      }
    } },
  };
  const engine = new QueryEngine(options);
  for await (const _event of engine.sendUserText("load")) { /* drain */ }
  assert.ok(runtimeBlock?.imageId && runtimeBlock.storage?.contentHash);
  const recorded = engine.getHistoryMessages().find(message => message.id === "raw-tool-image")!.blocks[0] as ImageMessageBlock;
  assert.deepEqual(runtimeBlock, recorded);
  for (let i = 0; i < 7; i++) await engine.compact();
  const resumed = new QueryEngine(options); await resumed.initialize();
  const catalog = await SessionImageStore.open(path.join(root, sessionId));
  assert.equal(resolveContextImage(context(catalog, resumed.getHistoryMessages()), recorded.imageId!).data, png);
  const entries = (await fs.readFile(path.join(root, sessionId, "transcript.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  const persisted = entries.find(entry => entry.type === "message" && entry.message.id === "raw-tool-image").message.blocks[0];
  assert.deepEqual(persisted, recorded);
});


test("independently opened stores serialize writes without losing resources", async t => {
  const dir = await temporary(t);
  const [a, b] = await Promise.all([SessionImageStore.open(dir), SessionImageStore.open(dir)]);
  const blocks = await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 ? a : b).importFile(png, "image/png", `file-${i}`, "same.png")));
  assert.equal(new Set(blocks.map(block => block.imageAlias)).size, 8);
  for (const store of [a, b, await SessionImageStore.open(dir)]) {
    assert.equal(store.snapshot().images.length, 8);
    for (const block of blocks) assert.equal(resolveContextImage(context(store), block.imageId!).data, png);
  }
});

test("inspect and edit both accept inline legacy blocks and both reject an ambiguous display label", async t => {
  const dir = await temporary(t);
  const messages = [imageMessage("inline")];
  const ctx: ToolUseContext = { ...context(await SessionImageStore.open(dir), messages), imageStore: undefined };
  const inspect = createLoadImageTool();
  assert.equal((await inspect.call!({ imageRefs: ["img_1"] }, ctx, {})).ok, true);
  const edit = createOpenAIImageGenerationTool();
  assert.equal((await edit.validateInput!({ mode: "edit", semanticName: "inline-check", prompt: "test", imageRefs: ["img_1"] }, ctx)).ok, true);
  const ambiguous: ToolUseContext = { ...ctx, imageStore: undefined, messages: [imageMessage("one", { label: "[img#1]", imageId: "image-one" }), imageMessage("two", { label: "[img#1]", imageId: "image-two" })] };
  assert.equal((await inspect.call!({ imageRefs: ["[img#1]"] }, ambiguous, {})).ok, false);
  assert.equal((await edit.validateInput!({ mode: "edit", semanticName: "ambiguous-check", prompt: "test", imageRefs: ["[img#1]"] }, ambiguous)).ok, false);
});


test("inspect IDs round-trip through edit transport after compaction; latest inspection survives restart", async t => {
  const dir = await temporary(t);
  const store = await SessionImageStore.open(dir);
  const first = await store.persistMessage(imageMessage("first"));
  const second = await store.persistMessage(imageMessage("second", { data: other }));
  const ctx = context(store, [first, second]);
  const inspected = await createLoadImageTool().call!({ imageRefs: ["img_1"] }, ctx, {});
  const id = (inspected.output as LoadImageToolOutput).loadedImages[0].id;
  let messages = [first, second, ...inspected.newMessages!];
  for (let i = 0; i < 7; i++) messages = (await new DeterministicCompactor().manualCompact(messages, { keepRecentTokenBudget: 0 })).messages;
  const resumed = await SessionImageStore.open(dir);
  await resumed.persistMessage(second, { touch: false }); // preserved historical pixels must not change latest
  assert.equal(resumed.latestRef(), id);
  const uploads: string[][] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    const form = init.body as FormData;
    const files = [...form.entries()].filter(([, value]) => value instanceof Blob).map(([, value]) => value as Blob);
    uploads.push(await Promise.all(files.map(async file => Buffer.from(await file.arrayBuffer()).toString("base64"))));
    return new Response(JSON.stringify({ data: [{ b64_json: png }] }));
  });
  const edit = createOpenAIImageGenerationTool({ apiKey: "test-key" });
  const restored = context(resumed, messages);
  assert.equal((await edit.call!({ mode: "edit", semanticName: "latest-source-check", prompt: "test", outputDir: dir }, restored, {})).ok, true);
  assert.equal((await edit.call!({ mode: "edit", semanticName: "ordered-source-check", prompt: "test", imageRefs: ["img_2", id], outputDir: dir }, restored, {})).ok, true);
  assert.deepEqual(uploads, [[png], [other, png]]);
});

test("direct inspect host persists references for a later edit with no message window", async t => {
  const dir = await temporary(t);
  const file = path.join(dir, "external.png");
  await fs.writeFile(file, Buffer.from(png, "base64"));
  const ctx: ToolUseContext = { ...context(await SessionImageStore.open(dir)), imageStore: undefined };
  const inspected = await createLoadImageTool().call!({ imageRefs: [file] }, ctx, {});
  const id = (inspected.output as LoadImageToolOutput).loadedImages[0].id;
  assert.ok(ctx.imageStore);
  assert.equal((await createOpenAIImageGenerationTool().validateInput!({ mode: "edit", semanticName: "direct-host-check", prompt: "test", imageRefs: [id] }, ctx)).ok, true);
});

test("identity conflicts and failed commits cannot change the registered resource or latest pointer", async t => {
  const dir = await temporary(t);
  const store = await SessionImageStore.open(dir);
  const first = await store.persistMessage(imageMessage("original"));
  const block = first.blocks[0] as ImageMessageBlock;
  await assert.rejects(store.persistMessage(imageMessage("conflict", { imageId: block.imageId, data: other })), /identity conflict/);
  assert.equal(resolveContextImage(context(store), block.imageId!).data, png);
  const catalog = await fs.readFile(path.join(dir, "image-resources.json"), "utf8");
  const originalRename = fs.rename;
  t.mock.method(fs, "rename", async (...[source, dest]: Parameters<typeof fs.rename>) => {
    if (String(dest).endsWith("image-resources.json")) throw new Error("simulated catalog write failure");
    return originalRename(source, dest);
  });
  await assert.rejects(store.persistMessage(imageMessage("failed")), /simulated catalog write failure/);
  assert.equal(await fs.readFile(path.join(dir, "image-resources.json"), "utf8"), catalog);
  assert.equal(store.snapshot().images.length, 1);
  assert.equal(store.latestRef(), block.imageId);
});

test("mixed persistent and legacy blocks never allocate a colliding display alias", () => {
  const registry = buildImageRegistry([imageMessage("legacy"), imageMessage("stable", { imageId: "image-stable", imageAlias: "img_1" })]);
  assert.deepEqual(registry.images.map(entry => entry.id), ["img_2", "img_1"]);
});


test("compaction refreshes stale checkpoint metadata from the durable session catalog", async t => {
  const dir = await temporary(t);
  const store = await SessionImageStore.open(dir);
  await store.persistMessage(imageMessage("source"));
  const stale = { ...store.snapshot().images[0], storagePath: undefined, imageId: undefined };
  let messages: Message[] = [{ ...createTextMessage("system", "stale"), metadata: { compactBoundary: true, imageRegistry: { images: [stale] } } }];
  for (let i = 0; i < 7; i++) {
    messages = (await new DeterministicCompactor().manualCompact(messages, { imageRegistry: store.snapshot(), keepRecentTokenBudget: 0 })).messages;
    const checkpoint = messages[0].metadata?.imageRegistry as ImageRegistry;
    assert.equal(checkpoint.images[0].imageId, store.snapshot().images[0].imageId);
    assert.equal(checkpoint.images[0].storagePath, store.snapshot().images[0].storagePath);
  }
});

test("migration persists old inline payloads and does not swallow a corrupt middle record", async t => {
  const dir = await temporary(t);
  const file = path.join(dir, "transcript.jsonl");
  const record = JSON.stringify({ type: "message", message: imageMessage("legacy-inline") });
  await fs.writeFile(file, record + "\n" + '{"type":');
  const store = await SessionImageStore.open(dir);
  const id = store.snapshot().images[0].imageId!;
  assert.equal(resolveContextImage(context(await SessionImageStore.open(dir)), id).data, png);
  const broken = path.join(dir, "broken"); await fs.mkdir(broken);
  await fs.writeFile(path.join(broken, "transcript.jsonl"), record + "\nBAD\n" + record);
  await assert.rejects(SessionImageStore.open(broken), /Corrupt session transcript/);
});
