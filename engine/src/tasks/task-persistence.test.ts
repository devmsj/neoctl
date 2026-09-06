import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createLocalAgentTask } from "../agents/local-agent-task.js";
import { createTextMessage } from "../types/messages.js";
import { TaskStore } from "./task-store.js";
import { persistTask } from "./task-persistence.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "neo-task-persistence-"));
  const a = join(root, "a"); const b = join(root, "b");
  mkdirSync(a); mkdirSync(b);
  const task = (id = "one") => createLocalAgentTask({ taskId: `task_${id}`, agentId: `agent_${id}`, description: "test", prompt: "private body", outputFile: join(root, `${id}.txt`), abortController: new AbortController() });
  return { root, a, b, task, dispose: () => rmSync(root, { recursive: true, force: true }) };
}
test("new TaskStore restores terminal result/history, pending inbox, aliases and whitelist only", () => {
  const f = fixture();
  try {
    const store = new TaskStore(); store.bindSession(f.a);
    const task = f.task();
    task.executionOptions = { cwd: f.root, model: "test-model", query: { maxTurns: 9 } };
    Object.assign(task.executionOptions, { apiKey: "SECRET_RUNTIME", runtime: { token: "SECRET_RUNTIME" } });
    Object.assign(task, { runtime: { credentials: "SECRET_RUNTIME" } });
    store.upsert(task); store.registerName("worker", task.agentId);
    store.complete(task.id, { agent_id: task.agentId, agent_type: "general", content: "saved result", total_duration_ms: 5, total_tool_use_count: 1 });
    store.prepareResume(task.id, new AbortController());
    store.queueMessage("worker", "pending followup");
    const path = join(f.a, "subagents", task.agentId, "task.json");
    const disk = readFileSync(path, "utf8");
    assert.ok(!disk.includes("SECRET_RUNTIME"));
    const raw = JSON.parse(disk);
    for (const key of ["abortController", "runtime", "ownerSessionDir", "outputFile"]) assert.ok(!(key in raw));
    const fresh = new TaskStore(); const summary = fresh.loadSession(f.a);
    assert.deepEqual(summary, { loaded: 1, interrupted: 1, errors: [] });
    const restored = fresh.getActive(task.id)!;
    assert.notEqual(restored, task);
    assert.equal(restored.status, "killed"); assert.match(restored.error!, /Interrupted/);
    assert.equal(restored.abortController, undefined);
    assert.equal(restored.runGeneration, 2);
    assert.equal(restored.runHistory?.[0]?.result?.content, "saved result");
    assert.equal(restored.pendingMessages[0]?.blocks[0]?.type, "text");
    assert.equal(restored.messageReceipts?.[0]?.status, "queued");
    assert.equal(fresh.resolveAgentName("worker"), task.agentId);
    assert.deepEqual(JSON.parse(JSON.stringify(restored.executionOptions)), { cwd: f.root, model: "test-model", query: { maxTurns: 9 } });
    assert.equal(JSON.parse(readFileSync(path, "utf8")).status, "killed");
  } finally { f.dispose(); }
});
test("switching active sessions neither leaks nor kills in-process tasks", () => {
  const f = fixture();
  try {
    const store = new TaskStore(); store.bindSession(f.a);
    const a = f.task("a"); store.upsert(a); store.registerName("worker", a.agentId); store.markRunning(a.id);
    store.bindSession(f.b); assert.deepEqual(store.list(), []); assert.equal(store.getActive(a.id), undefined);
    assert.equal(store.resolveAgentName("worker"), undefined); assert.equal(a.status, "running"); assert.equal(a.abortController?.signal.aborted, false);
    const b = f.task("b"); store.upsert(b); store.registerName("worker", b.agentId);
    store.fail(a.id, "background finished"); // owner A despite active B
    assert.deepEqual(store.collectUnnotifiedCompletions(), []);
    assert.equal(JSON.parse(readFileSync(join(f.a, "subagents", a.agentId, "task.json"), "utf8")).status, "failed");
    assert.equal(store.resolveAgentName("worker"), b.agentId);
    store.bindSession(f.a); assert.equal(store.getActive(a.id), a); assert.equal(store.resolveAgentName("worker"), a.agentId);
    assert.equal(store.list().length, 1); assert.equal(store.get(b.id), b);
    const fresh = new TaskStore(); fresh.loadSession(f.b); assert.deepEqual(fresh.list().map((t) => t.id), [b.id]);
    store.bindSession(); assert.deepEqual(store.list(), []);
    const legacy = f.task("legacy"); store.upsert(legacy); assert.equal(store.getActive(legacy.id), legacy);
  } finally { f.dispose(); }
});
test("atomic replacements preserve last good snapshot on failure; partial/corrupt/invalid siblings are isolated", () => {
  const f = fixture();
  try {
    const store = new TaskStore(); store.bindSession(f.a); const task = f.task(); store.upsert(task);
    const dir = join(f.a, "subagents", task.agentId); const path = join(dir, "task.json");
    const original = readFileSync(path, "utf8");
    task.messages.push(createTextMessage("user", "update")); store.upsert(task);
    assert.notEqual(readFileSync(path, "utf8"), original);
    assert.deepEqual(readdirSync(dir), ["task.json"]);
    const good = readFileSync(path, "utf8");
    const cyclic: any = {}; cyclic.self = cyclic;
    task.messages.push({ ...createTextMessage("user", "bad"), blocks: [{ type: "tool_use", id: "x", name: "x", input: cyclic }] });
    assert.throws(() => persistTask(task)); assert.equal(readFileSync(path, "utf8"), good);
    writeFileSync(join(dir, ".task-crash.tmp"), "{truncated");
    for (const [name, content] of [["agent_bad", "{private body"], ["agent_escape", JSON.stringify({ ...JSON.parse(good), id: "../escape", taskId: "../escape", agentId: "agent_escape" })]]) {
      const bad = join(f.a, "subagents", name!); mkdirSync(bad); writeFileSync(join(bad, "task.json"), content!);
    }
    const fresh = new TaskStore(); const summary = fresh.loadSession(f.a);
    assert.equal(summary.loaded, 1); assert.equal(summary.errors.length, 2); assert.ok(!summary.errors.join().includes("private body"));
    assert.equal(fresh.list().length, 1);
    const invalid = f.task("invalid"); invalid.agentId = "../escape"; invalid.ownerSessionDir = f.a;
    assert.throws(() => persistTask(invalid), /identifier/);
  } finally { f.dispose(); }
});
test("junction/symlink descendants cannot read or write outside parent session", () => {
  const f = fixture();
  try {
    mkdirSync(join(f.a, "subagents"));
    symlinkSync(f.b, join(f.a, "subagents", "agent_one"), process.platform === "win32" ? "junction" : "dir");
    const task = f.task(); task.ownerSessionDir = f.a;
    assert.throws(() => persistTask(task), /Unsafe/);
    const summary = new TaskStore().loadSession(f.a); assert.equal(summary.loaded, 0); assert.equal(summary.errors.length, 1);
    assert.deepEqual(readdirSync(f.b), []);
  } finally { f.dispose(); }
});
test("progress writes coalesce, flush and critical boundaries persist immediately", async () => {
  const f = fixture(); const store = new TaskStore();
  try {
    store.bindSession(f.a); const task = f.task(); store.upsert(task);
    const path = join(f.a, "subagents", task.agentId, "task.json");
    const original = readFileSync(path, "utf8");
    for (let i = 1; i <= 100; i++) { task.progress.totalEvents = i; store.updateProgress(task); }
    assert.equal(readFileSync(path, "utf8"), original);
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(JSON.parse(readFileSync(path, "utf8")).progress.totalEvents, 100);
    task.progress.totalEvents = 101; store.updateProgress(task); store.flush();
    assert.equal(JSON.parse(readFileSync(path, "utf8")).progress.totalEvents, 101);
    task.progress.totalEvents = 102; store.updateProgress(task); store.queueMessage(task.agentId, "critical");
    assert.equal(JSON.parse(readFileSync(path, "utf8")).progress.totalEvents, 102);
    store.bindSession(f.b); store.fail(task.id, "done");
    assert.equal(store.collectUnnotifiedCompletions().length, 0);
    assert.equal(store.collectUnnotifiedCompletions(f.a).length, 1);
    assert.equal(store.getInSession(task.id, f.a), task);
    const legacy = f.task("explicit_legacy"); store.attachTask(legacy, undefined); store.fail(legacy.id, "done");
    assert.equal(legacy.ownerSessionDir, undefined);
    assert.equal(store.collectUnnotifiedCompletions(undefined).length, 1);
  } finally { store.flush(); f.dispose(); }
});
test("failed inbox persistence rolls back queue and delivery acknowledgements", () => {
  const f = fixture();
  try {
    const store = new TaskStore(); store.bindSession(f.a); const task = f.task(); store.upsert(task); store.markRunning(task.id);
    store.queueMessage(task.agentId, "durable");
    const file = join(f.a, "subagents", task.agentId, "task.json");
    rmSync(file); mkdirSync(file); // deterministic write failure on Windows and Unix
    assert.throws(() => store.deliverPendingMessages(task.id, 1), /persist inbox delivery/);
    assert.equal(task.pendingMessages.length, 1); assert.equal(task.messages.length, 0);
    assert.equal(task.messageReceipts![0]!.status, "queued");
    assert.equal(store.queueMessage(task.agentId, "not durable").ok, false);
    assert.equal(task.pendingMessages.length, 1); assert.equal(task.messageReceipts!.length, 1);
    assert.ok(readdirSync(join(f.a, "subagents", task.agentId)).every((name) => !name.endsWith(".tmp")));
  } finally { f.dispose(); }
});
test("delivery crash window reconciles against transcript and does not duplicate appended messages", () => {
  const f = fixture();
  try {
    const store = new TaskStore(); store.bindSession(f.a); const task = f.task(); store.upsert(task); store.markRunning(task.id);
    store.queueMessage(task.agentId, "handoff");
    const delivered = store.deliverPendingMessages(task.id, 1); assert.equal(delivered.length, 1);
    const fresh = new TaskStore(); fresh.loadSession(f.a);
    fresh.reconcileMessages(task.id, []);
    assert.equal(fresh.get(task.id)!.pendingMessages.length, 1);
    assert.equal(fresh.get(task.id)!.messageReceipts![0]!.status, "queued");
    const again = new TaskStore(); again.loadSession(f.a); again.reconcileMessages(task.id, delivered);
    assert.equal(again.get(task.id)!.pendingMessages.length, 0);
    assert.equal(again.get(task.id)!.messageReceipts![0]!.status, "delivered");
    assert.deepEqual(again.get(task.id)!.messages, delivered);
  } finally { f.dispose(); }
});

