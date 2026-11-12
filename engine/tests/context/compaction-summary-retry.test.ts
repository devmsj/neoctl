import { streamWithRetry } from "../../src/model/retry-runner.js";
import assert from "node:assert/strict";
import test from "node:test";
import { ModelDrivenCompactor, withCompactionReport } from "../../src/context/compaction.js";
import { hasValidToolResultPairing } from "../../src/core/message-pipeline.js";
import { buildAnthropicRequest } from "../../src/model/anthropic-mapper.js";
import { ModelAPIError } from "../../src/model/errors.js";
import type { ModelGateway, ModelRequest, ModelStreamEvent } from "../../src/model/model-gateway.js";
import { createTextMessage, createToolResultMessage, type Message } from "../../src/types/messages.js";

const overflow = () => new ModelAPIError({ provider: "anthropic", category: "context_length", message: "prompt is too long: 300000 tokens > 256000 maximum", retryable: false });

function toolTurn(index: number): Message[] {
  const call = { id: `call_${index}`, name: "file_read", input: { path: `file-${index}.ts` } };
  return [
    { id: `a_${index}`, role: "assistant", createdAt: new Date().toISOString(), blocks: [{ type: "tool_use", ...call }] },
    createToolResultMessage(call, true, `content ${index} `.repeat(400)),
  ];
}

function windowAfterCheckpoint(): Message[] {
  const preserved = { ...createTextMessage("user", "PRESERVED earlier request"), metadata: { compactPreservedUser: true } };
  const boundary = { ...createTextMessage("system", "<compact_state>PREVIOUS STATE</compact_state>"), isMeta: true, metadata: { compactBoundary: true, compactionReason: "autocompact", modelDriven: true } };
  const request = createTextMessage("user", "FIRST REQUEST after checkpoint");
  return [preserved, boundary, request, ...Array.from({ length: 12 }, (_, index) => toolTurn(index)).flat(), createTextMessage("assistant", "LATEST progress")];
}

function scriptedGateway(script: Array<(request: ModelRequest) => ModelStreamEvent[] | Error>): { gateway: ModelGateway; requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  const gateway: ModelGateway = { async *stream(request) {
    requests.push(request);
    const step = script[Math.min(requests.length, script.length) - 1]!(request);
    if (step instanceof Error) throw step;
    yield* step;
  } };
  return { gateway, requests };
}

const ok = (): ModelStreamEvent[] => [
  { type: "assistant_delta", text: "Summary" },
  { type: "assistant_message", message: createTextMessage("assistant", "Summary") },
  { type: "response_completed", responseId: "summary" },
];

function boundaryOf(messages: readonly Message[]): Message {
  return messages.find(message => message.metadata?.compactBoundary === true)!;
}

test("summary requests keep the normal output limit unless explicitly capped", async () => {
  const { gateway, requests } = scriptedGateway([ok]);
  await new ModelDrivenCompactor(gateway).manualCompact(windowAfterCheckpoint());
  assert.equal(requests[0]!.maxOutputTokens, undefined);
  await new ModelDrivenCompactor(gateway).manualCompact(windowAfterCheckpoint(), { compactMaxOutputTokens: 4096 });
  assert.equal(requests[1]!.maxOutputTokens, 4096);
});

test("context overflow retries with the oldest input omitted and a valid Claude request", async () => {
  const { gateway, requests } = scriptedGateway([() => overflow(), ok]);
  const result = withCompactionReport(await new ModelDrivenCompactor(gateway).manualCompact(windowAfterCheckpoint()), 30);
  assert.equal(requests.length, 2);
  assert.equal(boundaryOf(result.messages).metadata?.modelDriven, true);
  assert.equal(result.report?.fallbackReason, undefined);

  const [full, trimmed] = requests.map(request => request.messages);
  assert.ok(trimmed!.length < full!.length);
  const text = JSON.stringify(trimmed);
  for (const kept of ["PRESERVED earlier request", "PREVIOUS STATE", "FIRST REQUEST after checkpoint", "LATEST progress", "earlier message(s) were omitted"]) assert.match(text, new RegExp(kept.replace(/[()]/g, "\\$&")));
  assert.doesNotMatch(text, /file-0\.ts/);
  assert.ok(hasValidToolResultPairing(trimmed!));
  assert.equal(trimmed!.at(-2)?.metadata?.compactInstruction, true);
  assert.doesNotThrow(() => buildAnthropicRequest(requests[1]!, { model: "claude-haiku-5-5", defaultReasoning: { effort: "high" } }));
});

