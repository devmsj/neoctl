import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { query } from "../../src/core/query.js";
import { QueryEngine } from "../../src/core/query-engine.js";
import { DefaultContextManager } from "../../src/context/context-manager.js";
import { applyRuntimeContextForPromptCache, createRuntimeTimeMessage } from "../../src/core/message-pipeline.js";
import { buildPromptCacheIdentity } from "../../src/core/prompt-cache-key.js";
import { buildAnthropicRequest } from "../../src/model/anthropic-mapper.js";
import { buildChatRequest } from "../../src/model/openai-chat-mapper.js";
import { buildResponsesRequest } from "../../src/model/openai-responses-mapper.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { createTextMessage, createToolResultMessage, type Message } from "../../src/types/messages.js";
import type { ModelRequest } from "../../src/model/model-gateway.js";

const model = "claude-haiku-5-5";
const text = (message: Message) => message.blocks.flatMap(b => b.type === "text" ? [b.text] : []).join("\n");
const drain = async (events: AsyncIterable<unknown>) => { for await (const _ of events) { /* consume */ } };
const compactor = { async compact(messages: readonly Message[]) { return { messages: [...messages], changed: false }; } };
const contextManager = { async build() { return { systemPrompt: "Stable instructions", promptSections: [], userContext: { currentDate: "old-date", projectMemory: "User-authored project instructions" }, systemContext: { cwd: "workspace", platform: "win32" as const } }; } };

test("time is one concise English UTC line at second precision; default user context has no clock", async () => {
  const message = createRuntimeTimeMessage(new Date("2026-11-03T12:34:56.789Z"));
  assert.equal(message.role, "system");
  assert.equal(message.isMeta, true);
  assert.equal(text(message), "Current time: 2026-11-03T12:34:56Z");
  const context = await new DefaultContextManager({ memoryFileNames: [], currentDate: () => "obsolete" }).build({ agentId: "test", messages: [] });
  assert.equal(context.userContext.currentDate, undefined);
});

test("runtime facts stay system; project documents stay user; changes append without editing history", () => {
  const first = applyRuntimeContextForPromptCache([createTextMessage("user", "start")], { currentDate: "old", projectMemory: "USER_DOC" }, { cwd: "A", platform: "win32", workspaceMemory: [{ content: "WORKSPACE_DOC" }] });
  assert.equal(first[0].role, "system");
  assert.doesNotMatch(JSON.stringify(first), /currentDate/);
  assert(first.filter(m => /USER_DOC|WORKSPACE_DOC/.test(text(m))).every(m => m.role === "user"));
  const history = [...first.slice(1), createTextMessage("assistant", "done"), createTextMessage("user", "next")];
  const second = applyRuntimeContextForPromptCache(history, {}, { cwd: "B", platform: "win32" });
  assert.deepEqual(second.slice(1, history.length + 1), history);
  assert.equal(text(second.at(-2)!), "User context: (none)");
  assert.match(text(second.at(-1)!), /cwd: B/);
  assert.equal(second.at(-1)?.role, "system");
  assert.equal(buildPromptCacheIdentity("stable", [], model, first).key, buildPromptCacheIdentity("stable", [], model, second).key);
});

test("every tool round appends time after results and pending user input; three wire prefixes remain identical", async () => {
  const requests: ModelRequest[] = [], saved: Message[] = [];
  const tools = new ToolRegistry();
  tools.register({ name: "probe", description: "status", inputSchema: { type: "object" }, metadata: { concurrent: true, readOnly: true, visible: true }, async execute() { return { ok: true, output: "OK" }; } });
  let now = Date.parse("2026-11-03T12:00:00Z"), pending = 0;
  for await (const event of query([createTextMessage("user", "start")], {
    tools, contextManager, compactor, runtimeNow: () => new Date(now += 2000),
    modelGateway: { async *stream(request) {
      requests.push(request);
      if (requests.length === 1) yield { type: "tool_use", toolUse: { id: "probe-1", name: "probe", input: {} } };
      else yield { type: "assistant_message", message: createTextMessage("assistant", "done") };
    } },
  }, { agentId: "test", model, takePendingMessages: () => ++pending === 2 ? [createTextMessage("user", "pending update")] : [] })) {
    if (event.type === "message") saved.push(event.message);
    if (event.type === "error") throw event.error;
  }
  assert.equal(requests.length, 2);
  assert.deepEqual(saved.filter(m => m.metadata?.runtimeTime).map(text), ["Current time: 2026-11-03T12:00:02Z", "Current time: 2026-11-03T12:00:04Z"]);
  assert.equal(requests[1].messages.at(-2)?.role, "user");
  assert.equal(text(requests[1].messages.at(-2)!), "pending update");
  assert.equal(requests[1].messages.at(-1)?.role, "system");
  assert.equal(requests[1].messages.filter(m => m.metadata?.runtimeContextUpdate === "system").length, 1);
  for (const map of [
    (r: ModelRequest) => buildAnthropicRequest(r, { model }),
    (r: ModelRequest) => buildChatRequest(r, { model: "gpt-6.1-sol" }),
    (r: ModelRequest) => buildResponsesRequest(r, { model: "gpt-6.1-sol" }),
  ]) {
    const a = map(requests[0]), b = map(requests[1]);
    const prefix = (a.messages ?? a.input) as unknown[], next = (b.messages ?? b.input) as unknown[];
    assert.deepEqual(next.slice(0, prefix.length), prefix);
    assert.deepEqual(b.system, a.system);
    assert.equal(b.instructions, a.instructions);
    assert.equal(b.prompt_cache_key, a.prompt_cache_key);
  }
  const wire = buildAnthropicRequest(requests[1], { model });
  assert.equal(wire.cache_control, undefined, "preserve prefixes without adding cache controls");
  assert.deepEqual((wire.messages as any[]).map(m => m.role), ["user", "system", "assistant", "user", "system"]);
});

