import assert from "node:assert/strict";
import test from "node:test";
import { QueryEngine, type QueryEngineOptions } from "./query-engine.js";
import { buildPromptCacheIdentity } from "./prompt-cache-key.js";
import type { ModelRequest, ModelStreamEvent } from "../model/model-gateway.js";
import type { Compactor } from "../context/compaction.js";
import { createTextMessage, type Message } from "../types/messages.js";
import type { AgentEvent } from "../types/events.js";
import { ToolRegistry } from "../tools/registry.js";
import type { ToolUseContext } from "../tools/tool.js";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
const unchanged: Compactor = { async compact(messages) { return { messages: [...messages], changed: false }; } };
function fixture(options: Partial<QueryEngineOptions> = {}) {
  const opened = gate(), resume = gate();
  const requests: ModelRequest[] = [];
  const toolOptions: Array<ToolUseContext["options"]> = [];
  const builds: Array<ToolUseContext["options"]> = [];
  const tools = new ToolRegistry();
  tools.register({ name: "probe", description: "Stable tool", inputSchema: { type: "object" },
    metadata: { readOnly: true, concurrent: true, visible: true }, validate() { return {}; },
    async call(_input, context) { toolOptions.push({ ...context.options }); return { ok: true, output: "ok" }; },
  });
  const engine = new QueryEngine({
    model: "gpt-5", reasoning: { effort: "low" }, maxOutputTokensOverride: 1000,
    contextWindowTokensOverride: 100000, tools, compactor: unchanged, session: { enabled: false },
    contextManager: { async build(input) { builds.push({ ...input.toolUseContext?.options }); return {
      systemPrompt: "Immutable system prefix", promptSections: [], userContext: { currentDate: "2026-09-08" },
      systemContext: { cwd: "stable-workspace", platform: "win32" },
    }; } },
    modelGateway: { async *stream(request): AsyncIterable<ModelStreamEvent> {
      requests.push(request);
      if (requests.length === 1) {
        opened.release(); await resume.promise;
        yield { type: "tool_use", toolUse: { id: "probe1", name: "probe", input: {} } };
        yield { type: "response_completed", responseId: "resp-first" };
      } else yield { type: "assistant_message", message: createTextMessage("assistant", "finished") };
    } }, ...options,
  });
  return { engine, requests, opened, resume, toolOptions, builds };
}
async function drain(stream: AsyncIterable<AgentEvent>) {
  const events: AgentEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}
function identity(request: ModelRequest) {
  return buildPromptCacheIdentity(request.systemPrompt, request.tools, request.model, request.messages);
}

test("midstream settings are gated, merged and next-turn-local; same-model cache and response chain stay exact", async () => {
  const f = fixture();
  const result = drain(f.engine.sendUserText("Original user input"));
  await f.opened.promise;
  const original = JSON.stringify(f.requests[0]);
  assert.deepEqual(await f.engine.updateSessionSettings({ fastMode: true, contextWindowTokens: 60000, reasoning: { effort: "high" } }), { deferred: true });
  await f.engine.updateSessionSettings({ contextWindowTokens: 70000 });
  const snapshot = f.engine.getPendingSessionSettings();
  snapshot.reasoning!.effort = "max";
  assert.equal(f.engine.getPendingSessionSettings().reasoning?.effort, "high");
  assert.equal(JSON.stringify(f.requests[0]), original);
  assert.equal(f.engine.isFastMode(), false);
  f.resume.release();
  const events = await result;
  assert.equal(f.requests[1].serviceTier, "priority");
  assert.deepEqual(f.requests[1].reasoning, { effort: "high" });
  // Existing full-history tool turns intentionally omit response chaining.
  assert.equal(f.requests[1].previousResponseId, undefined);
  assert.equal(f.requests[1].maxOutputTokens, 1000);
  assert.deepEqual(f.requests[1].tools, f.requests[0].tools);
  assert.equal(f.requests[1].systemPrompt, f.requests[0].systemPrompt);
  // Synthetic runtime-context envelopes get fresh local IDs/timestamps; neither is provider input.
  const promptMessages = (messages: readonly Message[]) => messages.map(({ id: _id, createdAt: _createdAt, ...wire }) => wire);
  assert.deepEqual(promptMessages(f.requests[1].messages.slice(0, f.requests[0].messages.length)), promptMessages(f.requests[0].messages));
  assert.equal(identity(f.requests[0]).key, identity(f.requests[1]).key);
  assert.equal(identity(f.requests[0]).stablePrefixHash, identity(f.requests[1]).stablePrefixHash);
  assert.equal(f.toolOptions[0]?.serviceTier, undefined);
  assert.deepEqual(f.toolOptions[0]?.reasoning, { effort: "low" });
  assert.equal(f.builds[1]?.serviceTier, "priority");
  assert.equal(f.builds[1]?.contextWindowTokensOverride, 70000);
  assert(events.some((e) => e.type === "context.metrics" && e.metrics.contextWindowTokens === 70000));
  assert.deepEqual(f.engine.getPendingSessionSettings(), {});
  assert.doesNotMatch(JSON.stringify(f.engine.getHistoryMessages()), /fastMode|contextWindowTokens|reasoning/);
});

