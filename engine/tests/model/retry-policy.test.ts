import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_MAX_RETRIES, retryDelayMs, waitForRetry } from "../../src/model/retry-policy.js";
import { streamWithRetry } from "../../src/model/retry-runner.js";
import { ModelAPIError } from "../../src/model/errors.js";
import type { ModelStreamEvent } from "../../src/model/model-gateway.js";
const transient = () => new ModelAPIError({ provider: "openai", category: "network", message: "connection reset" });

test("five retries use increasing 5/10/20/40/60 second waits, with absolute 60s cap", () => {
  assert.equal(DEFAULT_MAX_RETRIES, 5);
  assert.deepEqual([1,2,3,4,5,6,100].map(n => retryDelayMs(n)), [5000,10000,20000,40000,60000,60000,60000]);
  assert.equal(retryDelayMs(1, 12000), 12000);
  assert.equal(retryDelayMs(2, 1), 10000);
  assert.equal(retryDelayMs(1, 120000), 60000);
});
test("default performs initial request plus five retries; explicit zero is respected", async () => {
  for (const maxRetries of [undefined, 0, 2]) {
    let calls = 0; const events: ModelStreamEvent[] = [];
    await assert.rejects(async () => {
      for await (const event of streamWithRetry(async function* () { calls++; throw transient(); }, { provider: "openai", maxRetries, delayMs: 0 })) events.push(event);
    }, /connection reset/);
    assert.equal(calls, 1 + (maxRetries ?? 5));
    assert.equal(events.length, maxRetries ?? 5);
  }
});
test("backoff cancellation is immediate and never starts another request", async () => {
  const controller = new AbortController(); let calls = 0;
  const start = performance.now();
  await assert.rejects(async () => {
    for await (const event of streamWithRetry(async function* () { calls++; throw transient(); }, { provider: "openai", signal: controller.signal })) {
      assert.equal(event.type, "retrying"); controller.abort();
    }
  });
  assert.equal(calls, 1); assert(performance.now() - start < 500);
  const second = new AbortController(); const waiting = waitForRetry(60000, second.signal); second.abort(); await assert.rejects(waiting);
});
test("do not replay visible output or permanent errors", async () => {
  for (const published of [true, false]) {
    let calls = 0;
    await assert.rejects(async () => {
      for await (const _ of streamWithRetry(async function* () {
        calls++;
        if (published) yield { type: "assistant_delta", text: "partial" } as const;
        throw published ? transient() : new ModelAPIError({ provider: "openai", category: "invalid_request", message: "bad input" });
      }, { provider: "openai", delayMs: 0 })) {}
    });
    assert.equal(calls, 1);
  }
});
