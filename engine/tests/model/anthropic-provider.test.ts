import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AnthropicAdapter } from "../../src/model/anthropic-adapter.js";
import { buildAnthropicRequest, normalizeAnthropicObject, normalizeAnthropicStream } from "../../src/model/anthropic-mapper.js";
import { readModelProviderConfig } from "../../src/model/config.js";
import { createModelGatewayFromConfig } from "../../src/model/provider-factory.js";
import { OpenAIAdapter } from "../../src/model/openai-adapter.js";
import { createTextMessage, createToolResultMessage, withoutThinkingBlocks, type Message } from "../../src/types/messages.js";
import type { ModelRequest, ModelStreamEvent } from "../../src/model/model-gateway.js";
import { ModelAPIError } from "../../src/model/errors.js";
import { runAgent } from "../../src/core/run-agent.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import type { ToolUseContext } from "../../src/tools/tool.js";
import { ModelDrivenCompactor } from "../../src/context/compaction.js";
import { WebRepl } from "../../src/web/index.js";

const model = "claude-sonnet-4-6";
const tool = { name: "echo", description: "echo", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } };
const user = () => createTextMessage("user", "hello");
const request = (patch: Partial<ModelRequest> = {}): ModelRequest => ({ messages: [user()], tools: [], stream: true, ...patch });
async function collect<T>(events: AsyncIterable<T>): Promise<T[]> { const result: T[] = []; for await (const e of events) result.push(e); return result; }
function completion(content: Record<string, unknown>[] = [{ type: "text", text: "done" }], stop = "end_turn") {
  return { type: "message", id: "msg_test", role: "assistant", model, content, stop_reason: stop, usage: { input_tokens: 10, output_tokens: 5 } };
}
function frames(content: Record<string, unknown>[] = [{ type: "text", text: "你好" }], stop = "end_turn") {
  const events: Record<string, unknown>[] = [{ type: "message_start", message: { id: "msg_test", type: "message", role: "assistant", model, content: [], usage: { input_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 30, output_tokens: 0 } } }, { type: "ping" }];
  content.forEach((block, index) => {
    if (block.type === "text") {
      events.push({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
      events.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } });
    } else if (block.type === "thinking") {
      events.push({ type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } });
      events.push({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: block.thinking } });
      events.push({ type: "content_block_delta", index, delta: { type: "signature_delta", signature: block.signature } });
    } else if (block.type === "tool_use") {
      events.push({ type: "content_block_start", index, content_block: { ...block, input: {} } });
      const json = JSON.stringify(block.input);
      events.push({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: json.slice(0, 5) } });
      events.push({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: json.slice(5) } });
    } else events.push({ type: "content_block_start", index, content_block: block });
    events.push({ type: "content_block_stop", index });
  });
  events.push({ type: "message_delta", delta: { stop_reason: stop }, usage: { output_tokens: 5 } }, { type: "message_stop" });
  return events;
}
const encode = (events: Record<string, unknown>[]) => events.map(e => `event: ${e.type}\r\ndata: ${JSON.stringify(e)}\r\n\r\n`).join("");
function stream(events: Record<string, unknown>[], chunkSize = 7) {
  const bytes = new TextEncoder().encode(encode(events));
  return new ReadableStream<Uint8Array>({ start(controller) { for (let i = 0; i < bytes.length; i += chunkSize) controller.enqueue(bytes.slice(i, i + chunkSize)); controller.close(); } });
}
async function server(handler: (req: IncomingMessage, res: ServerResponse, body: any) => void | Promise<void>) {
  const instance = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    try { await handler(req, res, raw ? JSON.parse(raw) : undefined); }
    catch (error) { res.writeHead(500); res.end(JSON.stringify({ error: { message: String(error) } })); }
  });
  instance.listen(0, "127.0.0.1"); await once(instance, "listening");
  const address = instance.address() as { port: number };
  return { url: `http://127.0.0.1:${address.port}`, async close() { instance.closeAllConnections(); await new Promise<void>((resolve, reject) => instance.close(e => e ? reject(e) : resolve())); } };
}

test("config/factory selects native anthropic without changing OpenAI", () => {
  const config = readModelProviderConfig({ MODEL_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "gateway-key", ANTHROPIC_BASE_URL: "http://localhost:8317", ANTHROPIC_MODEL: model, MODEL_REASONING_EFFORT: "high", MODEL_REASONING_SUMMARY: "auto" });
  assert.equal(config?.provider, "anthropic");
  assert.deepEqual(config?.defaultReasoning, { effort: "high", summary: undefined });
  assert.ok(createModelGatewayFromConfig(config) instanceof AnthropicAdapter);
  assert.ok(createModelGatewayFromConfig(readModelProviderConfig({ OPENAI_API_KEY: "openai-key" })) instanceof OpenAIAdapter);
  assert.equal(readModelProviderConfig({ MODEL_PROVIDER: "anthropic", OPENAI_API_KEY: "wrong-key" }), undefined);
});

