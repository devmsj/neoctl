import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm, writeFile, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { jsonBody } from "../../src/model/json-body.js";
import { persistMessageImages, resolveModelImageSync } from "../../src/core/image-storage.js";
import { AnthropicAdapter, COUNT_TOKENS_MAX_IMAGE_BYTES } from "../../src/model/anthropic-adapter.js";
import { createTextMessage, type Message, type MessageBlock } from "../../src/types/messages.js";
import { pngPixel } from "../fixtures/png-pixel.js";
import { PayloadRefs, withPayloadRefs } from "../../src/core/image-payload-refs.js";
import { buildAnthropicRequest } from "../../src/model/anthropic-mapper.js";
import { buildResponsesRequest } from "../../src/model/openai-responses-mapper.js";
import { buildChatRequest } from "../../src/model/openai-chat-mapper.js";

const bytes = async (blob: Blob) => Buffer.from(await blob.arrayBuffer());

test("jsonBody is byte-identical to JSON.stringify, with and without spliced payloads", async () => {
  const big = Buffer.alloc(200_000, 7).toString("base64");
  const values: unknown[] = [
    { a: 1, text: "中文 😀 \u0000 \"quoted\" \\ \n", lone: "\ud800x", list: [null, true, 2.5] },
    { model: "m", messages: [{ role: "user", content: [{ type: "text", text: "说明" }, { type: "image", source: { type: "base64", data: big } }, { type: "image", source: { data: big } }] }], thinking: { type: "adaptive" } },
    { notBase64: "x".repeat(70_000) + "中", base64Like: "A".repeat(70_000) },
    [big, "tail"],
  ];
  for (const value of values) assert.deepEqual(await bytes(await jsonBody(value)), Buffer.from(JSON.stringify(value), "utf8"));
});

test("stored images are sent from disk by reference with identical bytes (Anthropic and OpenAI mappers)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "neo-payload-refs-"));
  try {
    const data = pngPixel(40, 300, 200).toString("base64");
    const [block] = await persistMessageImages([{ type: "image", mimeType: "image/png", data }], { sessionDir: dir });
    const message = { ...createTextMessage("user", "看图"), blocks: [{ type: "text", text: "看图 😀" }, block!] } as Message;
    const request = { model: "claude-haiku-5-5", messages: [message], tools: [], stream: true, reasoning: null };
    const builders: [string, () => Record<string, unknown>][] = [
      ["anthropic", () => buildAnthropicRequest(request, { model: "claude-haiku-5-5" })],
      ["responses", () => buildResponsesRequest({ ...request, model: "gpt-5.6-luna" }, { model: "gpt-5.6-luna" })],
      ["chat", () => buildChatRequest({ ...request, model: "gpt-5.6-luna" }, { model: "gpt-5.6-luna" })],
    ];
    for (const [name, build] of builders) {
      const inline = await bytes(await jsonBody(build()));
      const refs = new PayloadRefs();
      const referenced = withPayloadRefs(refs, build);
      assert.equal(refs.files.length, 1, name);
      assert.ok(!JSON.stringify(referenced).includes(data), `${name}: payload must not be materialized`);
      assert.deepEqual(await bytes(await jsonBody(referenced, refs)), inline, name);
      assert.ok(inline.includes(Buffer.from(data)), name);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("stored image payload is verified once, then re-read; tampering is still detected", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "neo-model-image-"));
  try {
    const data = pngPixel(9, 4, 4).toString("base64");
    const [block] = await persistMessageImages([{ type: "image", mimeType: "image/png", data }], { sessionDir: dir }) as Extract<MessageBlock, { type: "image" }>[];
    assert.equal(block!.data, "");
    const first = resolveModelImageSync(block!);
    const second = resolveModelImageSync(block!);
    assert.deepEqual(first, { raw: data, data, mimeType: "image/png" });
    assert.deepEqual(second, first);
    // Same size, different bytes, new mtime: the cache key changes and full validation rejects it.
    const tampered = pngPixel(10, 4, 4).toString("base64");
    assert.equal(tampered.length, data.length);
    await writeFile(block!.storage!.path, tampered, "utf8");
    const future = new Date(Date.now() + 5000); await utimes(block!.storage!.path, future, future);
    assert.equal(resolveModelImageSync(block!), undefined);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("local estimate never reads image payloads; result matches readable images", () => {
  const adapter = new AnthropicAdapter({ model: "claude-haiku-5-5" });
  const valid = { ...createTextMessage("user", "look"), blocks: [{ type: "text", text: "look" }, { type: "image", mimeType: "image/png", data: pngPixel().toString("base64") }] } as Message;
  const missing = { ...valid, blocks: [valid.blocks[0]!, { type: "image", mimeType: "image/png", data: "", storage: { path: path.join(os.tmpdir(), "neo-missing-image.base64.txt"), format: "base64" } }] } as Message;
  const request = (messages: Message[]) => ({ model: "claude-haiku-5-5", messages, tools: [], stream: true, reasoning: null });
  const estimate = adapter.estimateInputTokens(request([valid]));
  assert.ok(estimate! > 1600);
  assert.equal(adapter.estimateInputTokens(request([missing])), estimate);
});

test("remote count_tokens is skipped above the image payload threshold", async () => {
  let calls = 0;
  const server = createServer((req, res) => { calls++; req.resume(); req.on("end", () => res.end('{"input_tokens":5}')); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    const adapter = new AnthropicAdapter({ model: "claude-haiku-5-5", baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, apiKey: "test" });
    const small = pngPixel().toString("base64");
    const image = (data: string) => ({ ...createTextMessage("user", "x"), blocks: [{ type: "image", mimeType: "image/png", data }] }) as Message;
    const request = (data: string) => ({ model: "claude-haiku-5-5", messages: [image(data)], tools: [], stream: true, reasoning: null });
    assert.equal(await adapter.countInputTokens(request(small)), 5);
    assert.equal(await adapter.countInputTokens(request("A".repeat(COUNT_TOKENS_MAX_IMAGE_BYTES + 4))), undefined);
    assert.equal(calls, 1);
  } finally { server.closeAllConnections(); server.close(); }
});