test("real model switch clears response chain, no-op model and canceling LWW do not", async () => {
  for (const switchModel of [true, false]) {
    const f = fixture();
    const done = drain(f.engine.sendUserText("input")); await f.opened.promise;
    await f.engine.updateSessionSettings({ model: "gpt-5-mini", fastMode: true });
    await f.engine.updateSessionSettings({ model: switchModel ? "gpt-5-mini" : "gpt-5", fastMode: false });
    f.resume.release(); await done;
    assert.equal(f.requests[1].model, switchModel ? "gpt-5-mini" : "gpt-5");
    assert.equal(f.requests[1].previousResponseId, undefined);
    assert.equal(f.requests[1].serviceTier, undefined);
    assert.equal(identity(f.requests[0]).key === identity(f.requests[1]).key, !switchModel);
  }
});

test("max-output recovery keeps escalation and response chain under no-op/fast/context, actual model switch discards continuation-only input", async () => {
  for (const switchModel of [false, true]) {
    const opened = gate(), resume = gate(); const requests: ModelRequest[] = [];
    const f = fixture({ modelGateway: { async *stream(request): AsyncIterable<ModelStreamEvent> {
      requests.push(request);
      if (requests.length === 1) {
        opened.release(); await resume.promise;
        yield { type: "assistant_message", message: createTextMessage("assistant", "PARTIAL_ANSWER") };
        yield { type: "response_incomplete", responseId: "resp-recover", reason: "max_output_tokens" };
      } else yield { type: "assistant_message", message: createTextMessage("assistant", "done") };
    } } });
    const done = drain(f.engine.sendUserText("RECOVER_INPUT")); await opened.promise;
    await f.engine.updateSessionSettings({ model: switchModel ? "gpt-5-mini" : "gpt-5", fastMode: true, contextWindowTokens: 70000 });
    resume.release(); await done;
    assert.equal(requests[1].maxOutputTokens, 64000);
    assert.equal(requests[1].previousResponseId, switchModel ? undefined : "resp-recover");
    assert.equal(requests[1].serviceTier, "priority");
    if (switchModel) assert.match(JSON.stringify(requests[1].messages), /RECOVER_INPUT/);
    else assert.match(JSON.stringify(requests[1].messages), /Continue from the exact point/);
  }
});

test("manual compact coalesces and replaces both query state and history, never inside stream", async () => {
  const inputs: Message[][] = [];
  const f = fixture({ compactor: { ...unchanged, async manualCompact(messages, budget) {
    inputs.push([...messages]); assert.equal(budget?.contextWindowTokens, 80000);
    return { messages: [createTextMessage("user", "CHECKPOINT")], changed: true, reason: "manualcompact", summary: "checkpoint" };
  } } });
  const done = drain(f.engine.sendUserText("OLD_INPUT")); await f.opened.promise;
  await f.engine.updateSessionSettings({ compact: true, contextWindowTokens: 80000 });
  await f.engine.updateSessionSettings({ compact: true });
  await f.engine.updateSessionSettings({ compact: false });
  assert.equal(inputs.length, 0);
  f.resume.release(); const events = await done;
  assert.equal(inputs.length, 1);
  assert(inputs[0].some((m) => m.blocks.some((b) => b.type === "tool_result")));
  assert.match(JSON.stringify(f.requests[1].messages), /CHECKPOINT/);
  assert.doesNotMatch(JSON.stringify(f.requests[1].messages), /OLD_INPUT/);
  assert.doesNotMatch(JSON.stringify(f.engine.getHistoryMessages()), /OLD_INPUT/);
  assert.equal(events.filter((e) => e.type === "context.compacted").length, 1);
  await drain(f.engine.sendUserText("next input"));
  assert.doesNotMatch(JSON.stringify(f.requests[2].messages), /OLD_INPUT/);
});