test("native request has system blocks, merged roles and no OpenAI-only parameters", () => {
  const body = buildAnthropicRequest(request({ systemPrompt: "base\n__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__\nruntime", messages: [createTextMessage("system", "extra"), user(), createTextMessage("user", "more")], previousResponseId: "resp_old", providerOptions: { responses: { store: true } } }), { model });
  assert.deepEqual(body.system, [{ type: "text", text: "base" }, { type: "text", text: "runtime" }, { type: "text", text: "extra" }]);
  assert.equal((body.messages as any[]).length, 1);
  for (const key of ["previous_response_id", "store", "reasoning", "prompt_cache_key", "instructions", "input"]) assert.equal(key in body, false);
  assert.equal(body.max_tokens, 8192);
});

test("parallel tool results precede runtime text and preserve error status", () => {
  const uses = ["a", "b"].map(id => ({ id, name: "echo", input: { text: id } }));
  const assistant: Message = { ...createTextMessage("assistant", "checking"), blocks: [{ type: "text", text: "checking" }, ...uses.map(u => ({ type: "tool_use" as const, ...u }))] };
  const body = buildAnthropicRequest(request({ tools: [tool], messages: [user(), assistant, createTextMessage("user", "runtime context"), createToolResultMessage(uses[0]!, true, "a"), createToolResultMessage(uses[1]!, false, { error: "failed" })] }), { model });
  const turns = body.messages as any[];
  assert.deepEqual(turns.map(t => t.role), ["user", "assistant", "user"]);
  assert.deepEqual(turns[2].content.map((b: any) => b.type), ["tool_result", "tool_result", "text"]);
  assert.equal(turns[2].content[1].is_error, true);
  assert.deepEqual((body.tools as any[])[0].input_schema, tool.inputSchema);
});

test("thinking settings are native, model-aware and validate invalid combinations", () => {
  assert.deepEqual(buildAnthropicRequest(request({ reasoning: { effort: "high" } }), { model }).thinking, { type: "adaptive" });
  assert.deepEqual(buildAnthropicRequest(request({ reasoning: { effort: "high" } }), { model: "claude-haiku-4-5" }).thinking, { type: "enabled", budget_tokens: 4096 });
  assert.deepEqual(buildAnthropicRequest(request({ reasoning: null }), { model }).thinking, { type: "disabled" });
  assert.throws(() => buildAnthropicRequest(request({ reasoning: { effort: "high" }, maxOutputTokens: 1024 }), { model: "claude-haiku-4-5" }), /budget/);
  assert.throws(() => buildAnthropicRequest(request({ reasoning: null }), { model: "claude-opus-5-5" }), /cannot be disabled/);
  assert.throws(() => buildAnthropicRequest(request({ tools: [tool], toolChoice: "required", reasoning: { effort: "high" } }), { model }), /auto or none/);
  assert.throws(() => buildAnthropicRequest(request({ reasoning: { effort: "minimal" } }), { model }), /minimal/);
  assert.throws(() => buildAnthropicRequest(request({ reasoning: { summary: "auto" } }), { model }), /reasoning.summary/);
});

test("known Claude model limits reject unsupported effort and excessive output locally", () => {
  assert.throws(() => buildAnthropicRequest(request({ reasoning: { effort: "xhigh" } }), { model }), /does not support effort/);
  assert.throws(() => buildAnthropicRequest(request({ maxOutputTokens: 1000000 }), { model }), /max_tokens exceeds/);
  assert.deepEqual(buildAnthropicRequest(request({ reasoning: { effort: "high" }, maxOutputTokens: 2500 }), { model: "claude-haiku-4-5" }).thinking, { type: "enabled", budget_tokens: 2499 });
  assert.throws(() => buildAnthropicRequest(request({ reasoning: { effort: "high" }, maxOutputTokens: 2500 }), { model: "claude-haiku-4-5", thinkingBudgetTokens: 4096 }), /budget/);
});

