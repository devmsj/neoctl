import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { InMemoryAppState } from "../../src/app/app-state.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { runToolUseToMessages } from "../../src/tools/run-tool-use.js";
import { createOpenAIImageGenerationTool, normalizeImageBaseUrl, type ImageGenerationToolInput, type ImageGenerationToolOutput } from "../../src/tools/builtins/image-generation-tool.js";
import { IMAGE_MODELS, IMAGE_QUALITIES, normalizeImageInput, validImageSize } from "../../src/tools/builtins/image-capabilities.js";
import { decodeImageBase64, inspectImageBytes, outputWarnings } from "../../src/tools/builtins/image-output-verification.js";
import type { ToolUseContext } from "../../src/tools/tool.js";

const base = { semanticName: "red-mug-icon", prompt: "A red mug icon" };
// Small real PNG used by existing image history tests.
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z0ioAAAAASUVORK5CYII=";
const source = { base64: png, mimeType: "image/png" };
const context: ToolUseContext = { agentId: "image-test", tools: new ToolRegistry(), appState: new InMemoryAppState("image-test", process.cwd()), emit() {} };

for (const model of IMAGE_MODELS) for (const quality of IMAGE_QUALITIES) {
  test(`model/quality contract: ${model} ${quality}`, () => {
    if (model === "gpt-image-2" && ["xhigh", "max"].includes(quality)) assert.throws(() => normalizeImageInput({ ...base, model, quality }), /only available for 2.5/);
    else assert.equal(normalizeImageInput({ ...base, model, quality }).quality, quality);
  });
}
test("defaults, overrides and explicit auto", () => {
  assert.equal(normalizeImageInput(base).model, "gpt-image-2.5-sunburst");
  assert.equal(normalizeImageInput(base).quality, "auto");
  assert.equal(normalizeImageInput({ ...base, model: "gpt-image-2" }).quality, "auto");
  assert.equal(normalizeImageInput(base, "gpt-image-2.5-flare").model, "gpt-image-2.5-flare");
  assert.equal(normalizeImageInput({ ...base, model: "gpt-image-2" }, "gpt-image-2.5-flare").model, "gpt-image-2");
  assert.throws(() => normalizeImageInput(base, "wrong-model"), /OPENAI_IMAGE_MODEL/);
});
for (const size of ["auto", "1024x1024", "1536x1024", "1024x1536", "2048x2048", "3840x2160", "2160x3840", "1024x640", "1440x480", "1040x1024"]) {
  test(`accept size ${size}`, () => assert.equal(validImageSize(size), true));
}
for (const size of ["512x512", "1025x1024", "4096x2048", "3840x3840", "3072x768", "0x1024", "1024X1024", "1024x1024 ", 1024, null]) {
  test(`reject size ${String(size)}`, () => assert.equal(validImageSize(size), false));
}
const invalid: Record<string, unknown>[] = [
  { model: 2 }, { model: "gpt-image-2.5" }, { quality: "ultra" }, { quality: null }, { n: 0 }, { n: 5 }, { n: 1.5 }, { n: "2" },
  { prompt: " " }, { prompt: 4 }, { prompt: "x".repeat(32001) }, { outputFormat: "jpg" }, { background: "blue" }, { moderation: "none" },
  { outputFormat: "jpeg", background: "transparent" }, { mode: "patch" }, { image: "url" }, { images: [] }, { images: [null] },
  { images: Array(17).fill(source) }, { imageRefs: [] }, { imageRefs: [3] }, { imageRefs: [" "] }, { imageRefs: Array(17).fill("a") },
  { outputPath: "a.png", n: 2 }, { outputPath: "" }, { outputDir: "\0bad" }, { useLatestImage: "yes" }, { output_compression: 80 }, { unexpected: true },
];
for (const [i, patch] of invalid.entries()) test(`invalid input ${i}`, () => {
  assert.throws(() => normalizeImageInput({ ...base, ...patch }), /image_create validation failed for model/);
});
for (const value of [null, [], 1, "x", undefined]) test(`invalid root ${String(value)}`, () => assert.throws(() => normalizeImageInput(value), /validation failed/));

