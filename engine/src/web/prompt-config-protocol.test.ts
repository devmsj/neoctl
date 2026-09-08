import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { PromptConfigStore, MAX_SYSTEM_PROMPT_BYTES, readBundledSystemPrompt } from "../context/prompt-config.js";
import { handlePromptConfigRequest } from "./prompt-config-protocol.js";

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "neo-prompt-http-"));
  const filePath = path.join(root, "system.md");
  const store = new PromptConfigStore({ filePath });
  const server = http.createServer((req, res) => { void handlePromptConfigRequest(req, res, store); });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); await fs.rm(root, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${address.port}/api/prompt-config`;
  const post = (body: unknown) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { root, filePath, store, url, post };
}

test("HTTP GET/POST contract initializes, persists, reloads and returns 409 without lost writes", async (t) => {
  const { url, filePath, post } = await fixture(t);
  const response = await fetch(url);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const first = await response.json() as { content: string; revision: string; path: string; version: string };
  assert.equal(first.content, readBundledSystemPrompt());
  assert.match(first.revision, /^[a-f0-9]{64}$/);
  assert.equal(first.path, filePath);
  const content = "  用户自定义基础提示词\nKeep plugin rules.\n";
  const savedResponse = await post({ content, revision: first.revision });
  assert.equal(savedResponse.status, 200);
  const saved = await savedResponse.json() as typeof first & { ok: boolean };
  assert.equal(saved.ok, true);
  assert.equal(saved.content, content);
  assert.notEqual(saved.revision, first.revision);
  assert.equal(await fs.readFile(filePath, "utf8"), content);
  assert.equal((await new PromptConfigStore({ filePath }).read()).content, content);
  const conflict = await post({ content: "stale", revision: first.revision });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json() as { errorCode: string }).errorCode, "PROMPT_CONFIG_CONFLICT");
  assert.equal((await (await fetch(url)).json() as typeof first).content, content);
});

test("HTTP rejects malformed input, oversized UTF-8, client paths and unsupported methods", async (t) => {
  const { url, filePath, post } = await fixture(t);
  const initial = await (await fetch(url)).json() as { revision: string; content: string };
  const invalid = [null, [], {}, { content: "ok" }, { content: 1, revision: initial.revision }, { content: " \n", revision: initial.revision }, { content: "ok", revision: "" }, { content: "ok", revision: initial.revision, path: filePath + ".evil" }];
  for (const body of invalid) {
    const response = await post(body);
    assert.equal(response.status, 400, JSON.stringify(body));
    const error = await response.json() as { errorCode: string; error: string };
    assert.equal(error.errorCode, "PROMPT_CONFIG_INVALID");
    assert.equal(typeof error.error, "string");
  }
  assert.equal((await fetch(url, { method: "POST", body: "{" })).status, 400);
  assert.equal((await post({ content: "你".repeat(Math.ceil(MAX_SYSTEM_PROMPT_BYTES / 3)), revision: initial.revision })).status, 413);
  assert.equal((await fetch(url, { method: "POST", body: "x".repeat(MAX_SYSTEM_PROMPT_BYTES * 6 + 1025) })).status, 413);
  assert.equal((await fetch(url + "?path=other.md")).status, 400);
  assert.equal((await fetch(url, { method: "DELETE" })).status, 405);
  assert.equal(await fs.readFile(filePath, "utf8"), initial.content);
});

test("HTTP storage errors are non-2xx structured failures, not false success", async (t) => {
  const { url, filePath } = await fixture(t);
  await fs.mkdir(filePath);
  const response = await fetch(url);
  assert.equal(response.status, 500);
  const body = await response.json() as { errorCode: string; error: string };
  assert.equal(body.errorCode, "PROMPT_CONFIG_STORAGE_ERROR");
  assert.ok(body.error);
});

test("engine global route is dispatched before session runtime construction", async () => {
  const source = await fs.readFile(new URL("./index.ts", import.meta.url), "utf8");
  const route = source.slice(source.indexOf("async function route("));
  const global = route.indexOf('if (url.pathname === "/api/prompt-config") return handlePromptConfigRequest(req, res);');
  assert.ok(global >= 0 && global < route.indexOf("await router.get(scope)"));
});