test("non-streaming malformed or incomplete messages never publish executable calls", () => {
  const body = completion([{ type: "tool_use", id: "call_a", name: "echo", input: {} }], "tool_use");
  for (const invalid of [{ ...body, stop_reason: null }, { ...body, content: [null] }]) {
    const events: ModelStreamEvent[] = [];
    assert.throws(() => { for (const event of normalizeAnthropicObject(invalid, model)) events.push(event); }, /Incomplete|Invalid/);
    assert.equal(events.some(event => event.type === "assistant_message" || event.type === "tool_use"), false);
  }
});

test("schema output and tool choice mappings do not copy OpenAI wrapper fields", () => {
  const schema = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false };
  const body = buildAnthropicRequest(request({ tools: [tool], toolChoice: { type: "function", name: "echo" }, textFormat: { type: "json_schema", schema, name: "response", strict: true } }), { model });
  assert.deepEqual(body.tool_choice, { type: "tool", name: "echo" });
  assert.deepEqual(body.output_config, { format: { type: "json_schema", schema } });
  assert.throws(() => buildAnthropicRequest(request({ textFormat: { type: "json_object" } }), { model }), /json_schema/);
});

test("SSE handles split UTF-8, thinking signature, opaque block, tools and cumulative usage", async () => {
  const content = [{ type: "thinking", thinking: "plan", signature: "signed-value" }, { type: "redacted_thinking", data: "opaque-value" }, { type: "text", text: "你好" }, { type: "tool_use", id: "call_a", name: "echo", input: { text: "测试" } }];
  const events = await collect(normalizeAnthropicStream(stream(frames(content, "tool_use"), 1), model));
  assert.equal(events.filter(e => e.type === "tool_call_started").length, 1);
  assert.equal(events.filter(e => e.type === "tool_use").length, 0); // no duplicate execution
  const msg = events.find(e => e.type === "assistant_message"); assert.ok(msg?.type === "assistant_message");
  const restored = withoutThinkingBlocks(JSON.parse(JSON.stringify([msg.message])));
  const result = createToolResultMessage({ id: "call_a", name: "echo", input: {} }, true, "ok");
  const next = buildAnthropicRequest(request({ tools: [tool], messages: [user(), ...restored, result] }), { model });
  assert.deepEqual((next.messages as any[])[1].content, content);
  const usage = events.find(e => e.type === "response_completed"); assert.ok(usage?.type === "response_completed");
  assert.equal(usage.usage?.inputTokens, 60); assert.equal(usage.usage?.outputTokens, 5);
  assert.equal(usage.usage?.totalTokens, 65); assert.equal(usage.responseId, undefined);
  const other = buildAnthropicRequest(request({ messages: [user(), ...restored, result] }), { model: "claude-opus-4-6" });
  assert.equal((other.messages as any[])[1].content.some((b: any) => b.type === "thinking"), false);
});

test("truncation and malformed tool JSON never publish executable calls", async () => {
  const content = [{ type: "tool_use", id: "call_a", name: "echo", input: { text: "test" } }];
  const received: ModelStreamEvent[] = [];
  await assert.rejects(async () => { for await (const event of normalizeAnthropicStream(stream(frames(content, "tool_use").slice(0, -1)), model)) received.push(event); }, /before message_stop/);
  assert.equal(received.some(e => e.type === "assistant_message" || e.type === "tool_use"), false);
  const broken = frames(content, "tool_use");
  for (const event of broken) if (event.type === "content_block_delta") (event.delta as any).partial_json = "{";
  await assert.rejects(collect(normalizeAnthropicStream(stream(broken), model)), /malformed tool JSON/);
});

for (const suffix of ["", "/v1", "/v1/", "/v1/messages"]) {
  test(`real HTTP to local CPA-contract endpoint normalizes base URL ${suffix || '(origin)'}`, async () => {
    let captured: any;
    const local = await server((req, res, body) => { captured = { url: req.url, headers: req.headers, body }; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(completion())); });
    try {
      const adapter = new AnthropicAdapter({ model, baseUrl: local.url + suffix, apiKey: "gateway-key", maxRetries: 0 });
      const events = await collect(adapter.stream(request({ stream: false })));
      assert.equal(captured.url, "/v1/messages"); assert.equal(captured.headers["x-api-key"], "gateway-key");
      assert.equal(captured.headers["anthropic-version"], "2023-06-01"); assert.equal(captured.headers.authorization, undefined);
      assert.equal(captured.body.stream, false); assert.equal(events.filter(e => e.type === "assistant_message").length, 1);
    } finally { await local.close(); }
  });
}