test("source validation and references never silently fall back", async () => {
  const tool = createOpenAIImageGenerationTool();
  for (const patch of [
    { semanticName: "image" }, { semanticName: "CON" }, { image: {} }, { image: { ...source, data: png } }, { image: { base64: "%%%", mimeType: "image/png" } },
    { image: { ...source, mimeType: "image/jpeg" } }, { image: { dataUrl: "https://example.test/a.png" } },
    { mode: "edit", useLatestImage: false }, { mode: "edit", imageRefs: ["missing"] },
  ]) {
    const result = await tool.validateInput!({ ...base, ...patch } as ImageGenerationToolInput, context);
    assert.equal(result.ok, false, JSON.stringify(patch));
    if (!result.ok) assert.match(result.message, /model gpt-image-2.5-sunburst/);
  }
  const valid = await tool.validateInput!({ ...base, mode: "edit", image: source }, context);
  assert.equal(valid.ok, true);
});

test("base URLs include exactly one v1 and preserve proxy prefixes", () => {
  for (const [input, expected] of [["https://example.test", "https://example.test/v1"], ["https://example.test/v1/", "https://example.test/v1"], ["http://example.test/proxy/v1", "http://example.test/proxy/v1"]]) assert.equal(normalizeImageBaseUrl(input!), expected);
  for (const input of ["file:///tmp", "https://user:pass@example.test", "https://example.test?key=a", "bad"]) assert.throws(() => normalizeImageBaseUrl(input));
});

test("binary verification rejects non-images and bad base64", () => {
  assert.throws(() => decodeImageBase64("%%%%"), /base64/);
  assert.throws(() => inspectImageBytes(Buffer.from("<html>")), /recognizable/);
  const meta = inspectImageBytes(decodeImageBase64(png));
  assert.equal(meta.mimeType, "image/png"); assert.equal(meta.width, 1); assert.equal(meta.height, 1);
  assert.throws(() => inspectImageBytes(decodeImageBase64(png).subarray(0, 40)), /Truncated|missing/);
});

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "neo-image-test-"));
  return { dir, ctx: { ...context, session: { sessionId: "image-test", sessionDir: dir } } };
}
test("generate verifies bytes, preserves explicit max, warns without failure and persists correct extension", async (t) => {
  const { dir, ctx } = await fixture(); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let body: Record<string, unknown> = {};
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(url, "https://example.test/v1/images/generations");
    body = JSON.parse(init.body as string);
    return new Response(JSON.stringify({ quality: "medium", size: "1x1", output_format: "png", background: "opaque", data: [{ b64_json: png }] }));
  });
  const tool = createOpenAIImageGenerationTool({ apiKey: "test-key", baseUrl: "https://example.test/v1/" });
  const result = await tool.call!({ ...base, quality: "max", size: "1536x1024", outputFormat: "jpeg", outputPath: path.join(dir, "hint.jpeg") }, ctx, {});
  assert.equal(result.ok, true, JSON.stringify(result.output));
  const output = result.output as ImageGenerationToolOutput;
  assert.equal(body.quality, "max"); assert.equal(body.model, "gpt-image-2.5-sunburst");
  assert.equal(output.requested.output_format, "jpeg"); assert.equal(output.actual.quality, "medium");
  assert.equal(output.images[0]!.mimeType, "image/png"); assert.match(output.images[0]!.path!, /\.png$/);
  assert.deepEqual(await fs.readFile(output.images[0]!.path!), Buffer.from(png, "base64"));
  for (const code of ["SIZE_MISMATCH", "FORMAT_MISMATCH", "UPSTREAM_QUALITY_MISMATCH", "MODEL_UNVERIFIED", "OUTPUT_EXTENSION_CORRECTED"]) assert.ok(output.warnings.some(w => w.code === code), code);
  assert.ok(output.warnings.find(w => w.code === "UPSTREAM_QUALITY_MISMATCH")!.message.includes("not proof"));
  const messages = tool.renderToolResultMessage!(result, { id: "gen", name: tool.name, input: base });
  assert.ok(messages!.blocks.some(b => b.type === "image"));
  assert.ok(JSON.stringify(tool.mapResult!(result, { id: "gen", name: tool.name, input: base })).includes("SIZE_MISMATCH"));
});

