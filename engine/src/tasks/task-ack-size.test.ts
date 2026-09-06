import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createLocalAgentTask } from "../agents/local-agent-task.js";
import { TaskStore } from "./task-store.js";
import { persistTask, MAX_TASK_RECORD_BYTES } from "./task-persistence.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "neo-ack-size-"));
  const store = new TaskStore(); store.bindSession(dir);
  const make = (id: string) => {
    const task = createLocalAgentTask({ taskId: id, agentId: `agent-${id}`, description: id, prompt: id, outputFile: join(dir, `${id}.txt`) });
    store.upsert(task); return task;
  };
  const reload = () => { const next = new TaskStore(); next.loadSession(dir); return next; };
  return { dir, store, make, reload, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("ack persists, collection is read-only, interrupted runs remain recoverable, legacy defaults unacknowledged", () => {
  const f = fixture();
  try {
    const done = f.make("done"), pending = f.make("pending"), running = f.make("running");
    f.store.fail(done.id, "done"); f.store.markRunning(running.id);
    const file = join(f.dir, "subagents", done.agentId, "task.json");
    const before = readFileSync(file, "utf8");
    assert.deepEqual(f.store.collectUnnotifiedCompletions().map(t => t.id), [done.id]);
    assert.equal(readFileSync(file, "utf8"), before);
    f.store.markNotified(done.id);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).notified, true);
    for (const task of [pending, running]) { task.notified = true; persistTask(task); }
    const fresh = f.reload();
    assert.equal(fresh.get(done.id)?.notified, true);
    assert.deepEqual(fresh.collectUnnotifiedCompletions(), []);
    assert.deepEqual(fresh.recoverableInterruptedTasks().map(t => t.id).sort(), [pending.id, running.id].sort());
    for (const task of fresh.recoverableInterruptedTasks()) fresh.markNotified(task.id);
    assert.deepEqual(f.reload().recoverableInterruptedTasks(), []);
    fresh.prepareResume(done.id, new AbortController());
    assert.deepEqual(f.reload().recoverableInterruptedTasks().map(t => t.id), [done.id]);
    const legacy = JSON.parse(readFileSync(file, "utf8")); delete legacy.notified;
    writeFileSync(file, JSON.stringify(legacy));
    assert.equal(f.reload().get(done.id)?.notified, false);
  } finally { f.cleanup(); }
});

test("failed ack write preserves memory and disk retryability", () => {
  const f = fixture();
  try {
    const task = f.make("done"); f.store.fail(task.id, "result");
    const file = join(f.dir, "subagents", task.agentId, "task.json");
    const before = readFileSync(file, "utf8"), updatedAt = task.updatedAt;
    const agentId = task.agentId; task.agentId = "../invalid";
    assert.throws(() => f.store.markNotified(task.id), /identifier/);
    task.agentId = agentId;
    assert.equal(task.notified, false); assert.equal(task.updatedAt, updatedAt);
    assert.equal(readFileSync(file, "utf8"), before);
    assert.deepEqual(f.store.collectUnnotifiedCompletions().map(t => t.id), [task.id]);
    assert.equal(f.reload().get(task.id)?.notified, false);
    f.store.markNotified(task.id);
    assert.deepEqual(f.reload().collectUnnotifiedCompletions(), []);
  } finally { f.cleanup(); }
});

test("over-64MiB UTF-8 write preserves previous snapshot and accepted pending messages", () => {
  const f = fixture();
  try {
    const task = f.make("large");
    assert.equal(f.store.queueMessage(task.agentId, "accepted followup").ok, true);
    const dir = join(f.dir, "subagents", task.agentId), file = join(dir, "task.json");
    const before = readFileSync(file, "utf8"), entries = readdirSync(dir);
    const prompt = task.prompt;
    task.prompt = "界".repeat(Math.ceil(MAX_TASK_RECORD_BYTES / 3));
    assert.ok(task.prompt.length < MAX_TASK_RECORD_BYTES);
    assert.throws(() => persistTask(task), /Oversized task record/);
    assert.equal(readFileSync(file, "utf8"), before);
    assert.deepEqual(readdirSync(dir), entries);
    assert.equal(task.pendingMessages.length, 1);
    task.prompt = prompt;
    const fresh = f.reload();
    assert.equal(fresh.get(task.id)?.pendingMessages.length, 1);
    assert.deepEqual(fresh.get(task.id)?.pendingMessages[0]?.blocks, task.pendingMessages[0]?.blocks);
  } finally { f.cleanup(); }
});