test("HTTP retry before output, no retries for auth or context overflow", async () => {
  let calls = 0;
  const local = await server((_req, res) => {
    if (++calls === 1) { res.writeHead(429, { "retry-after": "0" }); res.end(JSON.stringify({ error: { type: "rate_limit_error", message: "slow down" } })); }
    else { res.setHeader("Content-Type", "text/event-stream"); res.end(encode(frames())); }
  });
  try {
    const events = await collect(new AnthropicAdapter({ model, baseUrl: local.url, apiKey: "key", maxRetries: 1 }).stream(request()));
    assert.equal(calls, 2); assert.equal(events.filter(e => e.type === "retrying").length, 1);
  } finally { await local.close(); }
  for (const [status, type, message, category] of [[401, "authentication_error", "bad key", "auth_unavailable"], [400, "invalid_request_error", "prompt is too long", "context_length"]] as const) {
    let count = 0;
    const endpoint = await server((_req, res) => { count++; res.writeHead(status); res.end(JSON.stringify({ error: { type, message } })); });
    try { await assert.rejects(collect(new AnthropicAdapter({ model, baseUrl: endpoint.url, apiKey: "key" }).stream(request())), (e: unknown) => e instanceof ModelAPIError && e.category === category); assert.equal(count, 1); }
    finally { await endpoint.close(); }
  }
});

test("stream errors after visible output are not retried", async () => {
  let calls = 0;
  const local = await server((_req, res) => { calls++; res.setHeader("Content-Type", "text/event-stream"); res.end(encode([...frames().slice(0, 4), { type: "error", error: { type: "overloaded_error", message: "busy" } }])); });
  try { await assert.rejects(collect(new AnthropicAdapter({ model, baseUrl: local.url, apiKey: "key" }).stream(request())), /busy/); assert.equal(calls, 1); }
  finally { await local.close(); }
});

test("cancellation remains connected after SSE headers and does not retry", async () => {
  let calls = 0;
  const controller = new AbortController();
  const local = await server((_req, res) => { calls++; res.writeHead(200, { "Content-Type": "text/event-stream" }); res.write(encode(frames().slice(0, 1))); setTimeout(() => controller.abort(), 30); });
  try { await assert.rejects(collect(new AnthropicAdapter({ model, baseUrl: local.url, apiKey: "key" }).stream(request({ cancellation: controller.signal }))), (e: unknown) => e instanceof ModelAPIError && e.category === "user_abort"); assert.equal(calls, 1); }
  finally { await local.close(); }
});

test("native adapter completes neo tool loop and signed history survives session resume", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "neo-anthropic-"));
  let calls = 0, executed = 0;
  const seen: any[] = [];
  const content = [{ type: "thinking", thinking: "use tool", signature: "sig" }, { type: "tool_use", id: "call_echo", name: "echo", input: { text: "local" } }];
  const local = await server((_req, res, body) => { seen.push(body); res.setHeader("Content-Type", "text/event-stream"); res.end(encode(++calls === 1 ? frames(content, "tool_use") : frames())); });
  try {
    const tools = new ToolRegistry(); tools.register({ ...tool, metadata: { readOnly: true, concurrent: true, visible: true }, async call(input: { text: string }) { executed++; return { ok: true, output: input.text }; } });
    const adapter = new AnthropicAdapter({ model, baseUrl: local.url, apiKey: "key", maxRetries: 0 });
    const options = {
      agentId: "claude-test", agent: { agentType: "test", whenToUse: "test", tools: ["echo"] }, prompt: "use echo", model, workspaceCwd: root, maxTurns: 3,
      parentContext: { session: { sessionId: "parent", sessionDir: root } } as ToolUseContext,
      dependencies: { modelGateway: adapter, tools, contextManager: { async build() { return { systemPrompt: "test", promptSections: [], userContext: { currentDate: "2026-01-01" }, systemContext: { cwd: root, platform: process.platform } }; } }, compactor: { async compact(messages: readonly Message[]) { return { messages: [...messages], changed: false }; } } },
    };
    const events = await collect(runAgent(options));
    const errors = events.filter(e => e.type === "error"); assert.deepEqual(errors, []);
    assert.equal(executed, 1); assert.equal(calls, 2);
    const assistant = seen[1].messages.find((t: any) => t.role === "assistant");
    assert.deepEqual(assistant.content, content);
    assert.equal(seen[1].messages.find((t: any) => t.content.some((b: any) => b.type === "tool_result")).content[0].tool_use_id, "call_echo");
    const resumed = await collect(runAgent({ ...options, resumeDirective: "continue" }));
    assert.deepEqual(resumed.filter(e => e.type === "error"), []);
    assert.deepEqual(seen[2].messages.find((t: any) => t.role === "assistant").content, content);
    assert.equal(executed, 1);
  } finally { await local.close(); await fs.rm(root, { recursive: true, force: true }); }
});


