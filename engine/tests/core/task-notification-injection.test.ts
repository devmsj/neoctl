import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { QueryEngine } from "../../src/core/query-engine.js";
import type { TaskNotificationSource } from "../../src/core/query.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import type { ModelRequest, ModelStreamEvent } from "../../src/model/model-gateway.js";
import type { AgentEvent } from "../../src/types/events.js";
import { createTextMessage, type Message } from "../../src/types/messages.js";

type Completion = ReturnType<TaskNotificationSource["collectUnnotifiedCompletions"]>[number];
type Progress = NonNullable<ReturnType<NonNullable<TaskNotificationSource["collectProgressUpdates"]>>>[number];

function fakeSource() {
  const completions: Completion[] = [];
  const progress: Progress[] = [];
  const notified: string[] = [];
  const source: TaskNotificationSource = {
    collectUnnotifiedCompletions: () => completions.filter((task) => !notified.includes(task.taskId)),
    markNotified: (taskId) => { notified.push(taskId); },
    collectProgressUpdates: () => progress.splice(0),
  };
  return { completions, progress, notified, source };
}

const textOf = (message: Message) => message.blocks.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");
const notificationIndex = (messages: readonly Message[]) => messages.findIndex((message) => textOf(message).includes("<task-notification"));
async function collect(source: AsyncIterable<AgentEvent>) { const events: AgentEvent[] = []; for await (const event of source) events.push(event); return events; }

async function withEngine(fn: (dir: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "neo-task-notify-"));
  try { await fn(dir); } finally { await fs.rm(dir, { recursive: true, force: true }); }
}

test("a completion that arrived while idle rides on the next run's first request; no wake-up, delivered once", () => withEngine(async (dir) => {
  const fake = fakeSource();
  const requests: ModelRequest[] = [];
  const gateway = { async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    requests.push(request);
    yield { type: "assistant_message", message: createTextMessage("assistant", "ok") };
  } };
  const engine = new QueryEngine({ model: "test-model", tools: new ToolRegistry(), modelGateway: gateway, session: { rootDir: dir }, taskNotificationSource: fake.source,
    compactor: { async compact(messages: Message[]) { return { messages, changed: false }; } } });
  // Arrives between runs: nothing is sent until the user starts a run.
  fake.completions.push({ taskId: "task-1", agentId: "worker-1", status: "completed", type: "agent", content: "Report: tests pass.", reportStatus: "incomplete" });
  assert.equal(requests.length, 0);

  const events = await collect(engine.sendUserText("next question"));
  const first = requests[0]!.messages;
  const index = notificationIndex(first);
  assert.ok(index >= 0, "the first request of the run carries the notification");
  assert.ok(index > first.findIndex((message) => textOf(message) === "next question"), "after the user's message");
  assert.match(textOf(first[index]!), /status="completed" type="agent" report_status="incomplete">\nReport: tests pass\./);
  assert.deepEqual(fake.notified, ["task-1"]);
  const yielded = events.flatMap((event) => event.type === "message" && event.message.metadata?.taskNotification ? [event.message] : []);
  assert.equal(yielded.length, 1, "yielded once, so the transcript keeps it");

  await collect(engine.sendUserText("again"));
  assert.equal(requests[1]!.messages.filter((message) => textOf(message).includes("<task-notification")).length, 1, "history keeps it; never re-injected");
}));

test("reports arriving during a tool round are injected before the next request, after the tool results", () => withEngine(async (dir) => {
  const fake = fakeSource();
  const requests: ModelRequest[] = [];
  const tools = new ToolRegistry();
  tools.register({ name: "probe", description: "probe", inputSchema: { type: "object" }, metadata: { readOnly: true, concurrent: true, visible: true },
    validate() { return {}; },
    async call() { fake.progress.push({ taskId: "task-2", agentId: "worker-2", content: "status: running\nreport (draft): half done" }); return { ok: true, output: "probed" }; } });
  const gateway = { async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    requests.push(request);
    if (requests.length === 1) { yield { type: "tool_use", toolUse: { id: "call-probe", name: "probe", input: { description: "Probe" } } }; yield { type: "response_completed" }; }
    else yield { type: "assistant_message", message: createTextMessage("assistant", "done") };
  } };
  const engine = new QueryEngine({ model: "test-model", tools, modelGateway: gateway, session: { rootDir: dir }, taskNotificationSource: fake.source,
    compactor: { async compact(messages: Message[]) { return { messages, changed: false }; } } });
  await collect(engine.sendUserText("go"));
  assert.equal(notificationIndex(requests[0]!.messages), -1);
  const second = requests[1]!.messages;
  const index = notificationIndex(second);
  assert.ok(index > second.findIndex((message) => message.role === "tool_result"), "after the tool result it followed");
  assert.match(textOf(second[index]!), /type="progress">\nstatus: running\nreport \(draft\): half done/);
}));
