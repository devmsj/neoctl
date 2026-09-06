import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DefaultContextManager } from "../context/context-manager.js";
import { TaskStore } from "../tasks/task-store.js";
import { createAgentTool, resumeAgentTask, type AgentToolRuntime } from "./agent-tool.js";
import { StaticAgentCatalog, GENERAL_PURPOSE_AGENT } from "./agent-definition.js";
import { ToolRegistry } from "../tools/registry.js";
import { InMemoryAppState } from "../app/app-state.js";
import type { ToolUseContext } from "../tools/tool.js";
import type { ModelGateway, ModelRequest, ModelStreamEvent } from "../model/model-gateway.js";
import { createTextMessage } from "../types/messages.js";

const root = mkdtempSync(path.join(tmpdir(), "neo-lifecycle-"));
const context = { agentId: "parent", messages: [], appState: new InMemoryAppState("parent", root) } as unknown as ToolUseContext;
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));
async function until(check: () => boolean) { for (let i = 0; i < 500; i++) { if (check()) return; await tick(); } throw new Error("Timed out"); }
const text = (r: ModelRequest) => JSON.stringify(r.messages);
try {
  const store = new TaskStore();
  const requests: ModelRequest[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let releaseResume!: () => void;
  const resumeGate = new Promise<void>((resolve) => { releaseResume = resolve; });
  const gateway: ModelGateway = { async *stream(request): AsyncIterable<ModelStreamEvent> {
    requests.push(structuredClone({ ...request, cancellation: undefined }));
    if (requests.length === 1) {
      await firstGate;
      yield { type: "tool_use", toolUse: { id: "echo-1", name: "echo", input: {} } };
      yield { type: "response_completed", stopReason: "tool_calls" };
    } else {
      if (requests.length === 3) await resumeGate;
      if (requests.length === 2) store.queueMessage(store.list()[0].agentId, "terminal-boundary-message");
      yield { type: "assistant_message", message: createTextMessage("assistant", requests.length === 2 ? "old-result" : "new-result") };
      yield { type: "response_completed", stopReason: "completed" };
    }
  } };
  const tools = new ToolRegistry();
  tools.register({ name: "echo", description: "fake", inputSchema: { type: "object" }, metadata: { readOnly: true, concurrent: true, visible: true }, validate: () => ({}), async call() { return { ok: true, output: "paired" }; } });
  const seenCwds: (string | undefined)[] = [];
  const baseContextManager = new DefaultContextManager();
  const runtime: AgentToolRuntime = { contextManager: { async build(input) { seenCwds.push(input.cwd); return baseContextManager.build(input); } }, modelGateway: gateway, tools, taskStore: store, agentCatalog: new StaticAgentCatalog([{ ...GENERAL_PURPOSE_AGENT, requiresReport: false }]) };
  const launched = await createAgentTool(runtime).call!({ prompt: "original-directive", run_in_background: true, cwd: "child", model: "fake-model" }, context, {});
  assert.equal(launched.ok, true);
  await until(() => requests.length === 1);
  const task = store.list()[0];
  task.outputFile = path.join(root, "task.txt");
  const queued = store.queueMessage(task.agentId, "running-inbox-message");
  assert(queued.ok);
  assert.equal(queued.receipt.status, "queued");
  assert(!text(requests[0]).includes("running-inbox-message"));
  releaseFirst();
  await until(() => task.status === "completed");
  assert.equal(requests.length, 2);
  assert(text(requests[1]).includes("running-inbox-message"));
  const blocks = requests[1].messages.flatMap((m) => m.blocks);
  assert(blocks.findIndex((b) => b.type === "tool_result") < blocks.findIndex((b) => b.type === "text" && b.text === "running-inbox-message"));
  assert.equal(queued.receipt.status, "delivered");
  assert(queued.receipt.deliveredAt);
  assert.equal(task.pendingMessages.length, 1);
  assert.equal(task.messageReceipts?.at(-1)?.status, "queued");
  assert.equal(task.result?.content, "old-result");
  assert.deepEqual(await resumeAgentTask(task.taskId, "resume-directive", runtime, store, context), { ok: true });
  assert.equal(task.runGeneration, 2);
  assert.equal(task.result, undefined);
  assert.equal(task.completedAt, undefined);
  assert.equal(task.runHistory?.[0].result?.content, "old-result");
  assert(!readFileSync(task.outputFile, "utf8").includes("old-result"));
  await until(() => requests.length === 3);
  assert(text(requests[2]).includes("terminal-boundary-message"));
  assert(text(requests[2]).includes("original-directive"));
  assert(text(requests[2]).includes("resume-directive"));
  assert.equal(requests[2].model, "fake-model");
  assert.equal(task.executionOptions?.cwd, path.join(root, "child"));
  assert.equal(seenCwds[2], path.join(root, "child"));
  assert.equal(task.messageReceipts?.at(-1)?.runGeneration, 2);
  assert.equal((await resumeAgentTask(task.taskId, "invalid", runtime, store, context)).ok, false);
  releaseResume();
  await until(() => task.status === "completed");
  assert.equal(store.get(task.taskId)?.result?.content, "new-result");
  console.log("PASS running inbox reaches next fake-model request after paired tool results; terminal inbox retained/resumed; receipts; archived results; output reset");

  let releaseOld!: () => void;
  let oldClosed = false;
  let calls = 0;
  const oldGate = new Promise<void>((resolve) => { releaseOld = resolve; });
  const racing: ModelGateway = { async *stream(): AsyncIterable<ModelStreamEvent> {
    calls++;
    if (calls === 1) { try { await oldGate; yield { type: "assistant_message", message: createTextMessage("assistant", "stale-result") }; } finally { oldClosed = true; } }
    else yield { type: "assistant_message", message: createTextMessage("assistant", "winning-generation") };
    yield { type: "response_completed", stopReason: "completed" };
  } };
  const raceStore = new TaskStore();
  const raceRuntime = { ...runtime, modelGateway: racing, taskStore: raceStore };
  await createAgentTool(raceRuntime).call!({ prompt: "race", run_in_background: true }, context, {});
  await until(() => calls === 1);
  const raceTask = raceStore.list()[0];
  raceTask.outputFile = path.join(root, "race.txt");
  raceStore.kill(raceTask.taskId);
  const retained = raceStore.queueMessage(raceTask.agentId, "after-cancel");
  assert(retained.ok);
  assert.equal(retained.receipt.status, "queued");
  await resumeAgentTask(raceTask.taskId, undefined, raceRuntime, raceStore, context);
  await until(() => raceTask.status === "completed");
  releaseOld();
  await until(() => oldClosed);
  await tick();
  assert.equal(raceTask.result?.content, "winning-generation");
  assert.equal(raceTask.runGeneration, 2);
  assert.equal(raceTask.runHistory?.[0].status, "killed");
  assert(!JSON.stringify(raceTask.messages).includes("stale-result"));
  console.log("PASS cancelled stream closes; old generation cannot overwrite resumed result/messages");
  for (let i = 0; i < 10; i++) { raceStore.prepareResume(raceTask.taskId, new AbortController()); raceStore.complete(raceTask.taskId, { agent_id: raceTask.agentId, agent_type: "fake", content: "archive", total_duration_ms: 0, total_tool_use_count: 0 }); }
  assert.equal(raceTask.runHistory?.length, 8);
  raceStore.prepareResume(raceTask.taskId, new AbortController());
  raceStore.markRunning(raceTask.taskId);
  for (let i = 0; i < 140; i++) raceStore.queueMessage(raceTask.agentId, `bounded-${i}`);
  raceStore.deliverPendingMessages(raceTask.taskId, raceTask.runGeneration);
  assert.equal(raceTask.messageReceipts?.length, 128);
  for (let i = 0; i < 256; i++) assert(raceStore.queueMessage(raceTask.agentId, `pending-${i}`).ok);
  assert.equal(raceStore.queueMessage(raceTask.agentId, "overflow").ok, false);
  assert.equal(raceTask.pendingMessages.length, 256);
  assert.equal(raceStore.deliverPendingMessages(raceTask.taskId, raceTask.runGeneration - 1).length, 0);
  assert.equal(raceTask.pendingMessages.length, 256);
  raceStore.deliverPendingMessages(raceTask.taskId, raceTask.runGeneration);
  assert.equal(raceStore.queueMessage(raceTask.agentId, "x".repeat(16385)).ok, false);
  for (let i = 0; i < 3; i++) assert(raceStore.queueMessage(raceTask.agentId, "x".repeat(16384)).ok);
  assert.equal(raceStore.deliverPendingMessages(raceTask.taskId, raceTask.runGeneration).length, 2);
  assert.equal(raceTask.pendingMessages.length, 1);
  assert.equal(raceTask.messageReceipts?.at(-1)?.status, "queued");
  assert.equal(raceStore.deliverPendingMessages(raceTask.taskId, raceTask.runGeneration).length, 1);
  const aborted = new AbortController(); aborted.abort();
  assert.equal(await raceStore.waitForTerminal(raceTask.taskId, { signal: aborted.signal }), raceTask);
  console.log("PASS bounded delivered receipt/run histories, message/batch character limits and already-aborted waiter");

  const reportStore = new TaskStore();
  let reportCalls = 0;
  const reportGateway: ModelGateway = { async *stream(request): AsyncIterable<ModelStreamEvent> {
    reportCalls++;
    if (reportCalls === 2) {
      assert(text(request).includes("old-authoritative-report"));
      assert(text(request).includes("new-report-directive"));
      yield { type: "assistant_message", message: createTextMessage("assistant", "No new report yet") };
    } else {
      if (reportCalls === 3) assert(request.toolChoice);
      yield { type: "tool_use", toolUse: { id: `report-${reportCalls}`, name: "subagent_report", input: { status: "completed", content: reportCalls === 1 ? "old-authoritative-report" : "new-authoritative-report" } } };
    }
    yield { type: "response_completed", stopReason: reportCalls === 2 ? "completed" : "tool_calls" };
  } };
  const reportRuntime: AgentToolRuntime = { ...runtime, taskStore: reportStore, modelGateway: reportGateway, agentCatalog: new StaticAgentCatalog([GENERAL_PURPOSE_AGENT]) };
  await createAgentTool(reportRuntime).call!({ prompt: "report-required", run_in_background: true }, context, {});
  const reportTask = reportStore.list()[0];
  reportTask.outputFile = path.join(root, "report.txt");
  await until(() => reportTask.status === "completed");
  assert.equal(reportTask.result?.content, "old-authoritative-report");
  await resumeAgentTask(reportTask.taskId, "new-report-directive", reportRuntime, reportStore, context);
  await until(() => reportTask.status === "completed");
  assert.equal(reportCalls, 3, "old report must not skip required-report recovery in resumed run");
  assert.equal(reportTask.result?.content, "new-authoritative-report");
  assert.equal(reportTask.runHistory?.[0].result?.content, "old-authoritative-report");
  console.log("PASS report-required resume ignores historical report and requires new authoritative report");
} finally {
  rmSync(root, { recursive: true, force: true });
}
