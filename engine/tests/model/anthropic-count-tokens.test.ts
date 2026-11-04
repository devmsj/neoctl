import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { AnthropicAdapter } from "../../src/model/anthropic-adapter.js";
import { buildAnthropicRequest } from "../../src/model/anthropic-mapper.js";
import { estimateTextTokens, buildContextMetrics } from "../../src/core/context-metrics.js";
import { ContextTokenCalibration } from "../../src/core/context-token-calibration.js";
import { LoggingModelGateway, CommunicationLogger } from "../../src/model/communication-logger.js";
import { createTextMessage } from "../../src/types/messages.js";
import type { ModelGateway, ModelRequest } from "../../src/model/model-gateway.js";
import { query } from "../../src/core/query.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { autoCompactIfNeeded } from "../../src/context/compaction.js";

const request: ModelRequest = { model: "claude-haiku-5-5", messages: [createTextMessage("user", "hello world")], tools: [], stream: true, reasoning: null };
async function serve(handler: (url: string, body: any, headers: any) => { status?: number; body?: unknown } | Promise<{ status?: number; body?: unknown }>) {
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const result = await handler(req.url!, JSON.parse(raw), req.headers);
    res.writeHead(result.status ?? 200, { "content-type": "application/json" }); res.end(JSON.stringify(result.body));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
const localMetrics = () => buildContextMetrics({ model: request.model, messages: request.messages, systemPrompt: "", tools: [], contextWindowTokensOverride: 1000 });

test("Anthropic compromise is fixed across model identities and merges turns", () => {
  const adapter = new AnthropicAdapter({ model: request.model! });
  assert.equal(adapter.estimateInputTokens(request), Math.ceil(1.2 * estimateTextTokens("hello world") + 3 + 8));
  assert.equal(adapter.estimateInputTokens({ ...request, model: "deepseek-flash" }), adapter.estimateInputTokens(request));
  assert.equal(adapter.estimateInputTokens({ ...request, messages: [createTextMessage("user", "hello"), createTextMessage("user", "world")] }), Math.ceil(1.2 * estimateTextTokens("hello\nworld") + 3 + 8));
});

test("count_tokens uses mapped content, thinking, tool choice and schema; strips generation fields", async () => {
  let calls = 0;
  const r = { ...request, systemPrompt: "system", reasoning: { effort: "high" }, fastMode: true, tools: [{ name: "echo", description: "echo", inputSchema: { type: "object", properties: {} } }] };
  const mapped = buildAnthropicRequest(r, { model: request.model! });
  const server = await serve((url, body, headers) => {
    calls++; assert.equal(url, "/anthropic/v1/messages/count_tokens"); assert.equal(headers["x-api-key"], "test");
    assert.deepEqual(body, Object.fromEntries(["model", "messages", "system", "tools", "tool_choice", "thinking", "output_config"].filter(k => mapped[k] !== undefined).map(k => [k, mapped[k]])));
    for (const key of ["stream", "max_tokens", "speed", "metadata", "service_tier"]) assert.equal(key in body, false);
    return { body: { input_tokens: 357 } };
  });
  try {
    const adapter = new AnthropicAdapter({ model: request.model!, baseUrl: server.url + "/anthropic/v1", apiKey: "test" });
    assert.equal(await adapter.countInputTokens(r), 357); assert.equal(calls, 1);
  } finally { await server.close(); }
});

test("unsupported count endpoint is silent, memoized, and generation still works", async () => {
  let counts = 0;
  const server = await serve(url => url.endsWith("count_tokens") ? (counts++, { status: 404, body: {} }) : { body: { type: "message", id: "msg", role: "assistant", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 1 } } });
  try {
    const adapter = new AnthropicAdapter({ model: request.model!, baseUrl: server.url, apiKey: "test", maxRetries: 0 });
    assert.equal(await adapter.countInputTokens(request), undefined); assert.equal(await adapter.countInputTokens(request), undefined); assert.equal(counts, 1);
    const events = []; for await (const event of adapter.stream({ ...request, stream: false })) events.push(event);
    assert.ok(events.some(e => e.type === "response_completed"));
  } finally { await server.close(); }
});

