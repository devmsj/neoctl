import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readArchivedUserMessage } from "../../src/session/user-message-archive.js";
import { SessionStore } from "../../src/session/session-store.js";
import { createTextMessage } from "../../src/types/messages.js";
import type { ToolUseContext } from "../../src/tools/tool.js";

interface Page {
  content: string; totalLines: number; hasMoreAfter: boolean;
  lineMap: Array<[number, number, number, number, string]>;
}
const entry = (id: string, body: string, agentId = "main") => JSON.stringify({ type: "message", sessionId: "s", agentId,
  message: { ...createTextMessage("user", body), id } }) + "\n";
const context = (dir: string, agentId = "main") => ({ agentId, session: { sessionDir: dir, sessionId: "s" } }) as ToolUseContext;
const read = (ctx: ToolUseContext, id?: string, offset = 1, limit = 120) => readArchivedUserMessage({
  path: id === undefined ? "neo://session/user-messages" : `neo://session/user-message/${encodeURIComponent(id)}`, offset, limit,
}, ctx);

test("archive pages preserve exact newlines, block boundaries and Unicode across wraps", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "neo-archive-format-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const texts = ["a".repeat(255) + "😀" + "z".repeat(256) + "\r\n\nlast\r", "", "\tindent\n  body\r\n"];
  const message = { ...createTextMessage("user", ""), id: "mixed", blocks: texts.map(text => ({ type: "text", text })) };
  const original = JSON.stringify({ type: "message", sessionId: "s", agentId: "main", message }) + "\n"
    + entry("continuous", "a".repeat(256) + "b") + entry("newline", "a".repeat(256) + "\nb");
  await fs.writeFile(path.join(dir, "transcript.jsonl"), original);
  const restored = new Map<number, string>();
  for (let offset = 1;; offset += 2) {
    const result = await read(context(dir), "mixed", offset, 2);
    assert.equal(result.ok, true);
    const page = result.output as Page;
    const fragments = page.content.split("\n").map(line => line.replace(/^\d+ \| /, ""));
    page.lineMap.forEach(([virtual, block, sourceLine, column, ending], i) => {
      assert.equal(virtual, offset + i);
      assert(sourceLine > 0 && column > 0);
      assert(!/[\uD800-\uDBFF]$/.test(fragments[i]!));
      assert(!/^[\uDC00-\uDFFF]/.test(fragments[i]!));
      restored.set(block, (restored.get(block) ?? "") + fragments[i] + ending);
    });
    if (!page.hasMoreAfter) break;
  }
  assert.deepEqual([...restored.values()], texts);
  const defaultPage = await read(context(dir), "continuous");
  assert(JSON.stringify(defaultPage.output).length < 48000, "default paging must fit the normal tool result budget");
  const a = (await read(context(dir), "continuous")).output as Page;
  const b = (await read(context(dir), "newline")).output as Page;
  assert.equal(a.content, b.content);
  assert.notDeepEqual(a.lineMap, b.lineMap);
  const past = (await read(context(dir), "mixed", 999)).output as Page;
  assert.equal(past.content, ""); assert.deepEqual(past.lineMap, []); assert.equal(past.hasMoreAfter, false);
  assert.equal(await fs.readFile(path.join(dir, "transcript.jsonl"), "utf8"), original);
});

test("warm archive pages read only the target entry, including between real SessionStore appends", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "neo-archive-index-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = await SessionStore.open({ rootDir: root, sessionId: "s", agentId: "main" });
  const snapshot = store.snapshot();
  const ctx = context(snapshot.sessionDir);
  const target = { ...createTextMessage("user", "中abc ".repeat(12000)), id: "target" };
  store.recordMessage(target);
  for (let i = 0; i < 12; i++) store.recordMessage(createTextMessage("assistant", "x".repeat(100000)));
  const originalOpen = fs.open.bind(fs);
  let bytes = 0;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    const originalRead = handle.read.bind(handle);
    handle.read = (async (...readArgs: Parameters<FileHandle["read"]>) => {
      const result = await originalRead(...readArgs); bytes += result.bytesRead; return result;
    }) as FileHandle["read"];
    return handle;
  });
  assert.equal((await read(ctx)).ok, true);
  assert(bytes >= (await fs.stat(snapshot.transcriptPath)).size);
  bytes = 0;
  for (const offset of [1, 121, 241]) {
    // Normal archive tool calls also append assistant/tool/timing records.
    store.recordMessage(createTextMessage("assistant", "archive tool call"));
    const page = await read(ctx, "target", offset);
    assert.equal(page.ok, true);
    assert(JSON.stringify(page.output).length < 48000, "default page and line map fit the normal result budget");
  }
  assert(bytes < 400000, `warm reads must not rescan the >1MB transcript: ${bytes}`);
  store.recordMessage({ ...createTextMessage("user", "fresh"), id: "fresh" });
  bytes = 0;
  assert.match(JSON.stringify((await read(ctx)).output), /fresh/);
  assert.equal(bytes, 0, "known appends update the in-memory index without disk scanning");
  // An external mutation followed by a normal append must not bless stale offsets.
  await fs.appendFile(snapshot.transcriptPath, entry("external", "outside writer"));
  store.recordMessage(createTextMessage("assistant", "normal append after external write"));
  assert.equal((await read(ctx, "external")).ok, true);
  store.reset();
  assert.equal((await read(ctx, "target")).ok, false);
  store.recordMessage({ ...createTextMessage("user", "after reset"), id: "after" });
  assert.equal((await read(ctx, "after")).ok, true);
});

test("unobserved append, same-size rewrite, truncation and replacement invalidate cached offsets", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "neo-archive-stale-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "transcript.jsonl"), ctx = context(dir);
  const first = entry("old", "before");
  await fs.writeFile(file, first);
  assert.equal((await read(ctx, "old")).ok, true);
  await fs.appendFile(file, entry("appended", "new"));
  assert.equal((await read(ctx, "appended")).ok, true);
  const content = await fs.readFile(file, "utf8");
  await fs.writeFile(file, content.replace('"old"', '"new"'));
  const now = new Date(Date.now() + 2000); await fs.utimes(file, now, now);
  assert.equal((await read(ctx, "old")).ok, false);
  assert.equal((await read(ctx, "new")).ok, true);
  await fs.writeFile(file, "");
  assert.equal((await read(ctx, "new")).ok, false);
  const replacement = file + ".new";
  await fs.writeFile(replacement, entry("replacement", "value"));
  await fs.rename(replacement, file);
  assert.equal((await read(ctx, "replacement")).ok, true);
  assert.deepEqual(await fs.readdir(dir), ["transcript.jsonl"]);
});

test("cached indexes remain scoped and aborted reads cannot populate a partial index", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "neo-archive-scope-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, "transcript.jsonl"), entry("main-id", "中文😀") + "bad JSON\n" + entry("other-id", "other", "other").trimEnd());
  assert.equal((await read(context(dir), "main-id")).ok, true);
  assert.equal((await read(context(dir, "other"), "main-id")).ok, false);
  assert.equal((await read(context(dir, "other"), "other-id")).ok, true);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(read({ ...context(dir), abortSignal: controller.signal }));
  assert.equal((await read(context(dir), "main-id")).ok, true);
});
