import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ExecProcessManager, type ExecProcessStartOptions, type ExecProcessOutputDelta } from "../tools/builtins/exec-process-manager.js";
import { WebRepl, type WebRuntime } from "./index.js";
import { TerminalOutputStore } from "../tools/terminal-output-store.js";

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "timed out waiting for real terminal output");
    await delay(25);
  }
}

async function main(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "web-terminal-tasks-"));
  const ownerA = "web-smoke", ownerB = "other-owner";
  const directories = { [ownerA]: path.join(root, ownerA), [ownerB]: path.join(root, ownerB) };
  Object.values(directories).forEach((dir) => fs.mkdirSync(dir));
  const store = new TerminalOutputStore({ sessionsRoot: root });
  const manager = new ExecProcessManager({ outputStore: store, completedRetentionMs: 2_000 });
  let currentOwner: keyof typeof directories = ownerA;
  const runtime = {
    execProcessManager: manager,
    taskStore: { activeCount: () => 0, subscribe: () => () => undefined, list: () => [], isTerminal: () => false },
    engine: {
      getDisplayEntries: () => [], getHistoryMessages: () => [],
      snapshot: () => ({ messages: 0, session: { sessionId: currentOwner, sessionDir: directories[currentOwner]! } }),
      redactDisplayValue: <T>(value: T) => value,
      isFastMode: () => false, getAppPrompt: () => ({ hasActivePrompt: false }),
      onSessionTitleChange: () => () => undefined,
    },
    initialMetrics: {},
  } as unknown as WebRuntime;
  const repl = new WebRepl(runtime);
  const frames: string[] = [];
  const internal = repl as unknown as {
    subscribers: Set<unknown>;
    queueTerminalOutput(delta: ExecProcessOutputDelta): void;
    flushTerminalOutput(): void;
  };
  const subscriber = { blocked: false, needsSync: false, needsRuntimeContext: false,
    response: { destroyed: false, write: (frame: string) => { frames.push(frame); return true; } } };
  internal.subscribers.add(subscriber);
  const snapshot = () => repl.snapshot() as {
    backgroundTaskCount: number;
    backgroundTasks: Array<Record<string, unknown>>;
    terminalTaskHistory: Array<Record<string, unknown>>;
  };
  const updates = () => frames.filter((frame) => frame.includes("\nevent: terminal.output\n"))
    .flatMap((frame) => JSON.parse(frame.split("\ndata: ")[1]!.trim()).updates as Array<Record<string, unknown>>);
  const checks: Record<string, boolean> = {};
  let notifications = 0;
  const unsubscribe = manager.subscribeOutput(() => { notifications++; });
  try {
    const a = await manager.execute(terminalOptions(ownerA, directories[ownerA]!), 0);
    const b = await manager.execute(terminalOptions(ownerB, directories[ownerB]!), 0);
    const foregroundId = manager.start({ ...terminalOptions(ownerA, directories[ownerA]!), timeoutMs: 10_000, description: "尚在前台等待" });
    await manager.interact(a.session_id, { ownerId: ownerA, chars: "owner-A-output\n", yieldTimeMs: 150 });
    await manager.interact(b.session_id, { ownerId: ownerB, chars: "owner-B-private\n", yieldTimeMs: 150 });
    await until(() => updates().some((u) => u.sessionId === a.session_id));

    const active = snapshot();
    assert.equal(active.backgroundTaskCount, 1);
    assert.equal(active.backgroundTasks.length, 1);
    assert.equal(active.backgroundTasks[0]?.sessionId, a.session_id);
    assert.equal(active.backgroundTasks[0]?.ownerSessionId, ownerA);
    assert.equal(active.backgroundTasks[0]?.command, "node background terminal smoke");
    assert.equal(active.backgroundTasks[0]?.kind, "terminal");
    assert.ok(active.backgroundTasks.every((t) => t.sessionId !== foregroundId && t.sessionId !== b.session_id));
    assert.deepEqual(active.terminalTaskHistory, []);
    checks.ownerBoundBackgroundOnly = true;
    assert.ok(!("output" in active.backgroundTasks[0]!));
    assert.ok(!JSON.stringify(active).includes("owner-A-output") && !JSON.stringify(active).includes("owner-B-private"));
    checks.snapshotsNeverContainTerminalBody = true;

    const page = repl.terminalOutput(ownerA, a.session_id, "stdout", 0, 65536);
    assert.ok(page && page.text?.includes("owner-A-output\n"));
    assert.equal(page.record.lifecycle, "running");
    assert.equal(repl.terminalOutput(ownerA, b.session_id, "stdout", 0, 65536), undefined);
    assert.equal(repl.terminalOutput(ownerB, b.session_id, "stdout", 0, 65536), undefined);
    checks.ownerReaderAvailableAndForeignOwnerDenied = true;
    assert.ok(notifications > 0);
    assert.ok(updates().length > 0);
    for (const update of updates()) {
      assert.deepEqual(Object.keys(update).sort(), ["invalidated", "ownerSessionId", "sessionId"]);
      assert.equal(update.invalidated, true);
      assert.equal(update.ownerSessionId, ownerA);
      assert.equal(update.sessionId, a.session_id);
    }
    assert.ok(!frames.some((frame) => frame.includes("owner-B-private") || frame.includes("owner-A-output")));
    checks.realOutputSseInvalidatesWithoutBodyOrForeignOwner = true;
    await delay(250);
    assert.ok(manager.list(ownerA).some((t) => t.session_id === a.session_id && t.status === "running"));
    checks.backgroundIgnoresForegroundTimeout = true;

    // Deterministic delayed flush boundary: a queued old-owner update must not cross a session switch.
    frames.length = 0;
    internal.queueTerminalOutput({ sessionId: a.session_id, ownerSessionId: ownerA, stream: "stdout", text: "must-not-leak" });
    currentOwner = ownerB;
    internal.flushTerminalOutput();
    assert.deepEqual(updates(), []);
    internal.queueTerminalOutput({ sessionId: a.session_id, ownerSessionId: ownerA, stream: "stdout", text: "late-old-owner" });
    internal.flushTerminalOutput();
    assert.deepEqual(updates(), []);
    const switched = snapshot();
    assert.deepEqual(switched.backgroundTasks.map((t) => t.sessionId), [b.session_id]);
    assert.deepEqual(switched.terminalTaskHistory, []);
    assert.equal(repl.terminalOutput(ownerA, a.session_id, "stdout", 0, 65536), undefined);
    checks.sessionSwitchDropsQueuedAndLateForeignInvalidation = true;

    const killedB = await manager.interact(b.session_id, { ownerId: ownerB, signal: "kill", yieldTimeMs: 3_000 });
    const historyB = snapshot();
    assert.equal(historyB.backgroundTasks.length, 0);
    assert.deepEqual(historyB.terminalTaskHistory.map((t) => t.sessionId), [b.session_id]);
    assert.equal(historyB.terminalTaskHistory[0]?.status, killedB.status);
    assert.equal(historyB.terminalTaskHistory[0]?.exitCode, killedB.exit_code);
    currentOwner = ownerA;
    assert.deepEqual(snapshot().terminalTaskHistory, []);
    const killedA = await manager.interact(a.session_id, { ownerId: ownerA, signal: "kill", yieldTimeMs: 3_000 });
    const killedForeground = await manager.interact(foregroundId, { ownerId: ownerA, signal: "kill", yieldTimeMs: 3_000 });
    assert.equal(killedForeground.status, "killed");
    const ended = snapshot();
    assert.equal(ended.backgroundTasks.length, 0);
    assert.deepEqual(ended.terminalTaskHistory.map((t) => t.sessionId), [a.session_id]);
    assert.equal(repl.terminalOutput(ownerA, foregroundId, "stdout", 0, 65536)?.record.metadata.backgrounded, false);
    checks.foregroundKilledNeverEntersHistory = true;
    assert.ok(ended.terminalTaskHistory.every((t) => t.ownerSessionId === ownerA && t.sessionId !== b.session_id));
    const terminal = ended.terminalTaskHistory.find((t) => t.sessionId === a.session_id)!;
    assert.equal(terminal.status, killedA.status);
    assert.equal(terminal.exitCode, killedA.exit_code);
    assert.equal(terminal.signal, killedA.signal);
    assert.equal(terminal.terminationReason, killedA.termination_reason);
    assert.equal(terminal.durationMs, killedA.duration_ms);
    assert.ok(!("output" in terminal));
    assert.ok(repl.terminalOutput(ownerA, a.session_id, "stdout", 0, 65536)?.text?.includes("owner-A-output"));
    checks.terminalMovesToOwnerHistoryWithExactFactsAndReadableOutput = true;
    assert.equal(page.record.metadata.backgrounded, true, "yield=0 persists an explicit background transition");
    checks.immediateYieldPersistsBackground = true;

    const foregroundRuns = [foregroundId];
    const cases = [
      { name: "completed", script: "process.stdout.write('foreground-completed\\n');", status: "exited", reason: "completed", exitCode: 0 },
      { name: "nonzero", script: "process.stdout.write('foreground-failed\\n');process.exitCode=7;", status: "exited", reason: "failed", exitCode: 7 },
      { name: "spawn-error", script: "", status: "failed", reason: "spawn_error", exitCode: null },
      { name: "timeout", script: "setInterval(()=>{},1000);", status: "timed_out", reason: "timeout" },
    ];
    for (const test of cases) {
      const options = scriptOptions(ownerA, directories[ownerA]!, test.script);
      if (test.name === "spawn-error") options.shell.file = path.join(root, "missing-executable");
      if (test.name === "timeout") options.timeoutMs = 100;
      const result = await manager.execute(options, 5_000);
      foregroundRuns.push(result.session_id);
      assert.equal(result.status, test.status, test.name);
      assert.equal(result.termination_reason, test.reason, test.name);
      if ("exitCode" in test) assert.equal(result.exit_code, test.exitCode, test.name);
      const output = repl.terminalOutput(ownerA, result.session_id, "stdout", 0, 65536);
      assert.ok(output, "foreground output remains independently readable");
      assert.equal(output.record.metadata.backgrounded, false, test.name);
      assert.equal(output.record.exit?.status, result.status, test.name);
      assert.equal(snapshot().backgroundTaskCount, 0, test.name);
      assert.deepEqual(snapshot().terminalTaskHistory.map((t) => t.sessionId), [a.session_id], test.name);
    }
    checks.foregroundCompletedFailedSpawnErrorAndTimeoutNeverEnterHistory = true;

    // Observe the same execute call while waiting in the foreground, then after its nonzero yield.
    const delayedExecution = manager.execute(scriptOptions(ownerA, directories[ownerA]!,
      "process.stdin.once('data',()=>{process.stdout.write('yielded-completed\\n');process.exit(0);});"), 200);
    const waiting = manager.list(ownerA).find((t) => t.status === "running")!;
    assert.ok(waiting);
    assert.equal(snapshot().backgroundTaskCount, 0, "not background while execute is waiting");
    assert.equal(repl.terminalOutput(ownerA, waiting.session_id, "stdout", 0, 65536)?.record.metadata.backgrounded, false);
    const yielded = await delayedExecution;
    assert.equal(yielded.status, "running");
    assert.equal(yielded.session_id, waiting.session_id);
    assert.deepEqual(snapshot().backgroundTasks.map((t) => t.sessionId), [yielded.session_id]);
    assert.equal(repl.terminalOutput(ownerA, yielded.session_id, "stdout", 0, 65536)?.record.metadata.backgrounded, true);
    const completedYielded = await manager.interact(yielded.session_id, { ownerId: ownerA, chars: "finish\n", yieldTimeMs: 3_000 });
    assert.equal(completedYielded.exit_code, 0);
    const expectedHistory = [a.session_id, yielded.session_id].sort();
    assert.deepEqual(snapshot().terminalTaskHistory.map((t) => String(t.sessionId)).sort(), expectedHistory);
    checks.waitThenYieldEntersBackgroundAndCompletedHistory = true;

    // Persist old-format records without an explicit marker, including a running residual.
    for (const id of ["legacy-terminal", "legacy-running"]) {
      assert.ok(store.start(ownerA, directories[ownerA]!, id, {
        startedAt: Date.now(), command: "legacy background terminal", status: "running", sessionId: id,
      }).ok);
      if (id === "legacy-terminal") assert.ok(store.finalize(ownerA, id, {
        finishedAt: Date.now(), status: "exited", exitCode: 0, signal: null, terminationReason: "completed", durationMs: 0,
      }).ok);
    }
    assert.deepEqual(snapshot().terminalTaskHistory.map((t) => String(t.sessionId)).sort(), expectedHistory);
    const stored = manager.listHistory(ownerA);
    assert.ok(stored.ok);
    for (const id of [...foregroundRuns, "legacy-terminal", ...expectedHistory]) {
      assert.ok(stored.value.records.some((view) => view.record.runId === id), `output history retains ${id}`);
    }
    checks.outputStoreStillRetainsForegroundAndLegacyRecords = true;

    await until(() => manager.list().length === 0);
    assert.deepEqual(snapshot().terminalTaskHistory.map((t) => String(t.sessionId)).sort(), expectedHistory);
    checks.backgroundHistorySurvivesManagerMemoryCleanup = true;

    // Fresh manager AND store must use persisted facts, not the old manager's in-memory flag.
    const restoredManager = new ExecProcessManager({ sessionsRoot: root });
    const restoredRepl = new WebRepl({ ...runtime, execProcessManager: restoredManager });
    const restored = restoredRepl.snapshot() as ReturnType<typeof snapshot>;
    assert.equal(restored.backgroundTaskCount, 0);
    assert.deepEqual(restored.terminalTaskHistory.map((t) => String(t.sessionId)).sort(), expectedHistory);
    for (const id of expectedHistory) {
      assert.equal(restoredRepl.terminalOutput(ownerA, id, "stdout", 0, 65536)?.record.metadata.backgrounded, true);
    }
    for (const id of foregroundRuns) {
      assert.equal(restoredRepl.terminalOutput(ownerA, id, "stdout", 0, 65536)?.record.metadata.backgrounded, false);
    }
    assert.ok(restoredRepl.terminalOutput(ownerA, yielded.session_id, "stdout", 0, 65536)?.text?.includes("yielded-completed"));
    const legacy = restoredRepl.terminalOutput(ownerA, "legacy-running", "stdout", 0, 65536);
    assert.equal(legacy?.record.lifecycle, "lost");
    assert.equal(legacy?.record.metadata.backgrounded, undefined);
    assert.equal(restoredRepl.terminalOutput(ownerA, b.session_id, "stdout", 0, 65536), undefined);
    currentOwner = ownerB;
    const restoredB = restoredRepl.snapshot() as ReturnType<typeof snapshot>;
    assert.deepEqual(restoredB.terminalTaskHistory.map((t) => t.sessionId), [b.session_id]);
    assert.equal(restoredRepl.terminalOutput(ownerA, a.session_id, "stdout", 0, 65536), undefined);
    checks.restartPreservesBackgroundOnlyHistoryAndOwnerIsolation = true;
    checks.unknownLegacyCompletedAndLostNeverInferredAsBackground = true;
    console.log(JSON.stringify({ ok: true, checks }, null, 2));
  } finally {
    unsubscribe();
    internal.subscribers.delete(subscriber);
    manager.terminateAll();
    await until(() => manager.list().every((task) => task.status !== "running"));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function terminalOptions(ownerId: string, sessionDir: string): ExecProcessStartOptions {
  return {
    ownerId, sessionDir, command: "node background terminal smoke", description: "后台终端冒烟测试", cwd: process.cwd(),
    shell: { requested: "node", file: process.execPath,
      args: ["-e", "process.stdin.setEncoding('utf8');process.stdin.on('data', text => process.stdout.write(text));setTimeout(()=>{},10000);", "--"] },
    env: {}, timeoutMs: 150, maxOutputChars: 4_000, tty: false,
  };
}

function scriptOptions(ownerId: string, sessionDir: string, script: string): ExecProcessStartOptions {
  return { ...terminalOptions(ownerId, sessionDir), timeoutMs: 10_000,
    shell: { requested: "node", file: process.execPath, args: ["-e", script, "--"] } };
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