test("default auto is sent; count and damaged extra images are warnings; repeated labels do not overwrite", async (t) => {
  const { dir, ctx } = await fixture(); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async (_: string, init: RequestInit) => {
    assert.equal(JSON.parse(init.body as string).quality, "auto");
    return new Response(JSON.stringify({ quality: "low", data: [{ b64_json: png }, { b64_json: "%%%" }] }));
  });
  const tool = createOpenAIImageGenerationTool({ apiKey: "test-key" });
  const first = await tool.call!({ ...base, n: 3 }, ctx, {}), second = await tool.call!({ ...base, n: 3 }, ctx, {});
  assert.equal(first.ok, true); assert.equal(second.ok, true);
  const a = first.output as ImageGenerationToolOutput, b = second.output as ImageGenerationToolOutput;
  assert.notEqual(a.images[0]!.path, b.images[0]!.path);
  assert.ok(a.warnings.some(w => w.code === "COUNT_MISMATCH"));
  assert.ok(a.warnings.some(w => w.code === "INVALID_OUTPUT_IMAGE"));
  assert.ok(!a.warnings.some(w => w.code === "UPSTREAM_QUALITY_MISMATCH"));
});

test("edit uses multipart, source refs and identical parameter contract", async (t) => {
  const { dir, ctx } = await fixture(); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.match(url, /\/v1\/images\/edits$/); assert.ok(init.body instanceof FormData);
    assert.equal(init.body.get("quality"), "xhigh"); assert.equal(init.body.get("model"), "gpt-image-2.5-flare");
    assert.equal(init.body.getAll("image[]").length, 1);
    return new Response(JSON.stringify({ data: [{ b64_json: png }] }));
  });
  const tool = createOpenAIImageGenerationTool({ apiKey: "test-key" });
  const result = await tool.call!({ ...base, model: "gpt-image-2.5-flare", quality: "xhigh", mode: "edit", image: source }, ctx, {});
  assert.equal(result.ok, true, JSON.stringify(result.output));
  assert.equal((result.output as ImageGenerationToolOutput).sourceImages, 1);
});

test("all-invalid output, upstream errors, cancellation and invalid config fail clearly", async (t) => {
  const { dir, ctx } = await fixture(); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let response: unknown = { data: [{ b64_json: "%%%" }] };
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify(response)));
  const tool = createOpenAIImageGenerationTool({ apiKey: "test-key" });
  assert.equal((await tool.call!(base, ctx, {})).ok, false);
  response = { error: { message: "bad quality test-key", param: "quality" } };
  const err = await tool.call!(base, ctx, {}); assert.equal(err.ok, false); assert.ok(!JSON.stringify(err.output).includes("test-key"));
  assert.equal((await tool.call!(base, { ...ctx, abortSignal: AbortSignal.abort() }, {})).ok, false);
  assert.equal((await createOpenAIImageGenerationTool({ apiKey: "test-key", baseUrl: "bad" }).call!(base, ctx, {})).ok, false);
});

test("runner schema failures include model and field; no network call", async () => {
  const tools = new ToolRegistry(); tools.register(createOpenAIImageGenerationTool());
  const messages = await runToolUseToMessages({ id: "invalid", name: "image_create", input: { ...base, n: "2" } }, { ...context, tools });
  const text = JSON.stringify(messages); assert.match(text, /gpt-image-2.5-sunburst/); assert.match(text, /input.n/);
});

const byteFixtures: { name: string; format: string; transparent: boolean; alphaChannel: boolean; base64: string }[] = JSON.parse(await fs.readFile(new URL("./fixtures/image-bytes.json", import.meta.url), "utf8"));
for (const sample of byteFixtures) test(`real byte inspection: ${sample.name}`, () => {
  const bytes = decodeImageBase64(sample.base64), actual = inspectImageBytes(bytes);
  assert.equal(actual.mimeType, `image/${sample.format}`);
  assert.equal(actual.width, 2); assert.equal(actual.height, 3);
  assert.equal(actual.hasAlphaChannel, sample.alphaChannel);
  assert.equal(actual.hasTransparentPixels, sample.format === "webp" && sample.transparent ? undefined : sample.transparent);
  assert.throws(() => inspectImageBytes(bytes.subarray(0, Math.min(30, bytes.length - 1))));
});