test("confirmed handoffs never replay after compaction; unconfirmed appended handoffs dedupe", () => {
  const f = fixture();
  try {
    const store = new TaskStore(); store.bindSession(f.a); const task = f.task(); store.upsert(task); store.markRunning(task.id);
    store.queueMessage(task.agentId, "confirmed");
    const delivered = store.deliverPendingMessages(task.id, 1);
    const path = join(f.a, "subagents", task.agentId, "task.json");
    assert.equal(JSON.parse(readFileSync(path, "utf8")).deliveryRecoveryMessages.length, 1);
    store.confirmDelivery(task.id, delivered.map((m) => m.id), 99);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).deliveryRecoveryMessages.length, 1);
    store.confirmDelivery(task.id, delivered.map((m) => m.id), 1);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).deliveryRecoveryMessages, []);
    const fresh = new TaskStore(); fresh.loadSession(f.a); fresh.reconcileMessages(task.id, []);
    assert.equal(fresh.get(task.id)!.pendingMessages.length, 0);
    assert.equal(fresh.get(task.id)!.messageReceipts![0]!.status, "delivered");
    store.queueMessage(task.agentId, "append then crash before ack");
    const second = store.deliverPendingMessages(task.id, 1);
    const again = new TaskStore(); again.loadSession(f.a);
    again.reconcileMessages(task.id, [], second.map((m) => m.id));
    assert.equal(again.get(task.id)!.pendingMessages.length, 0);
    assert.equal(again.get(task.id)!.messageReceipts!.at(-1)!.status, "delivered");
  } finally { f.dispose(); }
});
test("legacy delivered receipts missing compacted IDs are not treated as recovery outbox", () => {
  const f = fixture();
  try {
    const store = new TaskStore(); store.bindSession(f.a); const task = f.task(); store.upsert(task); store.markRunning(task.id);
    store.queueMessage(task.agentId, "legacy delivery"); store.deliverPendingMessages(task.id, 1);
    const path = join(f.a, "subagents", task.agentId, "task.json");
    const raw = JSON.parse(readFileSync(path, "utf8")); delete raw.deliveryRecoveryMessages; writeFileSync(path, JSON.stringify(raw));
    const fresh = new TaskStore(); fresh.loadSession(f.a); fresh.reconcileMessages(task.id, []);
    assert.equal(fresh.get(task.id)!.pendingMessages.length, 0);
  } finally { f.dispose(); }
});
test("confirmation disk failure retains recoverable outbox", () => {
  const f = fixture();
  try {
    const store = new TaskStore(); store.bindSession(f.a); const task = f.task(); store.upsert(task); store.markRunning(task.id);
    store.queueMessage(task.agentId, "durable handoff"); const delivered = store.deliverPendingMessages(task.id, 1);
    const path = join(f.a, "subagents", task.agentId, "task.json");
    const raw = readFileSync(path, "utf8"); rmSync(path); mkdirSync(path);
    assert.throws(() => store.confirmDelivery(task.id, delivered.map((m) => m.id), 1), /confirmation/);
    rmSync(path, { recursive: true }); writeFileSync(path, raw);
    store.upsert(task);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).deliveryRecoveryMessages.length, 1);
    store.reconcileMessages(task.id, delivered);
    assert.equal(task.pendingMessages.length, 0);
  } finally { f.dispose(); }
});
