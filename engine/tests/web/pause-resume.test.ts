import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { QueryEngine } from "../../src/core/query-engine.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { SessionStore } from "../../src/session/session-store.js";
import { WebRepl, type WebRuntime } from "../../src/web/index.js";
import type { ModelGateway, ModelRequest } from "../../src/model/model-gateway.js";
import { createTextMessage } from "../../src/types/messages.js";

const latch = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
const drain = async (stream: AsyncIterable<unknown>) => { for await (const _ of stream) { /* drain */ } };
async function waitFor(predicate: () => boolean) {
  for (let i = 0; i < 200 && !predicate(); i++) await new Promise(r => setTimeout(r, 5));
  assert.ok(predicate(), "condition must settle without waiting for stuck provider/tool");
}
function engineFor(gateway: ModelGateway, extra: Partial<ConstructorParameters<typeof QueryEngine>[0]> = {}) {
  return new QueryEngine({ modelGateway: gateway, tools: new ToolRegistry(),
    contextManager: { async build() { return { systemPrompt: "test", promptSections: [], userContext: { currentDate: "2026-10-21" }, systemContext: { cwd: "test", platform: "win32" } }; } },
    compactor: { async compact(messages) { return { messages: [...messages], changed: false }; } },
    session: { enabled: false }, ...extra });
}
function replFor(engine: QueryEngine) {
  const runtime = { engine, initialMetrics: {},
    usage: { reset() {}, add() {} },
    taskStore: { subscribe() {}, list: () => [], isTerminal: () => false },
    execProcessManager: { subscribe() {}, subscribeOutput() {}, list: () => [] },
  } as unknown as WebRuntime;
  const repl = new WebRepl(runtime);
  (repl as unknown as { publishRuntimeContext(): void }).publishRuntimeContext = () => undefined;
  return repl;
}

test("pause returns synchronously; stuck model is aborted; continue/new input is exactly one new round", async () => {
  const entered = latch(), stuck = latch();
  const requests: ModelRequest[] = [];
  const engine = engineFor({ async *stream(request) {
    requests.push(request);
    if (requests.length === 1) { entered.resolve(); await stuck.promise; }
    yield { type: "assistant_message", message: createTextMessage("assistant", "done") };
  } });
  const repl = replFor(engine);
  await repl.submit("original task"); await entered.promise;
  assert.deepEqual(repl.pauseRun(), { ok: true });
  assert.equal(requests[0].cancellation?.aborted, true);
  assert.equal(repl.snapshot().busy, false);
  assert.equal(repl.snapshot().runControl.canResume, true);
  assert.equal((await repl.submit("不要继续旧任务，先解释原因")).ok, true);
  assert.equal(repl.continueRun().ok, false, "duplicate click must not schedule another query");
  await waitFor(() => requests.length === 2 && !repl.snapshot().busy);
  assert.match(JSON.stringify(requests[1]), /用户主动暂停/);
  assert.match(JSON.stringify(requests[1]), /不要继续旧任务/);
  assert.match(JSON.stringify(requests[1]), /避免重复执行/);
  assert.equal(repl.snapshot().runControl.canResume, false);
  stuck.resolve();
});

test("network failure remains resumable; continued request carries unexpected termination notice", async () => {
  const requests: ModelRequest[] = [];
  const engine = engineFor({ async *stream(request) {
    requests.push(request);
    if (requests.length === 1) throw new Error("ECONNRESET network unavailable");
    yield { type: "assistant_message", message: createTextMessage("assistant", "done") };
  } });
  const repl = replFor(engine);
  await repl.submit("original task");
  await waitFor(() => repl.snapshot().runControl.canResume);
  assert.equal(engine.getExecutionState()?.reason, "model_error");
  assert.equal(repl.continueRun().ok, true);
  await waitFor(() => requests.length === 2 && !repl.snapshot().busy);
  assert.match(JSON.stringify(requests[1]), /意外终止/);
  assert.match(JSON.stringify(requests[1]), /model_error/);
  const recovery = requests[1].messages.find(message => message.blocks.some(block => block.type === 'text' && block.text.includes('executionRecovery')))!;
  assert.equal(recovery.isMeta, true);
  assert.equal(recovery.metadata?.systemContext, true);
  assert.equal(recovery.metadata?.userContext, false);
  assert.match(JSON.stringify(recovery), /System context/);
  assert.equal(engine.getHistoryMessages().filter(message => message.role === 'user' && !message.isMeta).length, 1);
  assert.equal(repl.snapshot().lines.filter(line => line.kind === 'user').length, 1);
  assert.ok(!JSON.stringify(engine.getHistoryMessages()).includes('executionRecovery'));
  assert.equal(repl.continueRun().ok, false, "completed query must not resume");
  const completed = engine.getExecutionState();
  await assert.rejects(drain(engine.continueExecution()), /No interrupted execution/);
  assert.deepEqual(engine.getExecutionState(), completed);
});