test("alpha channel and pixel opacity survive model-visible runner results", async (t) => {
  const { dir, ctx } = await fixture(); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let encoded = png;
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ data: [{ b64_json: encoded }] })));
  const tools = new ToolRegistry(); tools.register(createOpenAIImageGenerationTool({ apiKey: "test-key" }));
  for (const sample of byteFixtures) {
    encoded = sample.base64;
    const messages = await runToolUseToMessages({ id: sample.name, name: "image_create", input: base }, { ...ctx, tools });
    const block = messages.flatMap(m => m.blocks).find(b => b.type === "tool_result");
    assert.ok(block?.type === "tool_result" && block.ok);
    // JSON roundtrip checks the representation actually delivered to the model.
    const output = JSON.parse(JSON.stringify(block.output));
    for (const image of [output.images[0], output.actual.images[0]]) {
      assert.equal(image.hasAlphaChannel, sample.alphaChannel, sample.name);
      assert.equal(image.hasTransparentPixels, sample.format === "webp" && sample.transparent ? undefined : sample.transparent, sample.name);
    }
  }
});

test("transparency is byte-verified; unknown alpha is warned, not asserted", () => {
  for (const sample of byteFixtures) {
    const actual = inspectImageBytes(decodeImageBase64(sample.base64));
    const warnings = outputWarnings(normalizeImageInput({ ...base, background: "transparent", outputFormat: sample.format === "jpeg" ? "png" : sample.format }), {}, [actual]);
    assert.equal(warnings.some(w => w.code === "TRANSPARENCY_MISMATCH"), !sample.transparent);
    assert.equal(warnings.some(w => w.code === "TRANSPARENCY_UNVERIFIED"), sample.format === "webp" && sample.transparent);
    const opaqueWarnings = outputWarnings(normalizeImageInput({ ...base, background: "opaque" }), {}, [actual]);
    assert.equal(opaqueWarnings.some(w => w.code === "TRANSPARENCY_MISMATCH"), actual.hasTransparentPixels === true);
  }
});

test("soft input issues pass validation and warnings survive the full runner", async (t) => {
  const { dir, ctx } = await fixture(); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ data: [{ b64_json: png }] })));
  const tools = new ToolRegistry(); tools.register(createOpenAIImageGenerationTool({ apiKey: "test-key" }));
  const messages = await runToolUseToMessages({ id: "soft", name: "image_create", input: { ...base, image: source, outputDir: path.join(dir, "unused"), outputPath: path.join(dir, "hint.png"), maxResultChars: 48000 } }, { ...ctx, tools });
  const block = messages.flatMap(m => m.blocks).find(b => b.type === "tool_result");
  assert.ok(block?.type === "tool_result" && block.ok);
  const text = JSON.stringify(messages);
  assert.match(text, /UNUSED_EDIT_SOURCES/); assert.match(text, /OUTPUT_PATH_PRECEDENCE/);
  await assert.rejects(fs.stat(path.join(dir, "unused")));
});

test("stable refs, ambiguous refs, latest fallback and combined source limit", async () => {
  const tool = createOpenAIImageGenerationTool();
  const ctx: ToolUseContext = { ...context, messages: [{ id: "prior", role: "user", createdAt: new Date().toISOString(), blocks: [
    { type: "image", imageId: "img_1", label: "same-label", mimeType: "image/png", data: png },
    { type: "image", imageId: "img_2", label: "same-label", mimeType: "image/png", data: png },
  ] }] };
  for (const patch of [{ imageRefs: ["img_2"] }, { imageRefs: ["[img#1]"] }, {}]) {
    assert.equal((await tool.validateInput!({ ...base, mode: "edit", ...patch }, ctx)).ok, true);
  }
  const ambiguous = await tool.validateInput!({ ...base, mode: "edit", imageRefs: ["same-label"] }, ctx);
  assert.ok(!ambiguous.ok && /ambiguous/.test(ambiguous.message));
  const tooMany = await tool.validateInput!({ ...base, mode: "edit", images: Array(16).fill(source), image: source }, ctx);
  assert.equal(tooMany.ok, false);
});

