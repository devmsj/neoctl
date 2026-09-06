import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAgentTool, resumeAgentTask, type AgentToolRuntime } from "./agent-tool.js";
import { AgentActivityStore } from "./agent-activity.js";
import { GENERAL_PURPOSE_AGENT, StaticAgentCatalog } from "./agent-definition.js";
import { TaskStore } from "../tasks/task-store.js";
import { createSubagentStopTool } from "../tasks/subagent-tools.js";
import { SessionStore } from "../session/session-store.js";
import { InMemoryAppState } from "../app/app-state.js";
import { ToolRegistry } from "../tools/registry.js";
import type { ToolUseContext } from "../tools/tool.js";
import type { ModelGateway, ModelRequest, ModelStreamEvent } from "../model/model-gateway.js";
import type { LocalAgentTask } from "./local-agent-task.js";
import { createTextMessage } from "../types/messages.js";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));
async function until(check: () => boolean) {
  for (let i = 0; i < 1000; i++) { if (check()) return; await tick(); }
  throw new Error("Timed out waiting for fake-model lifecycle");
}
function context(root: string): ToolUseContext {
  return { agentId: "parent", messages: [], appState: new InMemoryAppState("parent", root),
    session: { sessionId: "parent", sessionDir: root },
    options: { mainLoopModel: "fake-inherited", reasoning: { effort: "high", summary: "detailed" },
      contextWindowTokensOverride: 123456, maxOutputTokensOverride: 2048, serviceTier: "priority" },
  } as unknown as ToolUseContext;
}
function runtime(store: TaskStore, gateway: ModelGateway): AgentToolRuntime {
  return { taskStore: store, modelGateway: gateway, tools: new ToolRegistry(), agentActivityStore: new AgentActivityStore(),
    agentCatalog: new StaticAgentCatalog([{ ...GENERAL_PURPOSE_AGENT, requiresReport: false }]),
    contextManager: { async build(input) { return { systemPrompt: "fake-model test", promptSections: [], userContext: { currentDate: "2026-09-06" }, systemContext: { cwd: input.cwd ?? process.cwd(), platform: process.platform } }; } },
    compactor: { async compact(messages) { return { messages: [...messages], changed: false }; } },
  };
}
class ProgressStore extends TaskStore {
  progressWrites = 0;
  override updateProgress(task: LocalAgentTask) { this.progressWrites++; super.updateProgress(task); }
}