test("stuck tool does not delay pause or continuation and is not replayed", async () => {
  const entered = latch(), stuck = latch(); let calls = 0, turns = 0;
  const tools = new ToolRegistry();
  tools.register({ name: "slow", description: "slow", inputSchema: { type: "object" },
    metadata: { concurrent: false, readOnly: false, visible: true },
    async execute() { calls++; entered.resolve(); await stuck.promise; return { ok: true, output: "done" }; } });
  const engine = engineFor({ async *stream() {
    if (turns++ === 0) yield { type: "tool_use", toolUse: { id: "slow-1", name: "slow", input: {} } };
    else yield { type: "assistant_message", message: createTextMessage("assistant", "checked") };
  } }, { tools });
  const repl = replFor(engine);
  await repl.submit("do work");
  await waitFor(() => calls > 0 || repl.snapshot().lines.some(line => line.kind === "error"));
  assert.equal(calls, 1, JSON.stringify(repl.snapshot().lines));
  await entered.promise;
  assert.equal(repl.pauseRun().ok, true);
  assert.equal(repl.continueRun().ok, true);
  await waitFor(() => turns === 2 && !repl.snapshot().busy);
  assert.equal(calls, 1);
  stuck.resolve();
});

test("persist paused/error/running states across session reopening; completed is not recoverable", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "neo-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const status of ["paused", "interrupted", "running", "completed"] as const) {
    const store = await SessionStore.open({ rootDir: root, agentId: "main", sessionId: status, resume: false });
    store.recordMessage(createTextMessage("user", "saved task"));
    store.recordExecutionState({ status, reason: status === "paused" ? "user_pause" : "model_error", elapsedMs: 4200 });
    const engine = engineFor({ async *stream() {} }, { session: { rootDir: root, sessionId: status, resume: true } });
    await engine.initialize();
    assert.equal(engine.getExecutionState()?.status, status === "running" ? "interrupted" : status);
    assert.equal(replFor(engine).snapshot().runControl.canResume, status !== "completed");
    assert.equal(engine.getExecutionState()?.elapsedMs, 4200);
    if (status === "running") assert.equal(engine.getExecutionState()?.reason, "runtime_terminated");
  }
});

test("execution clock freezes at pause, accumulates on continue, resets for a new task", async () => {
  let now = 0, turn = 0;
  const entered = latch(), stuck = latch();
  const engine = engineFor({ async *stream() {
    if (turn++ === 0) { entered.resolve(); await stuck.promise; }
    now += 500;
    yield { type: "assistant_message", message: createTextMessage("assistant", "done") };
  } }, { timingClock: { monotonicNow: () => now, wallNow: () => 1800000000000 + now } });
  const repl = replFor(engine);
  await repl.submit("task"); await entered.promise;
  now = 3200;
  assert.equal(repl.snapshot().runControl.timer?.elapsedMs, 3200);
  repl.pauseRun();
  assert.equal(repl.snapshot().runControl.timer?.running, false);
  now = 83200;
  assert.equal(repl.snapshot().runControl.timer?.elapsedMs, 3200);
  repl.continueRun();
  assert.equal(repl.snapshot().runControl.timer?.elapsedMs, 3200);
  await waitFor(() => turn === 2 && !repl.snapshot().busy);
  assert.equal(repl.snapshot().runControl.timer?.elapsedMs, 3700);
  now += 10000;
  assert.equal(repl.snapshot().runControl.timer?.elapsedMs, 3700);
  await repl.submit("new task");
  await waitFor(() => turn === 3 && !repl.snapshot().busy);
  assert.equal(repl.snapshot().runControl.timer?.elapsedMs, 500);
  stuck.resolve();
});

test("exceptions before model call are recoverable, not completed", async () => {
  const engine = engineFor({ async *stream() {} }, { contextManager: { async build() { throw new Error("context failure"); } } });
  await assert.rejects(drain(engine.sendUserText("task")), /context failure/);
  assert.equal(engine.getExecutionState()?.status, "interrupted");
});
