import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TerminalOutputStore, type StoreResult, type TerminalRunMetadata } from "./terminal-output-store.js";

function ok<T>(result: StoreResult<T>): T {
  if (!result.ok) assert.fail(JSON.stringify(result));
  return result.value;
}
function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "terminal-background-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const owner of ["A", "B"]) fs.mkdirSync(path.join(root, owner));
  const make = () => new TerminalOutputStore({ sessionsRoot: root, now: () => 2000 });
  const store = make();
  const start = (id: string, backgrounded?: boolean, owner = "A") => ok(store.start(owner, path.join(root, owner), id,
    { startedAt: 1000, backgrounded }));
  const finish = (id: string) => ok(store.finalize("A", id,
    { finishedAt: 1500, exitCode: 0, signal: null, terminationReason: "completed", durationMs: 500 }));
  return { root, store, make, start, finish };
}

test("background membership is explicit, durable and independent of retaining foreground output", t => {
  const f = fixture(t);
  f.start("foreground", false); f.finish("foreground");
  f.start("legacy"); f.finish("legacy");
  f.start("background", false);
  assert.equal(ok(f.store.markBackgrounded("A", "background")).record.metadata.backgrounded, true);
  assert.equal(ok(f.store.markBackgrounded("A", "background")).persistence, "stored");
  f.finish("background");
  ok(f.store.evict("A", "background"));
  const restored = f.make();
  assert.equal(ok(restored.restoreSession("A", path.join(f.root, "A"))).rejected, 0);
  const records = ok(restored.listHistory("A")).records;
  assert.equal(records.length, 3, "foreground/legacy records remain in the output store");
  assert.deepEqual(records.filter(({ record }) => record.metadata.backgrounded === true).map(({ record }) => record.runId), ["background"]);
  assert.equal(records.find(({ record }) => record.runId === "foreground")!.record.metadata.backgrounded, false);
  assert.equal(records.find(({ record }) => record.runId === "legacy")!.record.metadata.backgrounded, undefined);
  assert.equal(ok(restored.read("A", "foreground", { stream: "stdout" })).text, "");
});

test("silent background transition is checkpointed before exit and survives recovery as lost", t => {
  const f = fixture(t);
  f.start("background", false); f.start("foreground", false); f.start("legacy");
  ok(f.store.markBackgrounded("A", "background"));
  const restored = f.make();
  const records = ok(restored.restoreSession("A", path.join(f.root, "A"))).records;
  assert.ok(records.every(({ record }) => record.lifecycle === "lost"));
  assert.deepEqual(records.filter(({ record }) => record.metadata.backgrounded === true).map(({ record }) => record.runId), ["background"]);
  assert.equal(restored.markBackgrounded("A", "foreground").ok, false, "recovery must not invent a transition");
});

test("background transition is owner-scoped and preserves exit facts when exit precedes marking", t => {
  const f = fixture(t);
  f.start("same", false); f.start("same", false, "B");
  const exit = f.finish("same").record.exit;
  const marked = ok(f.store.markBackgrounded("A", "same"));
  assert.equal(marked.record.metadata.backgrounded, true);
  assert.deepEqual(marked.record.exit, exit);
  assert.equal(marked.record.lifecycle, "terminal");
  assert.equal(ok(f.store.read("B", "same", { stream: "stdout" })).record.metadata.backgrounded, false);
  assert.equal(f.store.markBackgrounded("C", "same").ok, false);
  assert.equal(f.store.markBackgrounded("A", "missing").ok, false);
});

test("background metadata validates booleans and round-trips an explicit true", t => {
  const f = fixture(t);
  const invalid = { startedAt: 1000, backgrounded: "true" } as unknown as TerminalRunMetadata;
  assert.equal(f.store.start("A", path.join(f.root, "A"), "invalid", invalid).ok, false);
  f.start("direct", true); f.finish("direct");
  const restored = f.make();
  assert.equal(ok(restored.restoreSession("A", path.join(f.root, "A"))).records[0]!.record.metadata.backgrounded, true);
});