for (const background of [false, true]) test(`${background ? "async" : "sync"} launch persists and fresh TaskStore resumes authoritative child context and parameters`, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "neo-agent-tool-restart-"));
  const store = new ProgressStore();
  let restarted: TaskStore | undefined;
  try {
    store.bindSession(root);
    const requests: ModelRequest[] = [];
    const gateway: ModelGateway = { async *stream(request): AsyncIterable<ModelStreamEvent> {
      requests.push(structuredClone({ ...request, cancellation: undefined }));
      yield { type: "assistant_delta", text: "working" };
      yield { type: "assistant_message", message: createTextMessage("assistant", "FIRST_RESULT") };
      yield { type: "response_completed", stopReason: "completed" };
    } };
    const rt = runtime(store, gateway);
    const budgets: (number | undefined)[] = [];
    rt.compactor = { async compact(messages, budget) { budgets.push(budget?.contextWindowTokens); return { messages: [...messages], changed: false }; } };
    const parent = context(root);
    const result = await createAgentTool(rt).call!({ prompt: "ORIGINAL_DIRECTIVE", name: "worker", cwd: "child", run_in_background: background }, parent, {});
    assert.equal(result.ok, true);
    const taskId = (result.output as { task_id: string }).task_id;
    assert(taskId);
    await until(() => store.get(taskId)?.status === "completed");
    await tick();
    const task = store.get(taskId)!;
    assert.equal(rt.agentActivityStore?.get(task.agentId)?.taskId, taskId);
    assert.equal(store.resolveAgentName("worker"), task.agentId);
    assert(store.progressWrites > 0);
    const child = await SessionStore.open({ rootDir: path.join(root, "subagents"), sessionId: task.agentId, agentId: task.agentId, resume: true });
    assert.deepEqual(JSON.parse(JSON.stringify(task.messages)), child.getInitialMessages(), "task messages must be exactly the child transcript, without completion notifications");
    // A durable compact checkpoint must win over the deliberately stale task snapshot after restart.
    child.recordCompactCheckpoint([createTextMessage("user", "AUTHORITATIVE_CHECKPOINT")], "autocompact");
    store.flush();
    restarted = new TaskStore();
    assert.equal(restarted.bindSession(root).loaded, 1);
    const restored = restarted.get(taskId)!;
    assert.notEqual(restored, task);
    assert.equal(restarted.resolveAgentName("worker"), task.agentId);
    assert.equal(restored.executionOptions?.cwd, path.join(root, "child"));
    const resumeRequests: ModelRequest[] = [];
    const resumeRuntime = runtime(restarted, { async *stream(request): AsyncIterable<ModelStreamEvent> {
      resumeRequests.push(structuredClone({ ...request, cancellation: undefined }));
      yield { type: "assistant_message", message: createTextMessage("assistant", "RESUMED_RESULT") };
      yield { type: "response_completed", stopReason: "completed" };
    } });
    const cwds: (string | undefined)[] = [];
    const manager = resumeRuntime.contextManager!;
    resumeRuntime.contextManager = { async build(input) { cwds.push(input.cwd); return manager.build(input); } };
    resumeRuntime.compactor = rt.compactor;
    const changedParent = context(root);
    changedParent.options = { ...changedParent.options, mainLoopModel: "wrong-parent-model", reasoning: { effort: "low" }, maxOutputTokensOverride: 99, contextWindowTokensOverride: 9999, serviceTier: "default" };
    assert.deepEqual(await resumeAgentTask(taskId, "RESUME_DIRECTIVE", resumeRuntime, restarted, changedParent), { ok: true });
    await until(() => restored.status === "completed");
    await tick();
    assert.equal(restored.runGeneration, 2);
    assert.equal(restored.result?.content, "RESUMED_RESULT");
    assert.equal(restored.runHistory?.[0].result?.content, "FIRST_RESULT");
    assert.equal(resumeRequests.length, 1);
    const serialized = JSON.stringify(resumeRequests[0].messages);
    assert.match(serialized, /AUTHORITATIVE_CHECKPOINT/);
    assert.doesNotMatch(serialized, /ORIGINAL_DIRECTIVE|FIRST_RESULT|task_notification/);
    assert.equal(serialized.split("RESUME_DIRECTIVE").length - 1, 1);
    for (const request of [...requests, ...resumeRequests]) {
      assert.equal(request.model, "fake-inherited");
      assert.deepEqual(request.reasoning, { effort: "high", summary: "detailed" });
      assert.equal(request.maxOutputTokens, 2048);
      assert.equal(request.serviceTier, "priority");
      assert.equal(request.queryOrigin, "subagent");
    }
    assert(budgets.length >= 2 && budgets.every((budget) => budget === 123456));
    assert(cwds.length > 0 && cwds.every((cwd) => cwd === path.join(root, "child")));
    const reopened = await SessionStore.open({ rootDir: path.join(root, "subagents"), sessionId: task.agentId, agentId: task.agentId, resume: true });
    assert.deepEqual(JSON.parse(JSON.stringify(restored.messages)), reopened.getInitialMessages());
  } finally { store.flush(); restarted?.flush(); await rm(root, { recursive: true, force: true }); }
});

for (const background of [false, true]) test(`${background ? "async" : "sync"} ownerless launch does not inherit active session or alias`, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "neo-agent-tool-owner-"));
  const store = new TaskStore();
  // Redirect ownerless output before any terminal boundary, avoiding the real user home.
  const attach = store.attachTask.bind(store);
  store.attachTask = (task, owner) => { task.outputFile = path.join(root, "output.txt"); attach(task, owner); };
  try {
    store.bindSession(root);
    const rt = runtime(store, { async *stream(): AsyncIterable<ModelStreamEvent> {
      yield { type: "assistant_message", message: createTextMessage("assistant", "done") };
      yield { type: "response_completed", stopReason: "completed" };
    } });
    const parent = context(root); parent.session = undefined;
    const result = await createAgentTool(rt).call!({ prompt: "ownerless", name: "unowned", run_in_background: background }, parent, {});
    const id = (result.output as { task_id: string }).task_id;
    await until(() => store.get(id)?.status === "completed");
    await tick();
    assert.equal(store.get(id)?.ownerSessionDir, undefined);
    assert.equal(store.list().length, 0);
    assert.equal(store.resolveAgentName("unowned"), undefined);
    assert.equal(new TaskStore().bindSession(root).loaded, 0);
    store.bindSession();
    assert.equal(store.resolveAgentName("unowned"), store.get(id)?.agentId);
  } finally { store.flush(); await rm(root, { recursive: true, force: true }); }
});

