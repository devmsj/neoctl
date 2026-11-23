import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebRepl } from "../../src/web/index.js";
import { AgentActivityStore } from "../../src/agents/agent-activity.js";
import { createLocalAgentTask } from "../../src/agents/local-agent-task.js";
import { TaskStore } from "../../src/tasks/task-store.js";
import { SessionStore } from "../../src/session/session-store.js";
import { createTextMessage } from "../../src/types/messages.js";
import type { AgentEvent } from "../../src/types/events.js";

function sse() {
  const frames: Array<{ event: string; data: any }> = [];
  const response = Object.assign(new EventEmitter(), {
    writeHead() {}, end() { response.emit("close"); }, destroyed: false,
    write(chunk: string) { const event = /event: (\S+)/.exec(chunk)?.[1]; const data = chunk.split("data: ")[1]; if (event && data) frames.push({ event, data: JSON.parse(data) }); return true; },
  });
  return { response, frames, last: (event: string) => frames.filter(frame => frame.event === event).at(-1)?.data };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 60));

test("a subagent is observed read-only with the main agent's line model, status row and history", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "neo-observe-"));
  try {
    const sessionDir = path.join(root, "main-session");
    await mkdir(sessionDir, { recursive: true });
    const taskStore = new TaskStore();
    taskStore.bindSession(sessionDir);
    const task = createLocalAgentTask({ taskId: "task_obs", agentId: "worker_obs", agentType: "general-purpose", description: "inspect files", prompt: "INSPECT", abortController: new AbortController() });
    task.executionOptions = { cwd: root, model: "sub-model", reasoning: { effort: "high" }, fastMode: true };
    taskStore.attachTask(task, sessionDir);
    taskStore.markRunning(task.taskId, task.runGeneration);
    const child = await SessionStore.open({ rootDir: path.join(sessionDir, "subagents"), sessionId: task.agentId, agentId: task.agentId });
    child.recordMessage(createTextMessage("user", "INSPECT"));
    child.recordMessage(createTextMessage("assistant", "CHILD_HISTORY_REPLY"));
    const activity = new AgentActivityStore();
    activity.start({ agentId: task.agentId, taskId: task.taskId, agentType: task.agentType!, description: task.description, prompt: "INSPECT", mode: "background" });
    const mainSession = { sessionId: "main", sessionDir };
    const repl = new WebRepl({
      engine: { getTimingRecords: () => [], getDisplayEntries: () => [], snapshot: () => ({ session: mainSession, messages: 0 }), isFastMode: () => false,
        getAppPrompt: () => ({ hasActivePrompt: false }), onSessionTitleChange: () => () => undefined, redactDisplayValue: <T,>(value: T) => value },
      usage: { snapshot: () => ({}), add: () => undefined, reset: () => undefined },
      taskStore, agentRuntime: { agentActivityStore: activity },
      execProcessManager: { subscribe: () => () => undefined, subscribeOutput: () => () => undefined, list: () => [] },
      initialMetrics: { model: "main-model", estimatedInputTokens: 1, estimatedChars: 1, messageCount: 0, toolCount: 0 },
    } as never);
    (repl as unknown as { lines: unknown[] }).lines = [{ id: 1, kind: "user", text: "MAIN_LINE" }];

    // The child is mid-message when the observer attaches: the in-flight remainder is replayed, not skipped.
    const emit = (event: AgentEvent) => activity.recordEvent(task.agentId, event);
    emit({ type: "context.metrics", metrics: { model: "sub-model", estimatedInputTokens: 4321, estimatedChars: 1, messageCount: 2, toolCount: 3, contextWindowTokens: 10000 } as never });
    emit({ type: "state", phase: "calling_model" });
    emit({ type: "assistant.delta", text: "HALF_" });
    emit({ type: "assistant.delta", text: "WAY" });

    const client = sse();
    repl.subscribe(client.response as never, undefined, task.taskId);
    let sync = client.last("sync");
    assert.deepEqual(sync.lines.map((line: any) => line.text), ["INSPECT", "CHILD_HISTORY_REPLY", "HALF_WAY"], "child history + in-flight text render through the main line model");
    assert.equal(sync.status.metrics.estimatedInputTokens, 4321, "status row uses the child's real context metrics");
    assert.equal(sync.status.phase, "calling_model");
    assert.equal(sync.observing.taskId, task.taskId);
    assert.equal(sync.session.sessionId, "main", "owner session binding is kept");
    assert.equal(sync.modelSettings.model, "sub-model", "status row shows the inherited subagent model");
    assert.equal(sync.status.metrics.model, "sub-model");
    assert.equal(sync.busy, true);
    assert.deepEqual([sync.runControl.canPause, sync.runControl.canResume, sync.queuedInput], [false, false, undefined], "read-only: no run control or queue");
    assert.ok(sync.history?.epoch, "observer history is paged from the child transcript");

    // The durable message finalizes the replayed line instead of duplicating it.
    emit({ type: "assistant.delta", text: "_DONE" });
    emit({ type: "message", message: createTextMessage("assistant", "HALF_WAY_DONE") });
    await settle();
    sync = client.last("sync");
    assert.deepEqual(sync.lines.map((line: any) => line.text), ["INSPECT", "CHILD_HISTORY_REPLY", "HALF_WAY_DONE"]);
    emit({ type: "usage", usage: { inputTokens: 1234, outputTokens: 56 } });
    emit({ type: "assistant.delta", text: "LIVE" });
    await settle();
    const delta = client.last("delta");
    assert.ok(delta.operations.some((operation: any) => operation.type === "line.append" || operation.type === "line.text.append"), "live child output arrives as deltas");
    assert.equal(delta.sessionId, "main");
    assert.equal(client.last("sync").status.usage.outputTokens, 56, "usage drives the same status row");

    // Owner syncs keep the observed view; owner line deltas never reach the observer.
    (repl as unknown as { broadcastSync(): void }).broadcastSync();
    sync = client.last("sync");
    assert.ok(!sync.lines.some((line: any) => line.text === "MAIN_LINE"));
    assert.equal(sync.observing.taskId, task.taskId);
    const page = repl.history(sync.history.before, sync.history.epoch, task.taskId);
    assert.equal(page.sessionId, "main");

    // Completion is reflected; closing the stream releases the observer.
    emit({ type: "terminal", reason: "completed" });
    taskStore.complete(task.taskId, { agent_id: task.agentId, agent_type: task.agentType!, content: "done", total_duration_ms: 1, total_tool_use_count: 0 }, task.runGeneration);
    (repl as unknown as { broadcastSync(): void }).broadcastSync();
    assert.equal(client.last("sync").busy, false);
    client.response.emit("close");
    assert.throws(() => repl.history(0, "x", task.taskId), /History changed/);
    assert.equal((repl.stateFor(task.taskId) as { observing?: unknown }).observing, undefined, "released observers fall back to the owner view");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("observing a subagent exposes its own background terminals; terminal output resolves owners strictly", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "neo-observe-terminals-"));
  try {
    const sessionDir = path.join(root, "main-session");
    await mkdir(sessionDir, { recursive: true });
    const taskStore = new TaskStore();
    taskStore.bindSession(sessionDir);
    const task = createLocalAgentTask({ taskId: "task_term", agentId: "worker_term", agentType: "general-purpose", description: "build", prompt: "BUILD", abortController: new AbortController() });
    taskStore.attachTask(task, sessionDir);
    taskStore.markRunning(task.taskId, task.runGeneration);
    const activity = new AgentActivityStore();
    activity.start({ agentId: task.agentId, taskId: task.taskId, agentType: task.agentType!, description: task.description, prompt: "BUILD", mode: "background" });
    const terminal = (id: string, description: string) => ({ session_id: id, status: "running", backgrounded: true, description, command: description, started_at: "2026-01-01T00:00:00.000Z", output_ref: { availability: "available", streams: {} } });
    const running: Record<string, unknown[]> = { main: [terminal("run_main", "MAIN_TERMINAL")], [task.agentId]: [terminal("run_child", "CHILD_TERMINAL")] };
    const history: Record<string, unknown[]> = {
      main: [],
      [task.agentId]: [{ record: { runId: "run_child_done", lifecycle: "exited", metadata: { backgrounded: true, description: "CHILD_FINISHED", command: "npm test", startedAt: "2026-01-01T00:00:00.000Z" }, exit: { status: "exited", exitCode: 0, finishedAt: "2026-01-01T00:01:00.000Z" }, availability: "available" } }],
    };
    const bindings: Array<[string, string]> = [];
    const reads: string[] = [];
    const execProcessManager = {
      subscribe: () => () => undefined, subscribeOutput: () => () => undefined, isBackgroundRunning: () => false,
      list: (owner: string) => running[owner] ?? [],
      registerOwnerSession: (owner: string, dir: string) => { bindings.push([owner, dir]); return { ok: true, value: { records: [], rejected: 0 } }; },
      listHistory: (owner: string) => ({ ok: true, value: { records: history[owner] ?? [], nextOffset: null } }),
      readOutput: (owner: string, runId: string) => { reads.push(`${owner}/${runId}`); return { ok: true, value: { stream: "stdout", offset: 0, nextOffset: 5, text: "hello", endOfStoredOutput: true } }; },
    };
    const mainSession = { sessionId: "main", sessionDir };
    const repl = new WebRepl({
      engine: { getTimingRecords: () => [], getDisplayEntries: () => [], snapshot: () => ({ session: mainSession, messages: 0 }), isFastMode: () => false,
        getAppPrompt: () => ({ hasActivePrompt: false }), onSessionTitleChange: () => () => undefined, redactDisplayValue: <T,>(value: T) => value },
      usage: { snapshot: () => ({}), add: () => undefined, reset: () => undefined },
      taskStore, agentRuntime: { agentActivityStore: activity }, execProcessManager,
      initialMetrics: { model: "main-model", estimatedInputTokens: 1, estimatedChars: 1, messageCount: 0, toolCount: 0 },
    } as never);

    // Owner view: unchanged lists, no observed-agent fields.
    const owner = repl.stateFor() as Record<string, any>;
    assert.deepEqual(owner.backgroundTasks.filter((item: any) => item.kind === "terminal").map((item: any) => item.description), ["MAIN_TERMINAL"]);
    assert.ok(owner.backgroundTasks.some((item: any) => item.kind === "agent" && item.taskId === task.taskId), "owner lists keep agents for agent switching");
    assert.equal(owner.observedBackgroundTasks, undefined);

    // Observed view: the subagent's own terminals, bound to its child session directory.
    const client = sse();
    repl.subscribe(client.response as never, undefined, task.taskId);
    const sync = client.last("sync");
    assert.equal(sync.observing.agentId, task.agentId);
    assert.deepEqual(sync.observedBackgroundTasks.map((item: any) => [item.description, item.ownerSessionId]), [["CHILD_TERMINAL", task.agentId]]);
    assert.deepEqual(sync.observedTerminalTaskHistory.map((item: any) => [item.description, item.ownerSessionId, item.sessionId]), [["CHILD_FINISHED", task.agentId, "run_child_done"]]);
    assert.ok(sync.backgroundTasks.some((item: any) => item.kind === "agent"), "owner lists stay intact while observing");
    const childDir = path.join(sessionDir, "subagents", task.agentId);
    assert.ok(bindings.some(([id, dir]) => id === task.agentId && dir === childDir), "history is read from the agent's child session");

    // Terminal output: owner session or an agent of this session; anything else is rejected before binding.
    assert.equal(repl.terminalOutput(task.agentId, "run_child", "stdout", 0, 1024)?.text, "hello");
    assert.equal(repl.terminalOutput("main", "run_main", "stdout", 0, 1024)?.text, "hello");
    const bound = bindings.length;
    assert.equal(repl.terminalOutput("../evil", "run_child", "stdout", 0, 1024), undefined);
    assert.equal(repl.terminalOutput("not_an_agent", "run_child", "stdout", 0, 1024), undefined);
    assert.equal(bindings.length, bound, "unknown owners never reach the process manager");
    assert.deepEqual(reads, [`${task.agentId}/run_child`, "main/run_main"]);
    client.response.emit("close");
  } finally { await rm(root, { recursive: true, force: true }); }
});
