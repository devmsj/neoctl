// Protocol-compatibility contracts: OpenAI/Anthropic here are wire protocols,
// not vendors. Standard signals are handled; vendor extensions are gated.
import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizeResponsesObject, normalizeResponsesStream, buildResponsesRequest } from "../../src/model/openai-responses-mapper.js";
import { normalizeChatObject, normalizeChatStream } from "../../src/model/openai-chat-mapper.js";
import { buildAnthropicRequest } from "../../src/model/anthropic-mapper.js";
import { OpenAIAdapter } from "../../src/model/openai-adapter.js";
import { AnthropicAdapter } from "../../src/model/anthropic-adapter.js";
import { HttpTransport } from "../../src/model/http-transport.js";
import { isQuotaExhausted, ModelAPIError } from "../../src/model/errors.js";
import { runAgent } from "../../src/core/run-agent.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import type { ToolUseContext } from "../../src/tools/tool.js";
import { createTextMessage, type Message } from "../../src/types/messages.js";
import type { ModelRequest, ModelStreamEvent } from "../../src/model/model-gateway.js";

const sse = (frames: object[], done = false) => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode(frames.map(f => `data: ${JSON.stringify(f)}\n\n`).join("") + (done ? "data: [DONE]\n\n" : ""))); c.close(); } });
async function collect<T>(it: AsyncIterable<T>): Promise<T[]> { const out: T[] = []; for await (const e of it) out.push(e); return out; }
const http = (body: Record<string, unknown>) => ({ status: 200, headers: new Headers(), body });
const committedText = (events: ModelStreamEvent[]) => events.filter(e => e.type === "assistant_message").flatMap(e => e.type === "assistant_message" ? e.message.blocks : []).filter(b => b.type === "text").map(b => b.type === "text" ? b.text : "").join("");
const end = (events: ModelStreamEvent[]) => events.find(e => e.type === "response_incomplete" || e.type === "response_completed");
async function server(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const instance = createServer(handler);
  instance.listen(0, "127.0.0.1"); await once(instance, "listening");
  const { port } = instance.address() as { port: number };
  return { url: `http://127.0.0.1:${port}`, async close() { instance.closeAllConnections(); await new Promise<void>(r => instance.close(() => r())); } };
}

const REFUSAL = "I can't help with that.";
const refusalItem = { id: "msg_1", type: "message", role: "assistant", status: "completed", content: [{ type: "refusal", refusal: REFUSAL }] };
const responsesRefusalFrames = (withRefusalEvents: boolean) => [
  { type: "response.created", response: { id: "resp_r", status: "in_progress" } },
  { type: "response.output_item.added", output_index: 0, item: { ...refusalItem, status: "in_progress", content: [] } },
  ...(withRefusalEvents ? [
    { type: "response.refusal.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: REFUSAL },
    { type: "response.refusal.done", item_id: "msg_1", output_index: 0, content_index: 0, refusal: REFUSAL },
  ] : []),
  { type: "response.output_item.done", output_index: 0, item: refusalItem },
  // Some compatible servers omit the output array on completion.
  { type: "response.completed", response: { id: "resp_r", status: "completed", usage: { input_tokens: 3, output_tokens: 2 } } },
];

test("Responses refusal (stream with/without refusal events, and non-stream) is incomplete, not a blank success", async () => {
  for (const withEvents of [true, false]) {
    const events = await collect(normalizeResponsesStream(sse(responsesRefusalFrames(withEvents)), { model: "any-model" }));
    const last = end(events);
    assert.ok(last?.type === "response_incomplete" && last.reason === "refusal" && last.detail === REFUSAL, `stream withEvents=${withEvents}`);
    assert.equal(committedText(events), "");
  }
  const plain = [...normalizeResponsesObject(http({ id: "resp_r", status: "completed", output: [refusalItem] }))];
  const last = end(plain);
  assert.ok(last?.type === "response_incomplete" && last.reason === "refusal" && last.detail === REFUSAL);
});

test("Chat refusal field (stream and non-stream) is incomplete with the refusal as detail", async () => {
  const streamed = await collect(normalizeChatStream(sse([{ id: "c", choices: [{ index: 0, delta: { role: "assistant", refusal: REFUSAL }, finish_reason: null }] }, { id: "c", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }], true), { model: "any-model" }));
  const plain = [...normalizeChatObject(http({ id: "c", choices: [{ index: 0, message: { role: "assistant", content: null, refusal: REFUSAL }, finish_reason: "stop" }] }))];
  for (const events of [streamed, plain]) {
    const last = end(events);
    assert.ok(last?.type === "response_incomplete" && last.reason === "refusal" && last.detail === REFUSAL);
    assert.equal(committedText(events), "");
  }
});

test("filtered output is discarded, truncated output is kept for continuation (Responses and Chat)", async () => {
  const responses = (reason: string) => [
    { type: "response.created", response: { id: "resp_i", status: "in_progress" } },
    { type: "response.output_item.added", output_index: 0, item: { id: "msg_1", type: "message", role: "assistant", content: [] } },
    { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "partial answer" },
    { type: "response.incomplete", response: { id: "resp_i", status: "incomplete", incomplete_details: { reason } } },
  ];
  const chat = (finish: string) => [{ id: "c", choices: [{ index: 0, delta: { content: "partial answer" }, finish_reason: finish }] }];
  for (const [reason, finish, kept] of [["max_output_tokens", "length", true], ["content_filter", "content_filter", false]] as const) {
    const a = await collect(normalizeResponsesStream(sse(responses(reason)), { model: "any-model" }));
    const b = await collect(normalizeChatStream(sse(chat(finish), true), { model: "any-model" }));
    const c = [...normalizeResponsesObject(http({ id: "r", status: "incomplete", incomplete_details: { reason }, output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "partial answer" }] }] }))];
    for (const events of [a, b, c]) {
      const last = end(events);
      assert.ok(last?.type === "response_incomplete" && last.reason === reason, reason);
      assert.equal(committedText(events), kept ? "partial answer" : "", reason);
    }
  }
});