for (const cancellation of ["stop", "parent", "already-aborted", "superseded"] as const) test(`sync ${cancellation} cancels model and guards terminal/generation writes`, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "neo-agent-tool-cancel-"));
  const store = new TaskStore();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  try {
    store.bindSession(root);
    const parent = context(root);
    const controller = new AbortController(); parent.abortSignal = controller.signal;
    let calls = 0;
    let signal: AbortSignal | undefined;
    const rt = runtime(store, { async *stream(request): AsyncIterable<ModelStreamEvent> {
      const call = ++calls;
      if (call === 1) { signal = request.cancellation; await gate; }
      yield { type: "assistant_message", message: createTextMessage("assistant", call === 1 ? "STALE" : "WINNER") };
      yield { type: "response_completed", stopReason: "completed" };
    } });
    if (cancellation === "already-aborted") controller.abort("already cancelled");
    const running = createAgentTool(rt).call!({ prompt: "cancel me" }, parent, {});
    await until(() => store.list().length === 1);
    const task = store.list()[0];
    if (cancellation !== "already-aborted") {
      await until(() => !!signal);
      if (cancellation === "parent") controller.abort("parent cancelled");
      else assert.equal((await createSubagentStopTool(store).call!({ task_id: task.taskId }, parent, {})).ok, true);
      assert.equal(signal?.aborted, true);
      assert.equal(task.abortController?.signal.aborted, true);
    }
    if (cancellation === "superseded") {
      await resumeAgentTask(task.taskId, "new generation", rt, store, parent);
      await until(() => task.status === "completed");
    }
    const snapshot = cancellation === "superseded" ? JSON.stringify({ messages: task.messages, progress: task.progress, result: task.result, activity: rt.agentActivityStore?.get(task.agentId) }) : undefined;
    release();
    const result = await running;
    assert.equal(result.ok, false);
    assert.equal((result.output as { task_id: string }).task_id, task.taskId);
    assert.equal(task.status, cancellation === "superseded" ? "completed" : "killed");
    if (snapshot) assert.equal(JSON.stringify({ messages: task.messages, progress: task.progress, result: task.result, activity: rt.agentActivityStore?.get(task.agentId) }), snapshot);
    assert.doesNotMatch(JSON.stringify(task.messages), /STALE/);
  } finally { release(); store.flush(); await rm(root, { recursive: true, force: true }); }
});

