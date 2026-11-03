import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildAnthropicRequest, normalizeAnthropicObject, normalizeAnthropicStream } from "../../src/model/anthropic-mapper.js";
import { finalizeAgentTool } from "../../src/core/run-agent.js";
import { QueryEngine } from "../../src/core/query-engine.js";
import { SessionStore } from "../../src/session/session-store.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { createTextMessage, withoutThinkingBlocks, type Message } from "../../src/types/messages.js";
import type { ModelRequest, ModelStreamEvent } from "../../src/model/model-gateway.js";
import { restoreWebHistoryLines, WebRepl } from "../../src/web/index.js";

let settingsRoot: string;
const previousSettingsRoot = process.env.NEO_MODEL_CONFIG_DIR;
before(async () => {
  settingsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "neo-claude-display-settings-"));
  process.env.NEO_MODEL_CONFIG_DIR = settingsRoot;
});
after(async () => {
  if (previousSettingsRoot === undefined) delete process.env.NEO_MODEL_CONFIG_DIR;
  else process.env.NEO_MODEL_CONFIG_DIR = previousSettingsRoot;
  await fs.rm(settingsRoot, { recursive: true, force: true });
});

const model = "claude-haiku-5-5";
const request = (patch: Partial<ModelRequest> = {}): ModelRequest => ({ messages: [createTextMessage("user", "test")], tools: [], stream: true, ...patch });
const response = (content: Record<string, unknown>[]) => ({ type: "message", id: "msg_display", content, stop_reason: "end_turn" });
function stream(content: Record<string, unknown>[], initialText = false): ReadableStream<Uint8Array> {
  const events: Record<string, unknown>[] = [{ type: "message_start", message: { id: "msg_display", usage: {} } }];
  content.forEach((block, index) => {
    const key = block.type === "thinking" ? "thinking" : "text";
    events.push({ type: "content_block_start", index, content_block: { ...block, [key]: initialText ? block[key] : "", signature: undefined } });
    if (!initialText) events.push({ type: "content_block_delta", index, delta: { type: `${key}_delta`, [key]: block[key] } });
    if (block.signature) events.push({ type: "content_block_delta", index, delta: { type: "signature_delta", signature: block.signature } });
    events.push({ type: "content_block_stop", index });
  });
  events.push({ type: "message_delta", delta: { stop_reason: "end_turn" } }, { type: "message_stop" });
  const bytes = new TextEncoder().encode(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(""));
  return new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } });
}
async function collect(events: AsyncIterable<ModelStreamEvent>): Promise<ModelStreamEvent[]> {
  const result: ModelStreamEvent[] = []; for await (const event of events) result.push(event); return result;
}
function messageOf(events: ModelStreamEvent[]): Message {
  const event = events.find(e => e.type === "assistant_message");
  assert.ok(event?.type === "assistant_message"); return event.message;
}

test("Claude requests visible adaptive summaries, including default thinking, without enabling disabled thinking", () => {
  for (const reasoning of [undefined, { effort: "high" }]) {
    const body = buildAnthropicRequest(request({ reasoning }), { model });
    assert.deepEqual(body.thinking, { type: "adaptive", display: "summarized" });
    assert.deepEqual(body.output_config, reasoning ? { effort: "high" } : undefined);
  }
  for (const reasoning of [null, { effort: "none" }]) {
    assert.deepEqual(buildAnthropicRequest(request({ reasoning }), { model }).thinking, { type: "disabled" });
  }
  assert.deepEqual(buildAnthropicRequest(request({ reasoning: { effort: "high" } }), { model: "claude-haiku-4-5" }).thinking, { type: "enabled", budget_tokens: 4096 });
  assert.equal(buildAnthropicRequest(request(), { model: "unknown-compatible-model" }).thinking, undefined);
});

test("Claude text is provider-confirmed visible in streamed and non-streamed title results", async () => {
  const content = [{ type: "thinking", thinking: "summary", signature: "opaque-signature" }, { type: "text", text: "工程工具全面测试" }];
  const streamed = await collect(normalizeAnthropicStream(stream(content), model));
  const plain = [...normalizeAnthropicObject(response(content), model)];
  for (const events of [streamed, plain]) {
    const message = messageOf(events);
    const text = message.blocks.find(b => b.type === "text");
    assert.equal(text?.displayChannel, "visible");
    const result = finalizeAgentTool({ agentId: "title", agentType: "session-title", durationMs: 0, messages: [message] });
    assert.equal(result.content, "工程工具全面测试");
    assert.equal(result.displaySource, "visible_text");
    assert.equal(message.blocks.some(b => b.type === "thinking" && "displayChannel" in b), false);
  }
  assert.ok(streamed.some(e => e.type === "assistant_delta" && e.displayChannel === "visible"));
});