test("without a checkpoint the leading system context and first request are kept", async () => {
  const window = windowAfterCheckpoint().slice(2);
  const leading = { ...createTextMessage("system", "LEADING context"), isMeta: true };
  const { gateway, requests } = scriptedGateway([() => overflow(), ok]);
  await new ModelDrivenCompactor(gateway).manualCompact([leading, ...window]);
  const trimmed = requests[1]!.messages;
  assert.equal(trimmed[0]!.blocks[0]!.type === "text" && trimmed[0]!.blocks[0]!.text, "LEADING context");
  assert.match(JSON.stringify(trimmed), /FIRST REQUEST after checkpoint/);
  assert.doesNotMatch(JSON.stringify(trimmed), /file-0\.ts/);
  assert.doesNotThrow(() => buildAnthropicRequest(requests[1]!, { model: "claude-haiku-5-5", defaultReasoning: { effort: "high" } }));
});

test("a fixed head larger than the budget is not trimmed down to nothing", async () => {
  const huge = createTextMessage("user", "HUGE first request ".repeat(40000));
  const { gateway, requests } = scriptedGateway([() => overflow()]);
  const result = withCompactionReport(await new ModelDrivenCompactor(gateway).manualCompact([huge, ...toolTurn(1), createTextMessage("assistant", "LATEST")]), 30);
  assert.equal(requests.length, 1);
  assert.equal(result.report?.modelDriven, false);
});

test("model_context_window_exceeded without summary text is retried as an overflow", async () => {
  const { gateway, requests } = scriptedGateway([() => [{ type: "response_incomplete", reason: "model_context_window_exceeded" }], ok]);
  const result = await new ModelDrivenCompactor(gateway).manualCompact(windowAfterCheckpoint());
  assert.equal(requests.length, 2);
  assert.equal(boundaryOf(result.messages).metadata?.modelDriven, true);
});

test("non-overflow failures and repeated overflow fall back with a recorded reason", async () => {
  const auth = scriptedGateway([() => new ModelAPIError({ provider: "anthropic", category: "auth_unavailable", message: "invalid x-api-key", retryable: false })]);
  const authResult = withCompactionReport(await new ModelDrivenCompactor(auth.gateway).manualCompact(windowAfterCheckpoint()), 30);
  assert.equal(auth.requests.length, 1);
  assert.equal(authResult.report?.modelDriven, false);
  assert.match(authResult.report?.fallbackReason ?? "", /invalid x-api-key/);

  const always = scriptedGateway([() => overflow()]);
  const overflowResult = withCompactionReport(await new ModelDrivenCompactor(always.gateway).manualCompact(windowAfterCheckpoint()), 30);
  assert.equal(always.requests.length, 3);
  assert.ok(always.requests[2]!.messages.length < always.requests[1]!.messages.length);
  assert.match(overflowResult.report?.fallbackReason ?? "", /prompt is too long/);
});

test("an overflow after summary text was streamed is not retried", async () => {
  const { gateway, requests } = scriptedGateway([() => [{ type: "assistant_delta", text: "partial" }, { type: "response_incomplete", reason: "model_context_window_exceeded" }]]);
  const deltas: string[] = [];
  const result = withCompactionReport(await new ModelDrivenCompactor(gateway).manualCompact(windowAfterCheckpoint(), { onCompactionDelta: text => deltas.push(text) }), 30);
  assert.equal(requests.length, 1);
  assert.deepEqual(deltas, ["partial"]);
  assert.match(result.report?.fallbackReason ?? "", /model_context_window_exceeded/);
});

test("cancelling a summary still aborts instead of committing a fallback", async () => {
  const controller = new AbortController();
  const { gateway } = scriptedGateway([() => { controller.abort(); return overflow(); }]);
  await assert.rejects(new ModelDrivenCompactor(gateway).manualCompact(windowAfterCheckpoint(), { abortSignal: controller.signal }));
});


test("summary retry discards failed attempt text and retains only the successful checkpoint", async () => {
  let attempts = 0;
  const gateway: ModelGateway = { stream() { return streamWithRetry(async function* () {
    attempts++;
    yield { type: "assistant_delta", text: attempts === 1 ? "BAD_CHECKPOINT" : "GOOD_CHECKPOINT" };
    if (attempts === 1) throw new Error("reset");
    yield { type: "response_completed" };
  }, { provider: "test", maxRetries: 1, delayMs: 0 }); } };
  const result = await new ModelDrivenCompactor(gateway).manualCompact(windowAfterCheckpoint());
  assert.equal(attempts, 2); assert.equal(result.summary, "GOOD_CHECKPOINT");
  assert(!JSON.stringify(result.messages).includes("BAD_CHECKPOINT"));
});