test("final no-tool boundary applies pending, compact includes final assistant and emits once", async () => {
  const opened = gate(), resume = gate(); const compactInputs: Message[][] = [];
  const f = fixture({ modelGateway: { async *stream(): AsyncIterable<ModelStreamEvent> {
    opened.release(); await resume.promise;
    yield { type: "assistant_message", message: createTextMessage("assistant", "FINAL_ANSWER") };
  } }, compactor: { ...unchanged, async manualCompact(messages) {
    compactInputs.push([...messages]); return { messages: [createTextMessage("user", "FINAL_CHECKPOINT")], changed: true, reason: "manualcompact", summary: "final" };
  } } });
  const done = drain(f.engine.sendUserText("input")); await opened.promise;
  await f.engine.updateSessionSettings({ model: "gpt-5-mini", compact: true, contextWindowTokens: 90000 });
  resume.release(); const events = await done;
  assert.match(JSON.stringify(compactInputs), /FINAL_ANSWER/);
  assert.equal(events.filter((e) => e.type === "context.compacted").length, 1);
  const metrics = events.filter((e) => e.type === "context.metrics");
  assert.equal(metrics.at(-1)?.metrics.contextWindowTokens, 90000);
  assert.equal(f.engine.getModelSettings().model, "gpt-5-mini");
  assert.deepEqual(f.engine.getPendingSessionSettings(), {});
  assert.match(JSON.stringify(f.engine.getHistoryMessages()), /FINAL_CHECKPOINT/);
});

test("idle mutations serialize compaction ahead of new user generator; idle compaction is returned", async () => {
  const compacting = gate(), releaseCompact = gate();
  const f = fixture({ compactor: { ...unchanged, async manualCompact() {
    compacting.release(); await releaseCompact.promise;
    return { messages: [createTextMessage("user", "IDLE_CHECKPOINT")], changed: true, reason: "manualcompact", summary: "idle" };
  } } });
  const update = f.engine.updateSessionSettings({ compact: true, fastMode: true });
  await compacting.promise;
  const done = drain(f.engine.sendUserText("NEW_INPUT"));
  await Promise.resolve(); assert.equal(f.requests.length, 0);
  assert.deepEqual(await f.engine.updateSessionSettings({ reasoning: null }), { deferred: true });
  releaseCompact.release();
  const result = await update; assert.equal(result.deferred, false); assert.equal(result.compaction?.changed, true);
  await f.opened.promise;
  assert.equal(f.requests[0].serviceTier, "priority"); assert.equal(f.requests[0].reasoning, null);
  assert.match(JSON.stringify(f.requests[0].messages), /IDLE_CHECKPOINT/);
  assert.match(JSON.stringify(f.requests[0].messages), /NEW_INPUT/);
  f.resume.release(); await done;
});

test("abort and consumer return settle pending; forks never inherit pending; null versus default preserved", async () => {
  const f = fixture(); const controller = new AbortController();
  const done = drain(f.engine.sendUserText("input", { abortSignal: controller.signal })); await f.opened.promise;
  await f.engine.updateSessionSettings({ model: "gpt-5-mini", reasoning: null, fastMode: true });
  const fork = f.engine.forkForSession();
  assert.deepEqual(fork.getPendingSessionSettings(), {});
  assert.equal(fork.getModelSettings().model, "gpt-5");
  controller.abort(); f.resume.release(); await done;
  assert.equal(f.requests.length, 1); assert.equal(f.engine.getModelSettings().reasoning, null);
  assert.equal((await f.engine.updateSessionSettings({ reasoning: undefined })).deferred, false);
  assert.equal(f.engine.getModelSettings().reasoning, undefined);
  const stream = f.engine.sendUserText("return early"); await stream.next();
  await f.engine.updateSessionSettings({ reasoning: undefined, fastMode: false });
  assert(Object.hasOwn(f.engine.getPendingSessionSettings(), "reasoning"));
  await stream.return(undefined);
  assert.deepEqual(f.engine.getPendingSessionSettings(), {});
  assert.equal(f.engine.isFastMode(), false);
  assert.equal((await f.engine.updateSessionSettings({})).deferred, false);
});

test("abort during before-turn compact commits checkpoint but never opens next model request", async () => {
  const compacting = gate(), releaseCompact = gate(); const controller = new AbortController();
  const f = fixture({ compactor: { ...unchanged, async manualCompact() {
    compacting.release(); await releaseCompact.promise;
    return { messages: [createTextMessage("user", "ABORT_CHECKPOINT")], changed: true, reason: "manualcompact", summary: "aborted" };
  } } });
  const done = drain(f.engine.sendUserText("input", { abortSignal: controller.signal })); await f.opened.promise;
  await f.engine.updateSessionSettings({ compact: true }); f.resume.release(); await compacting.promise;
  controller.abort(); releaseCompact.release(); const events = await done;
  assert.equal(f.requests.length, 1);
  assert.equal(events.filter((e) => e.type === "context.compacted").length, 1);
  assert.match(JSON.stringify(f.engine.getHistoryMessages()), /ABORT_CHECKPOINT/);
});