test("HTTP failures and invalid count values quietly keep the compromise", async () => {
  for (const result of [{ status: 429, body: {} }, { status: 500, body: {} }, { body: { input_tokens: -1 } }, { body: { input_tokens: "100" } }, { body: {} }]) {
    const server = await serve(() => result);
    try {
      const adapter = new AnthropicAdapter({ model: request.model!, baseUrl: server.url, apiKey: "test" });
      const metrics = await new ContextTokenCalibration().correct(localMetrics(), adapter, request);
      assert.equal(metrics.estimatedInputTokens, adapter.estimateInputTokens(request));
    } finally { await server.close(); }
  }
});

test("count timeout and cancellation are bounded and quiet", async () => {
  const server = await serve(async () => { await new Promise(resolve => setTimeout(resolve, 1700)); return { body: { input_tokens: 99 } }; });
  try {
    const adapter = new AnthropicAdapter({ model: request.model!, baseUrl: server.url, apiKey: "test" });
    const start = Date.now(); assert.equal(await adapter.countInputTokens(request), undefined); assert.ok(Date.now() - start < 1650);
    const controller = new AbortController(); controller.abort();
    assert.equal(await adapter.countInputTokens({ ...request, cancellation: controller.signal }), undefined);
  } finally { await server.close(); }
});

test("remote correction replaces local value; reset/model/gateway changes cannot reuse it", async () => {
  const gateway: ModelGateway = { async *stream() {}, estimateInputTokens: () => 120, countInputTokens: async () => 950 };
  const counter = new ContextTokenCalibration(), metrics = localMetrics();
  const corrected = await counter.correct(metrics, gateway, request);
  assert.equal(corrected.estimatedInputTokens, 950); assert.equal(corrected.contextUsageRatio, 0.95);
  assert.equal(counter.apply(metrics, gateway, request).estimatedInputTokens, 950);
  assert.equal(counter.apply({ ...metrics, model: "other" }, gateway, request).estimatedInputTokens, 120);
  assert.equal(counter.apply(metrics, { ...gateway }, request).estimatedInputTokens, 120);
  counter.reset(); assert.equal(counter.apply(metrics, gateway, request).estimatedInputTokens, 120);
  gateway.countInputTokens = async () => { throw Error("unsupported"); };
  assert.equal((await counter.correct(metrics, gateway, request)).estimatedInputTokens, 120);
});

test("OpenAI gateways without count/estimate retain the original metrics", async () => {
  const gateway: ModelGateway = { async *stream() {} }, metrics = localMetrics();
  assert.equal(await new ContextTokenCalibration().correct(metrics, gateway, request), metrics);
});

test("logging gateway forwards optional counting without creating conversation logs", async () => {
  const logger = new CommunicationLogger();
  const gateway = new LoggingModelGateway({ async *stream() {}, estimateInputTokens: () => 42, countInputTokens: async () => 99 }, logger);
  assert.equal(gateway.estimateInputTokens(request), 42); assert.equal(await gateway.countInputTokens(request), 99); assert.equal(logger.snapshot().calls, 0);
});

test("query gives corrected input to the existing proportional compaction decision", async () => {
  let budgetTokens: number | undefined;
  const gateway: ModelGateway = { estimateInputTokens: () => 120, countInputTokens: async () => 950, async *stream() { yield { type: "assistant_delta", text: "ok" }; yield { type: "response_completed" }; } };
  const events = [];
  for await (const event of query([...request.messages], { modelGateway: gateway, tools: new ToolRegistry(), compactor: { async compact(messages, options) { budgetTokens = options?.estimatedInputTokens; return { messages: [...messages], changed: false, reason: "none" }; } } }, { agentId: "main", model: request.model, contextWindowTokensOverride: 1000, maxTurns: 1 })) events.push(event);
  assert.equal(budgetTokens, 950);
  assert.ok(events.some(e => e.type === "context.metrics" && e.metrics.contextUsageRatio === 0.95));
  assert.ok(!events.some(e => e.type === "error"));
});

test("corrected count triggers the existing 92 percent threshold, below threshold does not", async () => {
  const messages = Array.from({ length: 20 }, (_, i) => createTextMessage(i % 2 ? "assistant" : "user", "conversation detail ".repeat(30)));
  const gateway: ModelGateway = { async *stream() {}, estimateInputTokens: () => 120, countInputTokens: async () => 950 };
  const metrics = await new ContextTokenCalibration().correct(localMetrics(), gateway, request);
  assert.equal(autoCompactIfNeeded(messages, { estimatedInputTokens: metrics.estimatedInputTokens, contextWindowTokens: 1000 }).changed, true);
  assert.equal(autoCompactIfNeeded(messages, { estimatedInputTokens: 919, contextWindowTokens: 1000 }).changed, false);
});