test("initial content in compatible SSE blocks is streamed once with the correct display channel", async () => {
  const events = await collect(normalizeAnthropicStream(stream([{ type: "thinking", thinking: "summary", signature: "sig" }, { type: "text", text: "answer" }], true), model));
  assert.deepEqual(events.filter(e => e.type === "thinking_delta"), [{ type: "thinking_delta", text: "summary" }]);
  assert.deepEqual(events.filter(e => e.type === "assistant_delta"), [{ type: "assistant_delta", text: "answer", displayChannel: "visible" }]);
  assert.equal(messageOf(events).blocks.find(b => b.type === "text")?.text, "answer");
});

test("signature-only thinking produces no empty delta and survives history replay", async () => {
  const content = [{ type: "thinking", thinking: "", signature: "opaque-signature" }, { type: "text", text: "done" }];
  const events = await collect(normalizeAnthropicStream(stream(content), model));
  assert.equal(events.some(e => e.type === "thinking_delta"), false);
  const message = messageOf(events);
  const restored = withoutThinkingBlocks(JSON.parse(JSON.stringify([message])));
  const next = buildAnthropicRequest(request({ messages: [createTextMessage("user", "test"), ...restored, createTextMessage("user", "continue")] }), { model });
  const turns = next.messages as Array<{ content: unknown[] }>;
  assert.deepEqual(turns[1]!.content, content, "signatures must not be removed or rewritten for display");
});

test("history hides signature-only or whitespace thinking without modifying signed messages", () => {
  const hidden = messageOf([...normalizeAnthropicObject(response([{ type: "thinking", thinking: "", signature: "sig" }, { type: "text", text: "done" }]), model)]);
  const whitespace: Message = { ...createTextMessage("assistant", ""), blocks: [{ type: "thinking", text: "  \n" }] };
  const visible: Message = { ...createTextMessage("assistant", ""), blocks: [{ type: "thinking", text: "visible summary" }] };
  const before = JSON.stringify(hidden);
  const lines = restoreWebHistoryLines({ engine: { getDisplayEntries: () => [hidden, whitespace, visible].map(message => ({ type: "message", message })) } } as never);
  assert.deepEqual(lines.filter(l => l.kind === "thinking").map(l => l.text), ["visible summary"]);
  assert.equal(JSON.stringify(hidden), before);
});

test("live empty thinking deltas do not create a blank UI line", () => {
  const repl = new WebRepl({
    engine: { getDisplayEntries: () => [], snapshot: () => ({ session: { sessionId: "test" } }), isFastMode: () => false, getAppPrompt: () => ({}), onSessionTitleChange: () => () => undefined },
    usage: { snapshot: () => ({}) }, taskStore: { subscribe: () => () => undefined, list: () => [] },
    execProcessManager: { subscribe: () => () => undefined, subscribeOutput: () => () => undefined, list: () => [] },
  } as never);
  const handle = (repl as unknown as { handleEvent(event: unknown): void }).handleEvent.bind(repl);
  handle({ type: "thinking.delta", text: "" });
  assert.equal(repl.snapshot(false).lines.filter(l => l.kind === "thinking").length, 0);
  handle({ type: "thinking.delta", text: "visible summary" });
  assert.equal(repl.snapshot(false).lines.find(l => l.kind === "thinking")?.text, "visible summary");
});

test("Anthropic title generation persists initial and refined titles and lists them after reload", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "neo-claude-title-")));
  const titles = ["工程工具全面测试", "工程工具测试与问题汇总"];
  let calls = 0;
  const engine = new QueryEngine({ model, cwd: root, tools: new ToolRegistry(), session: { rootDir: root, sessionId: "title-test", resume: true }, modelGateway: {
    async *stream(request) {
      assert.deepEqual(request.tools, [], "title generation must not inherit report tools");
      assert.match(request.systemPrompt ?? "", /conversation titles/i);
      assert.doesNotMatch(request.systemPrompt ?? "", /subagent_report|subagent worker|sole coordinator/i);
      assert.ok(request.messages.some(m => m.blocks.some(b => b.type === "text" && b.text.includes("全面测试工程工具"))));
      yield* normalizeAnthropicStream(stream([{ type: "text", text: titles[calls++]! }]), model);
    },
  } });
  try {
    const store = await SessionStore.open({ agentId: "main", rootDir: root, sessionId: "title-test" });
    store.recordMessage(createTextMessage("user", "全面测试工程工具"));
    await engine.initialize();
    const control = engine as unknown as { titleSchedulerVersion: number; runSessionTitleCheck(version: number): Promise<void> };
    const check = () => control.runSessionTitleCheck(control.titleSchedulerVersion);
    await check();
    assert.equal(engine.snapshot().session?.title, titles[0]);
    await check();
    assert.equal(engine.snapshot().session?.title, titles[1]);
    await check();
    assert.equal(calls, 2, "no more title work after refinement");
    assert.equal((await engine.listSessions(1))[0]?.title, titles[1]);
    const restored = engine.forkForSession("title-test", true);
    await restored.initialize();
    assert.equal(restored.snapshot().session?.title, titles[1]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
