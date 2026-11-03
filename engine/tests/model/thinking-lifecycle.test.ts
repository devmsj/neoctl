import assert from "node:assert/strict";
import test from "node:test";
import { withThinkingLifecycle } from "../../src/model/thinking-lifecycle.js";
import { normalizeResponsesStream, buildResponsesRequest } from "../../src/model/openai-responses-mapper.js";
import { normalizeChatStream, normalizeChatObject } from "../../src/model/openai-chat-mapper.js";
import { normalizeAnthropicStream } from "../../src/model/anthropic-mapper.js";
import type { ModelStreamEvent } from "../../src/model/model-gateway.js";
import { query } from "../../src/core/query.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { createTextMessage } from "../../src/types/messages.js";

function sse(events: unknown[]) {
  return new ReadableStream<Uint8Array>({ start(c) { for (const e of events) c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(e)}\n\n`)); c.close(); } });
}
async function collect<T>(events: AsyncIterable<T>): Promise<T[]> { const out: T[] = []; for await (const e of events) out.push(e); return out; }
const delta = { type: "thinking_delta", text: "summary" } as const;
const publicTypes = (events: ModelStreamEvent[]) => events.filter(e => e.type !== "provider_event").map(e => e.type);

for (const boundary of [
  { type: "assistant_delta", text: "answer" }, { type: "tool_call_started", callId: "t", name: "echo" },
  { type: "tool_call_delta", callId: "t", argumentsDelta: "{}" }, { type: "response_completed" },
  { type: "response_incomplete", reason: "max_tokens" }, { type: "retrying", error: new Error("retry"), attempt: 1, delayMs: 0 },
] as ModelStreamEvent[]) {
  test(`thinking ends before ${boundary.type}, even without a provider done frame`, async () => {
    const source = async function* () { yield delta; yield boundary; };
    assert.deepEqual(publicTypes(await collect(withThinkingLifecycle(source()))), ["thinking_delta", "thinking_done", boundary.type]);
  });
}

test("empty deltas, duplicate done, multiple phases, EOF and errors are normalized", async () => {
  const source = async function* (): AsyncGenerator<ModelStreamEvent> { yield { type: "thinking_delta", text: "" }; yield delta; yield { type: "thinking_done" }; yield { type: "thinking_done" }; yield delta; };
  assert.deepEqual(publicTypes(await collect(withThinkingLifecycle(source()))), ["thinking_delta", "thinking_done", "thinking_delta", "thinking_done"]);
  const seen: ModelStreamEvent[] = [];
  await assert.rejects(async () => {
    for await (const e of withThinkingLifecycle((async function* () { yield delta; throw new Error("disconnect"); })())) seen.push(e);
  }, /disconnect/);
  assert.deepEqual(publicTypes(seen), ["thinking_delta", "thinking_done"]);
});

test("Responses requests automatic visible summaries while preserving explicit choices", () => {
  const request = { messages: [createTextMessage("user", "test")], tools: [], stream: true };
  assert.deepEqual(buildResponsesRequest({ ...request, reasoning: { effort: "high" } }, { model: "gpt-6.1-sol" }).reasoning, { effort: "high", summary: "auto" });
  assert.deepEqual(buildResponsesRequest({ ...request, reasoning: { summary: "detailed" } }, { model: "gpt-6.1-sol" }).reasoning, { summary: "detailed" });
  assert.equal(buildResponsesRequest({ ...request, reasoning: null }, { model: "gpt-6.1-sol" }).reasoning, undefined);
  assert.deepEqual(buildResponsesRequest({ ...request, reasoning: { effort: "none" } }, { model: "gpt-6.1-sol" }).reasoning, { effort: "none" });
  assert.equal(buildResponsesRequest(request, { model: "gpt-4o" }).reasoning, undefined);
});

test("Responses done-only summaries are shown once and completed before a tool starts", async () => {
  const item = { id: "r", type: "reasoning", summary: [{ type: "summary_text", text: "full summary" }] };
  const events = await collect(normalizeResponsesStream(sse([
    { type: "response.reasoning_summary_text.done", item_id: "r", summary_index: 0, text: "full summary" },
    { type: "response.reasoning_summary_part.done", item_id: "r", summary_index: 0, part: item.summary[0] },
    { type: "response.output_item.done", item },
    { type: "response.output_item.added", output_index: 1, item: { type: "function_call", id: "t", call_id: "t", name: "echo", arguments: "" } },
    { type: "response.completed", response: { output: [item] } },
  ]), { model: "gpt-test" }));
  assert.equal(events.filter(e => e.type === "thinking_delta").map(e => e.text).join(""), "full summary");
  assert.equal(events.filter(e => e.type === "thinking_done").length, 1);
  assert.ok(events.findIndex(e => e.type === "thinking_done") < events.findIndex(e => e.type === "tool_call_started"));
  const final = events.find(e => e.type === "assistant_message");
  assert.equal(final?.type === "assistant_message" && final.message.blocks[0].type === "thinking" && final.message.blocks[0].text, "full summary");
});

test("Responses partial deltas recover the missing done suffix without duplication", async () => {
  const events = await collect(normalizeResponsesStream(sse([
    { type: "response.reasoning_summary_text.delta", item_id: "r", delta: "hello" },
    { type: "response.reasoning_summary_text.done", item_id: "r", text: "hello world" },
    { type: "response.output_text.delta", delta: "answer" },
    { type: "response.completed", response: {} },
  ]), { model: "gpt-test" }));
  assert.equal(events.filter(e => e.type === "thinking_delta").map(e => e.text).join(""), "hello world");
  assert.ok(events.findIndex(e => e.type === "thinking_done") < events.findIndex(e => e.type === "assistant_delta"));
});

test("Responses output-item-only summary survives a sparse completion frame", async () => {
  const events = await collect(normalizeResponsesStream(sse([
    { type: "response.output_item.done", item: { id: "r", type: "reasoning", summary: [{ text: "retained" }] } },
    { type: "response.completed", response: {} },
  ]), { model: "gpt-test" }));
  assert.equal(events.filter(e => e.type === "thinking_delta").map(e => e.text).join(""), "retained");
  assert.ok(events.some(e => e.type === "assistant_message" && e.message.blocks.some(b => b.type === "thinking" && b.text === "retained")));
});

test("Chat emits reasoning before answer when both arrive in one chunk", async () => {
  const events = await collect(normalizeChatStream(sse([{ choices: [{ delta: { reasoning_content: "summary", content: "answer" }, finish_reason: "stop" }] }]), { model: "gpt-test" }));
  assert.deepEqual(publicTypes(events).slice(0, 3), ["thinking_delta", "thinking_done", "assistant_delta"]);
});

test("Anthropic content_block_stop ends thinking before later tool generation", async () => {
  const events = await collect(normalizeAnthropicStream(sse([
    { type: "message_start", message: { id: "m", usage: {} } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "summary" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t", name: "echo", input: {} } },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "tool_use" } }, { type: "message_stop" },
  ]), "claude-haiku-5-5"));
  const types = publicTypes(events);
  assert.ok(types.indexOf("thinking_done") < types.indexOf("tool_call_started"));
  assert.equal(types.filter(t => t === "thinking_done").length, 1);
});

test("Responses resolves index-only reasoning parts to known item IDs without duplicating done text", async () => {
  const item = { id: "r", type: "reasoning", summary: [{ text: "summary" }] };
  const events = await collect(normalizeResponsesStream(sse([
    { type: "response.output_item.added", output_index: 0, item: { ...item, summary: [] } },
    { type: "response.reasoning_summary_text.delta", output_index: 0, delta: "summary" },
    { type: "response.reasoning_summary_text.done", output_index: 0, text: "summary" },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { output: [item] } },
  ]), { model: "test" }));
  assert.equal(events.filter(e => e.type === "thinking_delta").map(e => e.text).join(""), "summary");
  assert.equal(events.filter(e => e.type === "thinking_done").length, 1);
});

test("Chat titles use only public content, never reasoning or explicitly private channels", async () => {
  const events = await collect(normalizeChatStream(sse([
    { choices: [{ index: 0, delta: { role: "assistant", channel: "analysis", reasoning: "summary", content: "private" } }] },
    { choices: [{ index: 0, delta: { content: " still private" } }] },
    { choices: [{ index: 0, delta: { channel: "final", content: "Public title" }, finish_reason: "stop" }] },
  ]), { model: "test" }));
  const { finalizeAgentTool } = await import("../../src/core/run-agent.js");
  const messages = events.flatMap(e => e.type === "assistant_message" ? [e.message] : []);
  assert.equal(finalizeAgentTool({ agentId: "title", agentType: "session-title", durationMs: 0, messages }).content, "Public title");
  assert.deepEqual(events.filter(e => e.type === "assistant_delta").map(e => e.displayChannel), [undefined, undefined, "visible"]);
  const plain = [...normalizeChatObject({ body: { choices: [{ message: { role: "assistant", reasoning: "summary", content: "Public title" } }] } } as never)];
  assert.equal(finalizeAgentTool({ agentId: "title", agentType: "session-title", durationMs: 0, messages: plain.flatMap(e => e.type === "assistant_message" ? [e.message] : []) }).content, "Public title");
  assert.ok(plain.some(e => e.type === "assistant_message" && e.message.blocks.some(b => b.type === "thinking" && b.text === "summary")));
});

test("query sends thinking.done on cancellation even when a provider ignores abort", async () => {
  const controller = new AbortController();
  const events = [];
  for await (const event of query([createTextMessage("user", "test")], {
    tools: new ToolRegistry(),
    contextManager: { async build() { return { systemPrompt: "test", promptSections: [], userContext: { currentDate: "2026-11-03" }, systemContext: { cwd: process.cwd(), platform: process.platform } }; } },
    modelGateway: { async *stream() { yield delta; await new Promise(() => {}); } },
  }, { agentId: "thinking-cancel", abortSignal: controller.signal, maxTurns: 1 })) {
    events.push(event);
    if (event.type === "thinking.delta") controller.abort();
  }
  assert.ok(events.some(e => e.type === "thinking.done"));
  assert.ok(events.findIndex(e => e.type === "thinking.done") < events.findIndex(e => e.type === "terminal"));
});
