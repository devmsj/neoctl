import assert from "node:assert/strict";
import test from "node:test";
import { QueryEngine } from "../../src/core/query-engine.js";
import { ModelDrivenCompactor } from "../../src/context/compaction.js";
import { withCompactionProgress } from "../../src/core/compaction-progress.js";
import { createTextMessage } from "../../src/types/messages.js";
import type { AgentEvent } from "../../src/types/events.js";
import type { ModelGateway, ModelStreamEvent } from "../../src/model/model-gateway.js";
import { ToolRegistry } from "../../src/tools/registry.js";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

test("automatic compaction publishes compacting while the summary model is still blocked", { timeout: 5000 }, async t => {
  const summaryOpened = gate(), summaryRelease = gate(), progress = gate();
  t.after(() => summaryRelease.release());
  const events: AgentEvent[] = [];
  const gateway: ModelGateway = { async *stream(request): AsyncIterable<ModelStreamEvent> {
    if (request.queryOrigin === "compact") {
      summaryOpened.release();
      await summaryRelease.promise;
      yield { type: "assistant_message", message: createTextMessage("assistant", "Preserve the user request") };
      yield { type: "response_completed", responseId: "summary" };
    } else yield { type: "assistant_message", message: createTextMessage("assistant", "done") };
  } };
  const engine = new QueryEngine({
    modelGateway: gateway, tools: new ToolRegistry(), contextWindowTokensOverride: 100,
    contextBudget: { autoCompactTriggerRatio: 0.001 }, compactor: new ModelDrivenCompactor(gateway),
  });
  const run = (async () => {
    for await (const event of engine.sendUserText("Retain this request and continue working")) {
      events.push(event);
      if (event.type === "state" && event.phase === "compacting") progress.release();
    }
  })();
  await summaryOpened.promise;
  await progress.promise;
  const lastState = events.filter(event => event.type === "state").at(-1);
  assert.equal(lastState?.phase, "compacting");
  assert.match(lastState?.detail ?? "", /autocompact/);
  assert.equal(events.some(event => event.type === "context.compacted"), false);
  summaryRelease.release();
  await run;
  assert.equal(events.filter(event => event.type === "context.compacted").length, 1);
});

test("a normal budget check does not claim compaction started", async () => {
  const gateway: ModelGateway = { async *stream(): AsyncIterable<ModelStreamEvent> { throw new Error("must not summarize"); } };
  const progress: unknown[] = [];
  const result = await new ModelDrivenCompactor(gateway).compact([createTextMessage("user", "short")], {
    contextWindowTokens: 100000, estimatedInputTokens: 10, onCompactionStart: reason => progress.push(reason),
  });
  assert.equal(result.changed, false);
  assert.deepEqual(progress, []);
});

test("progress bridge delivers a start before completion, deduplicates it and propagates errors", async () => {
  const release = gate();
  const stream = withCompactionProgress(async started => {
    started("manualcompact"); started("manualcompact");
    await release.promise;
    throw new Error("summary failed");
  });
  const event = await stream.next();
  assert.equal(event.value?.type, "state");
  release.release();
  await assert.rejects(stream.next(), /summary failed/);
});