test("concurrent same-name image calls never overwrite a file", async (t) => {
  const { dir, ctx } = await fixture(); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ data: [{ b64_json: png }] })));
  const tool = createOpenAIImageGenerationTool({ apiKey: "test-key" });
  const results = await Promise.all(Array.from({ length: 4 }, () => tool.call!(base, ctx, {})));
  assert.ok(results.every(r => r.ok));
  const paths = results.map(r => (r.output as ImageGenerationToolOutput).images[0]!.path!);
  assert.equal(new Set(paths).size, 4);
  for (const file of paths) assert.deepEqual(await fs.readFile(file), Buffer.from(png, "base64"));
});

test("request timeout and mid-flight cancellation fail clearly", async (t) => {
  t.mock.method(globalThis, "fetch", async (_: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
  }));
  const tool = createOpenAIImageGenerationTool({ apiKey: "test-key", timeoutMs: 10 });
  const timeout = await tool.call!(base, context, {});
  assert.equal(timeout.ok, false); assert.match(JSON.stringify(timeout.output), /timed out/);
  const controller = new AbortController();
  const waiting = createOpenAIImageGenerationTool({ apiKey: "test-key" }).call!(base, { ...context, abortSignal: controller.signal }, {});
  controller.abort(new Error("user cancellation"));
  const cancelled = await waiting; assert.equal(cancelled.ok, false); assert.match(JSON.stringify(cancelled.output), /user cancellation/);
});

test("malformed PNG headers and null upstream metadata are handled honestly", () => {
  for (const [offset, value] of [[12, 0], [24, 7], [25, 5], [26, 1], [27, 1], [28, 2]]) {
    const bytes = Buffer.from(png, "base64"); bytes[offset!] = value!;
    assert.throws(() => inspectImageBytes(bytes), /Invalid PNG/);
  }
  const warnings = outputWarnings(normalizeImageInput({ ...base, quality: "max" }), { model: null, quality: null }, [inspectImageBytes(Buffer.from(png, "base64"))]);
  assert.ok(warnings.some(w => w.code === "MODEL_UNVERIFIED"));
  assert.ok(warnings.some(w => w.code === "QUALITY_UNVERIFIED"));
  assert.ok(!warnings.some(w => w.code === "UPSTREAM_QUALITY_MISMATCH"));
});

for (const model of IMAGE_MODELS) for (const quality of IMAGE_QUALITIES) for (const mode of ["generate", "edit"] as const) {
  if (model === "gpt-image-2" && ["xhigh", "max"].includes(quality)) continue;
  test(`transport roundtrip ${model}/${quality}/${mode}`, async (t) => {
    const { dir, ctx } = await fixture(); t.after(() => fs.rm(dir, { recursive: true, force: true }));
    t.mock.method(globalThis, "fetch", async (_: string, init: RequestInit) => {
      const body = init.body instanceof FormData ? Object.fromEntries(init.body.entries()) : JSON.parse(init.body as string);
      assert.equal(body.model, model); assert.equal(body.quality, quality);
      assert.equal(String(body.n), "4"); assert.equal(body.size, "3840x2160");
      assert.equal(body.output_format, "webp"); assert.equal(body.background, "transparent"); assert.equal(body.moderation, "low");
      return new Response(JSON.stringify({ model, quality, data: [{ b64_json: png }] }));
    });
    const result = await createOpenAIImageGenerationTool({ apiKey: "test-key" }).call!({ ...base, model, quality, mode, n: 4, size: "3840x2160", outputFormat: "webp", background: "transparent", moderation: "low", ...(mode === "edit" ? { image: source } : {}) }, ctx, {});
    assert.equal(result.ok, true);
    assert.ok(!(result.output as ImageGenerationToolOutput).warnings.some(w => /UPSTREAM_(MODEL|QUALITY)_MISMATCH/.test(w.code)));
  });
}

test("configured model is identified in early schema errors", async () => {
  const tools = new ToolRegistry(); tools.register(createOpenAIImageGenerationTool({ model: "gpt-image-2.5-flare" }));
  const result = await runToolUseToMessages({ id: "config", name: "image_create", input: { ...base, n: "2" } }, { ...context, tools });
  assert.match(JSON.stringify(result), /gpt-image-2.5-flare/);
});