for (const boundary of ["before-append", "before-ack", "after-ack-compact"] as const) test(`handoff restart at ${boundary}`, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "neo-handoff-restart-"));
  const store = new TaskStore();
  let fresh: TaskStore | undefined;
  try {
    store.bindSession(root);
    const rt = runtime(store, { async *stream(): AsyncIterable<ModelStreamEvent> {
      yield { type: "assistant_message", message: createTextMessage("assistant", "initial done") };
      yield { type: "response_completed", stopReason: "completed" };
    } });
    const launched = await createAgentTool(rt).call!({ prompt: "initial" }, context(root), {});
    const id = (launched.output as { task_id: string }).task_id;
    const task = store.get(id)!;
    // Stage a genuine durable queue->delivery transaction, then stop at the crash boundary.
    store.prepareResume(id, new AbortController());
    store.markRunning(id);
    const queued = store.queueMessage(task.agentId, "DURABLE_HANDOFF");
    assert(queued.ok);
    const handedOff = store.deliverPendingMessages(id, task.runGeneration);
    assert.equal(handedOff.length, 1);
    const messageId = handedOff[0].id;
    const child = await SessionStore.open({ rootDir: path.join(root, "subagents"), sessionId: task.agentId, agentId: task.agentId, resume: true });
    if (boundary !== "before-append") child.recordMessage(handedOff[0]);
    if (boundary === "after-ack-compact") {
      store.confirmDelivery(id, [messageId], task.runGeneration);
      child.recordCompactCheckpoint([createTextMessage("user", "COMPACTED_SUMMARY")], "autocompact");
    }
    store.flush();
    fresh = new TaskStore();
    assert.equal(fresh.bindSession(root).loaded, 1);
    const requests: ModelRequest[] = [];
    const resumed = runtime(fresh, { async *stream(request): AsyncIterable<ModelStreamEvent> {
      requests.push(structuredClone({ ...request, cancellation: undefined }));
      yield { type: "assistant_message", message: createTextMessage("assistant", "recovered") };
      yield { type: "response_completed", stopReason: "completed" };
    } });
    assert.deepEqual(await resumeAgentTask(id, "continue", resumed, fresh, context(root)), { ok: true });
    await until(() => fresh!.isTerminal(fresh!.get(id)!));
    assert.equal(fresh.get(id)?.status, "completed");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].messages.filter((message) => message.id === messageId).length, boundary === "after-ack-compact" ? 0 : 1);
    assert.equal(fresh.get(id)?.pendingMessages.length, 0);
    assert.equal(fresh.get(id)?.messageReceipts?.find((receipt) => receipt.messageId === messageId)?.status, "delivered");
    // Confirm must have durably removed the recovery outbox before a subsequent compact/restart.
    const reopened = await SessionStore.open({ rootDir: path.join(root, "subagents"), sessionId: task.agentId, agentId: task.agentId, resume: true });
    reopened.recordCompactCheckpoint([createTextMessage("user", "NEXT_SUMMARY")], "autocompact");
    fresh.flush();
    const again = new TaskStore(); again.bindSession(root);
    again.reconcileMessages(id, reopened.getInitialMessages());
    assert.equal(again.get(id)?.pendingMessages.length, 0);
    again.flush();
  } finally { store.flush(); fresh?.flush(); await rm(root, { recursive: true, force: true }); }
});

for (const background of [false, true]) for (const failure of ["initial", "confirmation"] as const) test(`handoff ${failure} failure stops ${background ? "async" : "sync"} before model/compact`, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "neo-handoff-fail-"));
  const store = new TaskStore();
  try {
    store.bindSession(root);
    let models = 0, compactions = 0, compactionsAtFailure = 0;
    const rt = runtime(store, { async *stream(): AsyncIterable<ModelStreamEvent> { models++; yield { type: "response_completed" }; } });
    rt.compactor = { async compact(messages) { compactions++; return { messages: [...messages], changed: false }; } };
    if (failure === "initial") store.reconcileMessages = () => { throw new Error("injected reconciliation failure"); };
    else {
      const attach = store.attachTask.bind(store);
      let queuedId: string | undefined;
      store.attachTask = (task, owner) => {
        attach(task, owner);
        const queued = store.queueMessage(task.agentId, "CONFIRM_BEFORE_MODEL");
        assert(queued.ok);
        queuedId = queued.receipt.messageId;
      };
      const confirm = store.confirmDelivery.bind(store);
      store.confirmDelivery = (id, ids, generation) => {
        if (queuedId && ids.includes(queuedId)) {
          compactionsAtFailure = compactions;
          throw new Error("injected confirmation failure");
        }
        confirm(id, ids, generation);
      };
    }
    const result = await createAgentTool(rt).call!({ prompt: "fail closed", run_in_background: background }, context(root), {});
    const id = (result.output as { task_id: string }).task_id;
    await until(() => store.isTerminal(store.get(id)!));
    assert.equal(store.get(id)?.status, "failed");
    assert.match(store.get(id)?.error ?? "", failure === "initial" ? /injected/ : /model_error/);
    assert.equal(models, 0);
    assert.equal(compactions, compactionsAtFailure, "no compaction may run after confirmation fails");
  } finally { store.flush(); await rm(root, { recursive: true, force: true }); }
});
