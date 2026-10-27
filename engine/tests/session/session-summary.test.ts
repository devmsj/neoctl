import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "../../src/session/session-store.js";
import { createTextMessage } from "../../src/types/messages.js";

async function temporary(run: (root: string) => Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "neo-summary-"));
  try { await run(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
const entry = (type: string, extra = {}, agentId = "main") => ({ type, agentId, sessionId: "one", ...extra });
function write(root: string, entries: unknown[], tail = "") {
  const dir = path.join(root, "one"); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "transcript.jsonl");
  fs.writeFileSync(file, entries.map(e => JSON.stringify(e) + "\n").join("") + tail);
  return file;
}

test("list facts match recovery across agents, reset, compaction and display-only messages", async () => temporary(async rootDir => {
  const msg = createTextMessage("user", "body");
  write(rootDir, [entry("message", { message: msg }), entry("title", { title: "old" }),
    entry("reset"), entry("title", { title: "new\n title" }), entry("message", { message: msg }),
    entry("message", { message: { ...msg, metadata: { displayOnly: true } } }),
    entry("content-replacement", { replacements: [{}, {}] }),
    entry("compact", { replacementMessages: [msg] }),
    entry("message", { message: msg }), entry("content-replacement", { replacements: [{}] }),
    entry("message", { message: msg }, "child"), entry("title", { title: "child title" }, "child")]);
  for (const agentId of ["main", "child"]) {
    const [summary] = await SessionStore.list({ rootDir, agentId });
    const restored = await SessionStore.open({ rootDir, sessionId: "one", agentId, resume: true });
    assert.equal(summary!.messages, restored.snapshot().resumedMessages);
    assert.equal(summary!.title, restored.snapshot().title);
    assert.equal(summary!.contentReplacements, restored.snapshot().contentReplacements);
    assert.equal(summary!.entryCount, agentId === "main" ? 10 : 2);
  }
  const [all] = await SessionStore.list({ rootDir });
  assert.equal(all!.entryCount, 12); assert.equal(all!.messages, 3);
}));

test("unchanged lists do not reread transcripts; changed, recreated and deleted files invalidate", async t => temporary(async rootDir => {
  const file = write(rootDir, [entry("title", { title: "first" })]);
  const original = fsp.readFile;
  let reads = 0;
  t.mock.method(fsp, "readFile", ((...args: any[]) => { if (String(args[0]) === file) reads++; return (original as any)(...args); }) as typeof fsp.readFile);
  const first = await SessionStore.list({ rootDir, agentId: "main" });
  first[0]!.title = "caller mutation";
  assert.equal((await SessionStore.list({ rootDir, agentId: "main" }))[0]!.title, "first");
  assert.equal(reads, 1);
  fs.appendFileSync(file, JSON.stringify(entry("title", { title: "next" })) + "\n");
  assert.equal((await SessionStore.list({ rootDir, agentId: "main" }))[0]!.title, "next");
  assert.equal(reads, 2);
  write(rootDir, [entry("title", { title: "reset" })]);
  assert.equal((await SessionStore.list({ rootDir, agentId: "main" }))[0]!.title, "reset");
  assert.equal(reads, 3);
  await SessionStore.delete({ rootDir, sessionId: "one" });
  assert.deepEqual(await SessionStore.list({ rootDir }), []);
  write(rootDir, [entry("title", { title: "fresh" })]);
  assert.equal((await SessionStore.list({ rootDir, agentId: "main" }))[0]!.title, "fresh");
  assert.equal(reads, 4);
}));

test("simultaneous lists share one scan, cache remains isolated by root and agent", async t => temporary(async root => {
  const a = path.join(root, "a"), b = path.join(root, "b");
  const file = write(a, [entry("title", { title: "A" }), entry("title", { title: "child" }, "child")]);
  write(b, [entry("title", { title: "B" })]);
  const original = fsp.readFile; let reads = 0;
  t.mock.method(fsp, "readFile", (async (...args: any[]) => { if (String(args[0]) === file) { reads++; await new Promise(r => setTimeout(r, 30)); } return (original as any)(...args); }) as typeof fsp.readFile);
  const lists = await Promise.all(Array.from({ length: 4 }, () => SessionStore.list({ rootDir: a, agentId: "main" })));
  assert.ok(lists.every(l => l[0]!.title === "A")); assert.equal(reads, 1);
  assert.equal((await SessionStore.list({ rootDir: b, agentId: "main" }))[0]!.title, "B");
  assert.equal((await SessionStore.list({ rootDir: a, agentId: "child" }))[0]!.title, "child");
}));

test("listing never repairs incomplete tails; completed tails become visible", async () => temporary(async rootDir => {
  const tail = JSON.stringify(entry("title", { title: "finished" }));
  const file = write(rootDir, [entry("title", { title: "before" })], tail.slice(0, -2));
  const before = fs.readFileSync(file);
  assert.equal((await SessionStore.list({ rootDir }))[0]!.title, "before");
  assert.deepEqual(fs.readFileSync(file), before);
  fs.appendFileSync(file, tail.slice(-2));
  assert.equal((await SessionStore.list({ rootDir }))[0]!.title, "finished");
  assert.equal(fs.readFileSync(file, "utf8").endsWith("\n"), false);
  write(rootDir, [entry("title", { title: "good" })], "bad json\n");
  await assert.rejects(SessionStore.list({ rootDir }), /Malformed session transcript/);
}));

test("cache hits still reject unsafe transcript hardlinks", async () => temporary(async rootDir => {
  const file = write(rootDir, [entry("title", { title: "cached" })]);
  await SessionStore.list({ rootDir });
  fs.linkSync(file, path.join(rootDir, "hardlink"));
  await assert.rejects(SessionStore.list({ rootDir }), /Unsafe session transcript/);
}));
