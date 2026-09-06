import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TaskStore } from "../tasks/task-store.js";
import { createLocalAgentTask } from "../agents/local-agent-task.js";
import { ToolRegistry } from "../tools/registry.js";
import type { QueryEngine } from "../core/query-engine.js";
import { WebRepl, activateSession, sessionAgentTasks, createResumeParentContext, createTaskNotificationSource } from "./index.js";

// No model, environment loading, real session discovery, or user-data access.
const root = await mkdtemp(path.join(os.tmpdir(), "neo-entrypoint-tasks-"));
try {
  const a = path.join(root, "session-a");
  const b = path.join(root, "session-b");
  await Promise.all([mkdir(a), mkdir(b)]);
  const fakeEngine = (sessionId: string, sessionDir?: string) => ({
    snapshot: () => ({ agentId: "parent", messages: 0, model: "fake-model", session: sessionDir === undefined ? undefined : { sessionId, sessionDir } }),
  }) as unknown as QueryEngine;
  const runtime = { engine: fakeEngine("a", a), taskStore: new TaskStore() };
  activateSession(runtime);
  const task = createLocalAgentTask({ taskId: "task-a", agentId: "child-a", prompt: "fake", description: "fake", outputFile: path.join(a, "task-output.txt") });
  runtime.taskStore.upsert(task);
  runtime.taskStore.markRunning(task.taskId);
  runtime.engine = fakeEngine("b", b);
  activateSession(runtime);
  assert.equal(runtime.taskStore.get(task.taskId)?.status, "running", "switch must not stop another session's background work");
  assert.equal(sessionAgentTasks(runtime).length, 0);
  runtime.taskStore.fail(task.taskId, "fake terminal result");
  const source = createTaskNotificationSource(runtime.taskStore);
  const collect = source.collectUnnotifiedCompletions as (sessionDir?: string) => { taskId: string }[];
  assert.equal(collect(b).length, 0, "new foreground cannot steal old session completions");
  assert.equal(collect(a)[0]?.taskId, task.taskId, "background parent can collect its own completion");
  assert.equal(runtime.taskStore.get(task.taskId)?.notified, false);

  runtime.taskStore = new TaskStore();
  runtime.engine = fakeEngine("a", a);
  activateSession(runtime);
  assert.equal(sessionAgentTasks(runtime)[0]?.taskId, task.taskId, "restart restores session tasks");
  const parent = createResumeParentContext(runtime.engine, new ToolRegistry(), root);
  assert.deepEqual(parent.session, { sessionId: "a", sessionDir: a, rootDir: root });
  assert.equal(parent.agentId, "parent");
  assert.equal(parent.options?.mainLoopModel, "fake-model");
  runtime.engine = fakeEngine("b", b);
  activateSession(runtime);
  assert.equal(sessionAgentTasks(runtime).length, 0);
  assert.equal(createResumeParentContext(runtime.engine, new ToolRegistry(), root).session?.sessionDir, b);
  runtime.engine = fakeEngine("disabled", "");
  activateSession(runtime);
  assert.equal(runtime.taskStore.activeSessionDir, undefined, "empty session directory does not persist");
  assert.equal(createResumeParentContext(runtime.engine, new ToolRegistry()).session, undefined);

  const legacy = { engine: fakeEngine("legacy", ""), taskStore: { list: () => [task] } as unknown as TaskStore };
  activateSession(legacy);
  assert.equal(sessionAgentTasks(legacy).length, 1, "legacy TaskStore mocks remain compatible");
  // Exercise the public WebRepl session entrypoints without starting its UI/server.
  const makeSwitchEngine = (id: string): QueryEngine => Object.assign(fakeEngine(id, path.join(root, id)), {
    initialize: async () => undefined,
    forkForSession: (next?: string) => makeSwitchEngine(next ?? "fresh"),
  });
  runtime.engine = makeSwitchEngine("a");
  const harness = Object.create(WebRepl.prototype) as WebRepl;
  Object.assign(harness, {
    runtime, backgroundSessionRuns: new Map(),
    detachRunningForeground: async () => false,
    loadSessionPlugins: async () => undefined,
    loadSessionTools: async () => undefined,
    refreshSessionView: async () => undefined,
  });
  assert.equal((await harness.resumeSession("b")).ok, true);
  assert.equal(runtime.taskStore.activeSessionDir, path.join(root, "b"));
  assert.equal((await harness.newSession()).ok, true);
  assert.equal(runtime.taskStore.activeSessionDir, path.join(root, "fresh"));
  console.log("task session entrypoints smoke: passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
