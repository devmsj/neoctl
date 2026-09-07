import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ExecProcessManager, type ExecProcessStartOptions, type ExecProcessOutputDelta } from "../tools/builtins/exec-process-manager.js";
import { WebRepl, type WebRuntime } from "./index.js";

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
  const manager = new ExecProcessManager({ sessionsRoot: root, completedRetentionMs: 2_000 });
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
    await manager.interact(foregroundId, { ownerId: ownerA, signal: "kill", yieldTimeMs: 3_000 });
    const ended = snapshot();
    assert.equal(ended.backgroundTasks.length, 0);
    assert.equal(ended.terminalTaskHistory.length, 2);
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

void main().catch((error) => { console.error(error); process.exitCode = 1; });