test("query turns an OpenAI refusal into a model_error with the refusal text, committing nothing", { timeout: 20000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "neo-openai-refusal-"));
  // The refusal arrives after some visible draft text: the draft must not be saved either.
  const frames = [
    { type: "response.created", response: { id: "resp_r", status: "in_progress" } },
    { type: "response.output_item.added", output_index: 0, item: { id: "msg_0", type: "message", role: "assistant", content: [] } },
    { type: "response.output_text.delta", item_id: "msg_0", output_index: 0, content_index: 0, delta: "DRAFT_TEXT" },
    ...responsesRefusalFrames(true).slice(1),
  ];
  const local = await server((_req, res) => { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.end(frames.map(f => `data: ${JSON.stringify(f)}\n\n`).join("")); });
  try {
    const events = await collect(runAgent({ agentId: "openai-refusal", agent: { agentType: "test", whenToUse: "test", tools: [] }, prompt: "hello", model: "any-model", workspaceCwd: root, maxTurns: 3,
      parentContext: { session: { sessionId: "parent", sessionDir: root } } as ToolUseContext,
      dependencies: { tools: new ToolRegistry(), modelGateway: new OpenAIAdapter({ model: "any-model", baseUrl: local.url, apiKey: "test", endpoint: "responses", maxRetries: 0 }), contextManager: { async build() { return { systemPrompt: "test", promptSections: [], userContext: { currentDate: "2026-11-25" }, systemContext: { cwd: root, platform: process.platform } }; } }, compactor: { async compact(messages: readonly Message[]) { return { messages: [...messages], changed: false }; } } },
    }));
    assert.ok(events.some(e => e.type === "error" && e.error.message === `Model response incomplete: refusal (${REFUSAL})`));
    assert.ok(events.some(e => e.type === "terminal" && e.reason === "model_error"));
    assert.ok(events.some(e => e.type === "message"));
    assert.ok(!events.some(e => e.type === "message" && e.message.role === "assistant" && JSON.stringify(e.message.blocks).includes("DRAFT_TEXT")));
  } finally { await local.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test("cancelling an OpenAI-protocol stream closes the HTTP connection without waiting for the next chunk", async () => {
  let closedAt = 0;
  const local = await server((req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ type: "response.created", response: { id: "r" } })}\n\n`);
    req.socket.on("close", () => { closedAt = Date.now(); }); // then stays silent, like a long reasoning pause
  });
  try {
    const controller = new AbortController();
    const response = await new HttpTransport("openai").sendStream({ method: "POST", url: `${local.url}/v1/responses`, body: {}, timeoutMs: 5000, signal: controller.signal });
    const reader = response.body.getReader();
    await reader.read();
    const abortedAt = Date.now();
    controller.abort();
    const outcome = await Promise.race([reader.read().then(() => "data", () => "aborted"), new Promise(r => setTimeout(() => r("still waiting"), 2000))]);
    assert.equal(outcome, "aborted");
    for (let i = 0; i < 50 && !closedAt; i += 1) await new Promise(r => setTimeout(r, 20));
    assert.ok(closedAt && closedAt - abortedAt < 1000, `connection closed ${closedAt ? closedAt - abortedAt : "never"}ms after abort`);
  } finally { await local.close(); }
});

test("malformed tool-call JSON from the model is a non-retryable provider error, not a network retry", async () => {
  let calls = 0;
  const frames = [
    { type: "response.created", response: { id: "r", status: "in_progress" } },
    { type: "response.output_item.added", output_index: 0, item: { type: "function_call", call_id: "c1", name: "write_file", arguments: "" } },
    // Arguments only in the finished item (no delta events), as some compatible servers send them.
    { type: "response.output_item.done", output_index: 0, item: { type: "function_call", call_id: "c1", name: "write_file", arguments: "{\"path\": \"a" } },
    { type: "response.completed", response: { id: "r", status: "completed" } },
  ];
  const local = await server((_req, res) => { calls += 1; res.writeHead(200, { "Content-Type": "text/event-stream" }); res.end(frames.map(f => `data: ${JSON.stringify(f)}\n\n`).join("")); });
  try {
    const adapter = new OpenAIAdapter({ model: "any-model", baseUrl: local.url, apiKey: "test", endpoint: "responses", maxRetries: 3 });
    await assert.rejects(collect(adapter.stream({ messages: [createTextMessage("user", "hi")], tools: [], stream: true } as ModelRequest)),
      (e: unknown) => e instanceof ModelAPIError && e.category === "provider_bug" && !e.retryable);
    assert.equal(calls, 1);
  } finally { await local.close(); }
});

test("function-call arguments sent only in output_item.done are used, not an empty buffer", async () => {
  const frames = [
    { type: "response.created", response: { id: "r", status: "in_progress" } },
    { type: "response.output_item.added", output_index: 0, item: { type: "function_call", call_id: "c1", name: "write_file", arguments: "" } },
    { type: "response.output_item.done", output_index: 0, item: { type: "function_call", call_id: "c1", name: "write_file", arguments: "{\"path\":\"a.txt\"}" } },
    { type: "response.completed", response: { id: "r", status: "completed" } },
  ];
  const events = await collect(normalizeResponsesStream(sse(frames), { model: "any-model" }));
  const use = events.find(e => e.type === "tool_use");
  assert.deepEqual(use?.type === "tool_use" && use.toolUse.input, { path: "a.txt" });
});

test("quota/billing exhaustion is not retried; ordinary 429 throttling still is", async () => {
  assert.equal(isQuotaExhausted({ error: { type: "insufficient_quota", code: "credit_balance_exhausted", message: "No credits." } }), true);
  assert.equal(isQuotaExhausted({ type: "error", error: { type: "rate_limit_error", message: "You have reached your monthly spend cap." } }), true);
  assert.equal(isQuotaExhausted({ error: { type: "requests", code: "rate_limit_exceeded", message: "Rate limit reached for requests per min." } }), false);
  assert.equal(isQuotaExhausted({ error: { message: "All credentials are cooling down, retry later" } }), false);
  for (const protocol of ["openai", "anthropic"] as const) {
    let calls = 0;
    const local = await server((_req, res) => {
      calls += 1;
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify(protocol === "openai" ? { error: { type: "insufficient_quota", code: "insufficient_quota", message: "You exceeded your current quota." } } : { type: "error", error: { type: "rate_limit_error", message: "You have reached your monthly spend cap." } }));
    });
    try {
      const adapter = protocol === "openai"
        ? new OpenAIAdapter({ model: "any-model", baseUrl: local.url, apiKey: "test", endpoint: "responses", maxRetries: 3 })
        : new AnthropicAdapter({ model: "any-model", baseUrl: local.url, apiKey: "test", maxRetries: 3 });
      await assert.rejects(collect(adapter.stream({ messages: [createTextMessage("user", "hi")], tools: [], stream: true } as ModelRequest)),
        (e: unknown) => e instanceof ModelAPIError && e.status === 429 && !e.retryable);
      assert.equal(calls, 1, protocol);
    } finally { await local.close(); }
  }
});

test("fine-grained tool streaming is always requested and dropped only after a backend rejects it", async () => {
  const tool = { name: "write_file", description: "Write a file.", inputSchema: { type: "object", properties: { content: { type: "string" } } } };
  const seen: boolean[] = [];
  const ok = [
    { type: "message_start", message: { id: "m", type: "message", role: "assistant", content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ];
  const local = await server(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const eager = JSON.parse(raw).tools?.some((t: Record<string, unknown>) => "eager_input_streaming" in t) ?? false;
    seen.push(eager);
    if (eager) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: { message: "tools.0.eager_input_streaming: Extra inputs are not permitted" } })); return; }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(ok.map(f => `event: ${f.type}\ndata: ${JSON.stringify(f)}\n\n`).join(""));
  });
  try {
    const adapter = new AnthropicAdapter({ model: "third-party-model", baseUrl: local.url, apiKey: "test", maxRetries: 0 });
    const request = { messages: [createTextMessage("user", "hi")], tools: [tool], stream: true } as ModelRequest;
    for (let turn = 0; turn < 2; turn += 1) {
      const events = await collect(adapter.stream(request));
      assert.ok(events.some(e => e.type === "response_completed"));
    }
    // First request asks for it (any backend), the rejection falls back once, later turns remember.
    assert.deepEqual(seen, [true, false, false]);
  } finally { await local.close(); }
  // A backend that accepts it keeps getting it.
  assert.equal((buildAnthropicRequest({ messages: [createTextMessage("user", "hi")], tools: [tool], stream: true } as ModelRequest, { model: "third-party-model" }).tools as Record<string, unknown>[])[0]!.eager_input_streaming, true);
});

test("mid-conversation system turns are sent to every backend and folded into the user turn only after a rejection", async () => {
  const runtime: Message = { ...createTextMessage("system", "Runtime: date is 2026-11-25."), metadata: { runtimeContextUpdate: true } };
  const request = { messages: [createTextMessage("user", "What day is it?"), runtime], tools: [], stream: true } as ModelRequest;
  type Turn = { role: string; content: Record<string, unknown>[] };
  for (const model of ["claude-haiku-5-5", "third-party-model"]) {
    assert.deepEqual((buildAnthropicRequest(request, { model }).messages as Turn[]).map(t => t.role), ["user", "system"]);
  }
  const folded = buildAnthropicRequest(request, { model: "third-party-model" }, { foldSystemTurns: true }).messages as Turn[];
  assert.deepEqual(folded.map(t => t.role), ["user"]);
  assert.match(String(folded[0]!.content.at(-1)!.text), /<system-reminder>\nRuntime: date is 2026-11-25.\n<\/system-reminder>/);

  const seen: string[][] = [];
  const ok = [
    { type: "message_start", message: { id: "m", type: "message", role: "assistant", content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 0 } },
    { type: "message_stop" },
  ];
  const local = await server(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const roles = (JSON.parse(raw).messages as Turn[]).map(t => t.role);
    seen.push(roles);
    if (roles.includes("system")) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: { message: "messages.1.role: Input should be 'user' or 'assistant'" } })); return; }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(ok.map(f => `event: ${f.type}\ndata: ${JSON.stringify(f)}\n\n`).join(""));
  });
  try {
    const adapter = new AnthropicAdapter({ model: "third-party-model", baseUrl: local.url, apiKey: "test", maxRetries: 0 });
    for (let turn = 0; turn < 2; turn += 1) assert.ok((await collect(adapter.stream(request))).some(e => e.type === "response_completed"));
    assert.deepEqual(seen, [["user", "system"], ["user"], ["user"]]);
  } finally { await local.close(); }
});

test("allowed_tools is sent to every backend and replaced by standard tool_choice only after a rejection", async () => {
  const tools = [{ name: "echo", description: "echo", inputSchema: { type: "object", properties: {} } }];
  const choice = (model: string, toolChoice?: ModelRequest["toolChoice"], allowedTools?: boolean) => buildResponsesRequest({ messages: [createTextMessage("user", "hi")], tools, toolChoice, stream: true } as ModelRequest, { model }, { allowedTools }).tool_choice;
  for (const model of ["gpt-5.6-luna", "third-party-model"]) assert.equal((choice(model) as { type: string }).type, "allowed_tools");
  assert.equal(choice("third-party-model", undefined, false), "auto");
  assert.equal(choice("third-party-model", "required", false), "required");
  assert.equal(choice("third-party-model", "none"), "none");

  const seen: unknown[] = [];
  const done = [
    { type: "response.created", response: { id: "r", status: "in_progress" } },
    { type: "response.completed", response: { id: "r", status: "completed" } },
  ];
  const local = await server(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const toolChoice = JSON.parse(raw).tool_choice;
    seen.push(typeof toolChoice === "object" ? toolChoice.type : toolChoice);
    if (typeof toolChoice === "object") { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: { message: "Invalid value for 'tool_choice': unsupported type 'allowed_tools'." } })); return; }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(done.map(f => `data: ${JSON.stringify(f)}\n\n`).join(""));
  });
  try {
    const adapter = new OpenAIAdapter({ model: "third-party-model", baseUrl: local.url, apiKey: "test", endpoint: "responses", maxRetries: 0 });
    const request = { messages: [createTextMessage("user", "hi")], tools, stream: true } as ModelRequest;
    for (let turn = 0; turn < 2; turn += 1) assert.ok((await collect(adapter.stream(request))).some(e => e.type === "response_completed"));
    assert.deepEqual(seen, ["allowed_tools", "auto", "auto"]);
  } finally { await local.close(); }
});
