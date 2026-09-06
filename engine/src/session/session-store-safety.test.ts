import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "./session-store.js";
import { createTextMessage } from "../types/messages.js";
import { QueryEngine } from "../core/query-engine.js";
import { ToolRegistry } from "../tools/registry.js";

async function temporary(run: (root: string) => Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "neo-session-safety-"));
  try { await run(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test("unsafe identifiers cannot open or delete root or parent; custom roots work", async () => temporary(async (root) => {
  const rootDir = path.join(root, "custom", "sessions");
  const store = await SessionStore.open({ rootDir, sessionId: "legal-session_中文", agentId: "main" });
  store.recordMessage(createTextMessage("user", "safe"));
  for (const sessionId of [".", "..", " ../escape ", "a/b", "a\\b", "C:\\escape", "x:stream", "name.", "NUL", "con.txt", "x\0y"]) {
    await assert.rejects(SessionStore.open({ rootDir, sessionId, agentId: "main", resume: true }), /invalid session id/);
    await assert.rejects(SessionStore.delete({ rootDir, sessionId }), /invalid session id/);
    assert.equal(fs.existsSync(store.transcriptPath), true);
  }
  assert.equal(await SessionStore.delete({ rootDir, sessionId: store.sessionId }), true);
  assert.equal(fs.existsSync(rootDir), true);
  assert.equal(fs.existsSync(root), true);
}));

test("reject session and root junctions without changing target", async () => temporary(async (root) => {
  const rootDir = path.join(root, "sessions");
  const target = path.join(root, "target");
  fs.mkdirSync(rootDir); fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, "sentinel"), "untouched");
  const child = path.join(rootDir, "child");
  fs.symlinkSync(target, child, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(SessionStore.open({ rootDir, sessionId: "child", agentId: "main", resume: true }), /Unsafe session directory/);
  await assert.rejects(SessionStore.delete({ rootDir, sessionId: "child" }), /Unsafe session directory/);
  await assert.rejects(SessionStore.open({ rootDir: child, sessionId: "nested", agentId: "main" }), /Unsafe session directory/);
  assert.equal(fs.readFileSync(path.join(target, "sentinel"), "utf8"), "untouched");
}));

for (const kind of ["hardlink", "symlink"] as const) {
  test(`reject transcript ${kind} before read, repair, append or delete`, async (t) => temporary(async (root) => {
    const rootDir = path.join(root, "sessions");
    const store = await SessionStore.open({ rootDir, sessionId: "child", agentId: "main" });
    const target = path.join(root, "target.txt");
    fs.writeFileSync(target, "unterminated sensitive data");
    try {
      if (kind === "hardlink") fs.linkSync(target, store.transcriptPath);
      else fs.symlinkSync(target, store.transcriptPath, "file");
    } catch (error) {
      if (kind === "symlink" && (error as NodeJS.ErrnoException).code === "EPERM") { t.skip("file symlink privilege unavailable"); return; }
      throw error;
    }
    await assert.rejects(SessionStore.open({ rootDir, sessionId: "child", agentId: "main", resume: true }), /Unsafe session transcript/);
    assert.throws(() => store.recordMessage(createTextMessage("user", "no write")), /Unsafe session transcript/);
    await assert.rejects(SessionStore.delete({ rootDir, sessionId: "child" }), /Unsafe session transcript/);
    assert.equal(fs.readFileSync(target, "utf8"), "unterminated sensitive data");
  }));
}

test("partial append poisons instance; reopen repairs tail and preserves prior messages", async (t) => temporary(async (rootDir) => {
  const store = await SessionStore.open({ rootDir, sessionId: "child", agentId: "main" });
  const first = createTextMessage("user", "before failure");
  store.recordMessage(first);
  const write = fs.writeFileSync;
  const mock = t.mock.method(fs, "writeFileSync", ((file: any, data: any, ...args: any[]) => {
    if (typeof file === "number") {
      write(file, String(data).slice(0, 20), "utf8");
      throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
    }
    return (write as any)(file, data, ...args);
  }) as typeof fs.writeFileSync);
  assert.throws(() => store.recordMessage(createTextMessage("user", "lost")), /disk full/);
  mock.mock.restore();
  const partial = fs.readFileSync(store.transcriptPath, "utf8");
  assert.throws(() => store.recordMessage(createTextMessage("user", "must not append")), /writes disabled/);
  assert.equal(fs.readFileSync(store.transcriptPath, "utf8"), partial);
  const reopened = await SessionStore.open({ rootDir, sessionId: "child", agentId: "main", resume: true });
  assert.deepEqual(reopened.getInitialMessages(), [first]);
  const next = createTextMessage("user", "after repair");
  reopened.recordMessage(next);
  const again = await SessionStore.open({ rootDir, sessionId: "child", agentId: "main", resume: true });
  assert.deepEqual(again.getInitialMessages(), [first, next]);
}));

test("failed compaction checkpoint does not replace engine history", async () => temporary(async (rootDir) => {
  const engine = new QueryEngine({ tools: new ToolRegistry(), modelGateway: { async *stream() {} }, session: { rootDir, sessionId: "main" } });
  await engine.initialize();
  const internal = engine as any;
  const original = createTextMessage("user", "original");
  internal.history.push(original);
  internal.sessionStore.recordMessage(original);
  internal.sessionStore.recordCompactCheckpoint = () => { throw new Error("checkpoint failed"); };
  assert.throws(() => internal.applyCompactionResult({ changed: true, messages: [createTextMessage("user", "replacement")] }), /checkpoint failed/);
  assert.deepEqual(internal.history, [original]);
  const restored = await SessionStore.open({ rootDir, sessionId: "main", agentId: "main", resume: true });
  assert.deepEqual(restored.getInitialMessages(), [original]);
}));