test("image input maps to native base64 source, without adding image generation", () => {
  const gif = "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";
  const message: Message = { ...user(), blocks: [{ type: "image", mimeType: "image/gif", data: gif }] };
  const body = buildAnthropicRequest(request({ messages: [message] }), { model });
  assert.deepEqual((body.messages as any[])[0].content, [{ type: "image", source: { type: "base64", media_type: "image/gif", data: gif } }]);
  assert.equal(body.tools, undefined);
  assert.equal(new AnthropicAdapter({ model }).capabilities.builtInTools, false);
});

test("max_tokens stop reason is incomplete, not successful completion", async () => {
  const streamed = await collect(normalizeAnthropicStream(stream(frames([{ type: "text", text: "partial" }], "max_tokens")), model));
  const plain = [...normalizeAnthropicObject(completion([{ type: "text", text: "partial" }], "max_tokens"), model)];
  for (const events of [streamed, plain]) {
    assert.equal(events.some(e => e.type === "response_completed"), false);
    assert.ok(events.some(e => e.type === "response_incomplete" && e.reason === "max_tokens"));
  }
});

test("model-driven compaction uses Messages API with a legal smaller thinking budget", async () => {
  let seen: any;
  const local = await server((_req, res, body) => { seen = body; res.setHeader("Content-Type", "text/event-stream"); res.end(encode(frames([{ type: "text", text: "Summary: keep working on the task." }]))); });
  try {
    const adapter = new AnthropicAdapter({ model: "claude-haiku-4-5", baseUrl: local.url, apiKey: "key", maxRetries: 0, defaultReasoning: { effort: "high" } });
    const compacted = await new ModelDrivenCompactor(adapter).manualCompact([user(), createTextMessage("assistant", "some work"), createTextMessage("user", "continue")]);
    assert.ok(seen, "compaction must really reach the adapter, not silently fall back");
    assert.equal(seen.max_tokens, 2500);
    assert.equal(seen.thinking.type, "enabled");
    assert.ok(seen.thinking.budget_tokens < seen.max_tokens);
    assert.equal(compacted.changed, true);
    assert.ok(compacted.messages.some(message => message.metadata?.modelDriven === true));
  } finally { await local.close(); }
});

test("Web login saves native provider settings while retaining OpenAI configuration", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "neo-anthropic-login-"));
  const saved = { ...process.env };
  try {
    delete process.env.NEO_DOCKER;
    const envPath = path.join(root, ".env");
    await fs.writeFile(envPath, "MODEL_PROVIDER=openai\nOPENAI_API_KEY=existing-openai-key\nOPENAI_MODEL=gpt-5.6\nMODEL_REASONING_SUMMARY=auto\nANTHROPIC_API_VERSION=2023-06-01\nANTHROPIC_THINKING_BUDGET_TOKENS=2048\n");
    const repl = Object.create(WebRepl.prototype) as WebRepl;
    (repl as any).runtime = { envPath };
    let reloaded = false;
    repl.reloadModelConfig = async () => { reloaded = true; };
    const form = repl.loginForm("anthropic");
    assert.equal(form.provider, "anthropic");
    assert.ok(form.providers.includes("anthropic"));
    assert.ok(form.fields.some((f: any) => f.envKey === "ANTHROPIC_API_KEY"));
    assert.equal(form.fields.some((f: any) => f.key === "reasoningSummary" || f.key === "endpoint"), false);
    const result = await repl.saveLogin("anthropic", { apiKey: "gateway-key", baseUrl: "http://localhost:8317", model });
    assert.equal(result.ok, true); assert.equal(reloaded, true);
    const file = await fs.readFile(envPath, "utf8");
    assert.match(file, /MODEL_PROVIDER=anthropic/); assert.match(file, /ANTHROPIC_API_KEY=gateway-key/);
    assert.match(file, /OPENAI_API_KEY=existing-openai-key/);
    assert.match(file, /MODEL_REASONING_SUMMARY=auto/);
    assert.match(file, /ANTHROPIC_API_VERSION=2023-06-01/);
    assert.match(file, /ANTHROPIC_THINKING_BUDGET_TOKENS=2048/);
    assert.equal(readModelProviderConfig(process.env)?.provider, "anthropic");
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    await fs.rm(root, { recursive: true, force: true });
  }
});
