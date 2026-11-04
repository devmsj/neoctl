import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { ModelAPIError } from "../../src/model/errors.js";
import { isFastModeUnavailable, streamWithFastModeFallback, anthropicFastModeBeta } from "../../src/model/fast-mode.js";
import { AnthropicAdapter } from "../../src/model/anthropic-adapter.js";
import { OpenAIAdapter } from "../../src/model/openai-adapter.js";
import type { ModelGateway, ModelRequest, ModelStreamEvent } from "../../src/model/model-gateway.js";
import { createTextMessage } from "../../src/types/messages.js";

const request = (patch: Partial<ModelRequest> = {}): ModelRequest => ({ messages: [createTextMessage("user", "hello")], tools: [], stream: false, fastMode: true, ...patch });
const failure = (provider = "anthropic", message = "Usage credits are required for fast mode.", status = 429) => new ModelAPIError({ provider, message, status, category: "rate_limit" });
async function collect<T>(source: AsyncIterable<T>) { const events: T[] = []; for await (const event of source) events.push(event); return events; }

test("only explicit speed/tier errors permit downgrade", () => {
  for (const error of [failure(), failure("anthropic", "This model does not support the speed parameter", 400), failure("openai", "service_tier priority is not supported", 400), failure("openai", "priority quota exhausted", 429)]) assert.equal(isFastModeUnavailable(error), true);
  for (const error of [failure("anthropic", "Rate limit exceeded"), failure("openai", "Insufficient account credits"), failure("openai", "Invalid API key", 401), failure("anthropic", "Unknown tool name", 400), failure("anthropic", "fast mode timed out", 408), new Error("fast mode unavailable")]) assert.equal(isFastModeUnavailable(error), false);
  assert.equal(anthropicFastModeBeta("claude-opus-5-5"), undefined);
  assert.equal(anthropicFastModeBeta("claude-opus-5"), "fast-mode-2026-02-01");
  assert.equal(anthropicFastModeBeta("claude-opus-4-8-20260801"), "fast-mode-2026-02-01");
  assert.equal(anthropicFastModeBeta("claude-haiku-5-5"), undefined);
});

for (const provider of ["anthropic", "openai"] as const) {
  for (const fastSuccess of [true, false]) test(`${provider}: wire protocol and ${fastSuccess ? "fast success" : "single standard retry"}`, async () => {
    const calls: Array<{ body: any; beta?: string | string[] }> = [];
    const server = createServer(async (req, res) => {
      let raw = ""; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw); calls.push({ body, beta: req.headers["anthropic-beta"] });
      res.setHeader("content-type", "application/json");
      if (!fastSuccess && calls.length === 1) {
        res.statusCode = provider === "anthropic" ? 429 : 400;
        res.end(JSON.stringify({ error: { type: "invalid_request_error", message: provider === "anthropic" ? "Usage credits are required for fast mode." : "service_tier priority is not supported" } })); return;
      }
      res.end(JSON.stringify(provider === "anthropic"
        ? { type: "message", id: "msg", role: "assistant", model: "claude-opus-5", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }
        : { id: "resp", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }] }));
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    try {
      const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const gateway = provider === "anthropic" ? new AnthropicAdapter({ apiKey: "test", baseUrl, model: "claude-opus-5" }) : new OpenAIAdapter({ apiKey: "test", baseUrl, model: "gpt-test", endpoint: "responses" });
      const events = await collect(streamWithFastModeFallback(gateway, request()));
      assert.equal(calls.length, fastSuccess ? 1 : 2);
      assert.equal(events.filter(e => e.type === "fast_mode_fallback").length, fastSuccess ? 0 : 1);
      assert(events.some(e => e.type === "assistant_message"));
      if (provider === "anthropic") {
        assert.equal(calls[0].body.speed, "fast"); assert.equal(calls[0].body.service_tier, undefined);
        assert.equal(calls[0].beta, "fast-mode-2026-02-01");
        if (!fastSuccess) { assert.equal(calls[1].body.speed, undefined); assert.equal(calls[1].beta, undefined); }
      } else { assert.equal(calls[0].body.service_tier, "priority"); if (!fastSuccess) assert.equal(calls[1].body.service_tier, undefined); }
      if (!fastSuccess) {
        const stripped = calls.map(({ body }) => { const { speed, service_tier, ...rest } = body; return rest; });
        assert.deepEqual(stripped[0], stripped[1]);
      }
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
}

test("never replay after output, tool previews, usage or response start", async () => {
  const emitted: ModelStreamEvent[] = [{ type: "assistant_delta", text: "started" }, { type: "thinking_delta", text: "thought" }, { type: "tool_call_started", callId: "a", name: "write" }, { type: "tool_call_delta", callId: "a", argumentsDelta: "{" }, { type: "usage", usage: { inputTokens: 1 } }, { type: "response_started", responseId: "r" }];
  for (const event of emitted) {
    let calls = 0;
    const gateway: ModelGateway = { async *stream() { calls++; yield event; throw failure(); } };
    await assert.rejects(collect(streamWithFastModeFallback(gateway, request())), /credits/);
    assert.equal(calls, 1);
  }
});

test("ordinary mode failure propagates; no loop and no downgrade without fast intent", async () => {
  for (const fastMode of [true, false]) {
    let calls = 0; const events: ModelStreamEvent[] = [];
    const gateway: ModelGateway = { async *stream() { calls++; throw failure(); } };
    await assert.rejects(async () => { for await (const event of streamWithFastModeFallback(gateway, request({ fastMode }))) events.push(event); }, /credits/);
    assert.equal(calls, fastMode ? 2 : 1);
    assert.equal(events.filter(e => e.type === "fast_mode_fallback").length, fastMode ? 1 : 0);
  }
});

test("cancellation before or during downgrade never sends ordinary retry", async () => {
  for (const cancelAtFallback of [true, false]) {
    const controller = new AbortController(); let calls = 0;
    const gateway: ModelGateway = { async *stream() { calls++; if (!cancelAtFallback) controller.abort(); throw failure(); } };
    await assert.rejects(async () => {
      for await (const event of streamWithFastModeFallback(gateway, request({ cancellation: controller.signal }))) if (event.type === "fast_mode_fallback") controller.abort();
    });
    assert.equal(calls, 1);
  }
});