test("time history survives session reload while the next request samples a fresh clock", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "neo-runtime-clock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const requests: ModelRequest[] = [];
  let now = Date.parse("2026-11-03T12:00:00Z");
  const options = { model, tools: new ToolRegistry(), contextManager, compactor, runtimeNow: () => new Date(now), session: { rootDir: root, sessionId: "clock", resume: true }, modelGateway: { async *stream(request: ModelRequest) { requests.push(request); yield { type: "assistant_message" as const, message: createTextMessage("assistant", "done") }; } } };
  const first = new QueryEngine(options);
  await drain(first.sendUserText("one"));
  const previousTime = first.getHistoryMessages().find(m => m.metadata?.runtimeTime)!;
  now += 65000;
  const next = new QueryEngine(options);
  await next.initialize();
  assert.deepEqual(next.getHistoryMessages().find(m => m.metadata?.runtimeTime), previousTime);
  await drain(next.sendUserText("two"));
  assert.deepEqual(requests[1].messages.filter(m => m.metadata?.runtimeTime).map(text), ["Current time: 2026-11-03T12:00:00Z", "Current time: 2026-11-03T12:01:05Z"]);
  assert.deepEqual((buildAnthropicRequest(requests[1], { model }).messages as any[]).slice(0, 2), buildAnthropicRequest(requests[0], { model }).messages);
});

test("interrupted Claude tail can resume with new user input without rewriting completed prefixes", () => {
  const t1 = createRuntimeTimeMessage(new Date("2026-11-03T12:00:00Z"));
  const t2 = createRuntimeTimeMessage(new Date("2026-11-03T12:01:00Z"));
  const history = [createTextMessage("user", "completed task"), t1, createTextMessage("assistant", "done"), createTextMessage("user", "interrupted task"), t2];
  const request = (messages: Message[]) => buildAnthropicRequest({ messages, tools: [], stream: true }, { model });
  const original = request(history);
  const next = request([...history, createTextMessage("user", "replacement task"), createRuntimeTimeMessage()]);
  assert.deepEqual((next.messages as any[]).slice(0, 3), (original.messages as any[]).slice(0, 3));
  assert.deepEqual((next.messages as any[]).map(m => m.role), ["user", "system", "assistant", "user", "system"]);
  assert.match(JSON.stringify((next.messages as any[]).at(-1)), /12:01:00Z/);
  assert.equal(text(t2), "Current time: 2026-11-03T12:01:00Z");
});

test("Claude resumes interrupted visible text and compact checkpoints without invented user text", () => {
  const user = createTextMessage("user", "task"), time = createRuntimeTimeMessage();
  const partial = { ...createTextMessage("assistant", "unfinished answer"), metadata: { streamedPartial: true } };
  const body = buildAnthropicRequest({ messages: [user, time, partial, createRuntimeTimeMessage()], tools: [], stream: true }, { model });
  assert.deepEqual((body.messages as any[]).map(m => m.role), ["user", "system"]);
  assert.equal((body.messages as any[])[0].content[0].text, "task");
  assert.match(JSON.stringify((body.messages as any[])[1]), /Interrupted assistant output \(quoted\)/);
  const boundary = { ...createTextMessage("system", "Checkpoint state"), metadata: { compactBoundary: true } };
  const compacted = buildAnthropicRequest({ messages: [user, boundary, createRuntimeTimeMessage()], tools: [], stream: true }, { model });
  assert.match(JSON.stringify(compacted.system), /Checkpoint state/);
  assert.equal((compacted.messages as any[]).at(-1).role, "system");
});

test("Anthropic compatible aliases preserve system roles without model-name gates while placement stays validated", () => {
  const user = createTextMessage("user", "start"), system = createTextMessage("system", "Runtime instruction");
  const build = (messages: Message[], id = model) => buildAnthropicRequest({ messages, tools: [], stream: true }, { model: id });
  for (const id of [model, "claude-sonnet-4-6", "deepseek-flash", "custom-alias"]) {
    const body = build([user, system], id);
    assert.deepEqual((body.messages as any[]).map(m => m.role), ["user", "system"]);
  }
  assert.throws(() => build([user, system, createTextMessage("user", "bad position")]), /must follow/);
  const call = { id: "a", name: "probe", input: {} };
  const assistant = { ...createTextMessage("assistant", ""), blocks: [{ type: "tool_use" as const, ...call }] };
  const result = createToolResultMessage(call, true, "OK");
  assert.throws(() => build([user, assistant, system, result]), /must follow/);
  assert.doesNotThrow(() => build([user, assistant, result, system]));
  assert.doesNotThrow(() => build([user, assistant, result, createRuntimeTimeMessage()], "deepseek-flash"));
});
