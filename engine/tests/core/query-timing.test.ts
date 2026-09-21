import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { QueryTimingState, type TimingClock, type TimingRecord } from "../../src/core/query-timing.js";
import { query, type QueryDependencies } from "../../src/core/query.js";
import { QueryEngine } from "../../src/core/query-engine.js";
import { SessionStore } from "../../src/session/session-store.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { buildChatRequest } from "../../src/model/openai-chat-mapper.js";
import { buildResponsesRequest } from "../../src/model/openai-responses-mapper.js";
import { buildPromptCacheIdentity } from "../../src/core/prompt-cache-key.js";
import type { ModelRequest, ModelStreamEvent } from "../../src/model/model-gateway.js";
import { createTextMessage } from "../../src/types/messages.js";
import type { AgentEvent } from "../../src/types/events.js";

function clock() {
  return { mono: 0, wall: 1800000000000, monotonicNow() { return this.mono; }, wallNow() { return this.wall; } };
}
function dependencies(extra: Partial<QueryDependencies> = {}): QueryDependencies {
  return {
    tools: new ToolRegistry(),
    contextManager: { async build() { return { systemPrompt: "Stable prefix", promptSections: [],
      userContext: { currentDate: "2026-09-21" }, systemContext: { cwd: "fixed", platform: "win32" } }; } },
    compactor: { async compact(messages) { return { messages: [...messages], changed: false }; } },
    modelGateway: { async *stream() { yield { type: "assistant_message", message: createTextMessage("assistant", "done") }; } },
    ...extra,
  };
}
async function drain(stream: AsyncIterable<AgentEvent>) {
  const events: AgentEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}
const user = { ...createTextMessage("user", "hello"), id: "user-fixed", createdAt: "2026-09-21T00:00:00.000Z" };

test("monotonic durations survive wall-clock rollback; finish is idempotent and snapshots are detached", () => {
  const c = clock(), timing = new QueryTimingState(c, user.id);
  c.mono = 10;
  timing.firstOutput();
  c.mono = 20;
  timing.firstOutput();
  timing.queueTool("a");
  c.mono = 50;
  timing.startTool("a");
  c.mono = 100;
  c.wall -= 999000;
  assert.equal(timing.finishTool("a", true)?.durationMs, 50);
  assert.equal(timing.toolSnapshots()[0].queueMs, 30);
  const finished = timing.finish("completed")[0];
  assert.equal(finished.durationMs, 100);
  assert.equal(finished.firstOutputMs, 10);
  assert(Date.parse(finished.finishedAt!) < Date.parse(finished.startedAt!));
  assert.deepEqual(timing.finish("error"), []);
  c.mono = 9999;
  finished.durationMs = 999;
  assert.equal(timing.snapshot().durationMs, 100);
});

test("core-only query emits and records terminal timing before terminal, including first output", async () => {
  const c = clock(), records: TimingRecord[] = [];
  const events = await drain(query([user], dependencies({ timingClock: c, onTiming: r => records.push(r),
    modelGateway: { async *stream() {
      c.mono = 35; yield { type: "thinking_delta", text: "thinking" };
      c.mono = 100; yield { type: "assistant_message", message: createTextMessage("assistant", "done") };
    } },
  }), { agentId: "test" }));
  assert.equal(records[0].status, "running");
  assert.equal(records.at(-1)?.durationMs, 100);
  assert.equal(records.at(-1)?.firstOutputMs, 35);
  assert.equal(events.at(-1)?.type, "terminal");
  assert.equal(events.at(-2)?.type, "timing.updated");
});

test("early generator closure and context exceptions persist a final fact without a final yield", async () => {
  for (const fails of [false, true]) {
    const records: TimingRecord[] = [];
    const stream = query([user], dependencies({ onTiming: r => records.push(r),
      ...(fails ? { contextManager: { async build(): Promise<never> { throw new Error("context failed"); } } } : {}),
    }), { agentId: "test" });
    if (fails) await assert.rejects(drain(stream), /context failed/);
    else { await stream.next(); await stream.return("completed"); }
    assert.equal(records.length, 2);
    assert.equal(records[1].status, "finished");
    assert.equal(records[1].outcome, fails ? "error" : "consumer_closed");
  }
});

test("tool timing starts at actual serial dispatch, not the legacy all-tools started event", async () => {
  const c = clock(), tools = new ToolRegistry(), records: TimingRecord[] = [];
  tools.register({ name: "probe", description: "stable", inputSchema: { type: "object" },
    metadata: { concurrent: false, readOnly: true, visible: true },
    async execute() { c.mono += 100; return { ok: true, output: "ok" }; },
  });
  let requests = 0;
  await drain(query([user], dependencies({ tools, timingClock: c, onTiming: r => records.push(r),
    modelGateway: { async *stream() {
      if (requests++ === 0) {
        yield { type: "tool_use", toolUse: { id: "a", name: "probe", input: {} } };
        yield { type: "tool_use", toolUse: { id: "b", name: "probe", input: {} } };
      } else yield { type: "assistant_message", message: createTextMessage("assistant", "done") };
    } },
  }), { agentId: "test" }));
  const ended = records.filter(r => r.kind === "tool" && r.status === "finished");
  assert.deepEqual(ended.map(r => [r.toolUseId, r.queueMs, r.durationMs]), [["a", 0, 100], ["b", 100, 100]]);
  assert.equal(records.at(-1)?.durationMs, 200);
});

test("concurrency limit waiting is queue time rather than execution time", async () => {
  const previous = process.env.AGENT_MAX_TOOL_USE_CONCURRENCY;
  process.env.AGENT_MAX_TOOL_USE_CONCURRENCY = "1";
  try {
    const c = clock(), tools = new ToolRegistry(), records: TimingRecord[] = [];
    tools.register({ name: "probe", description: "stable", inputSchema: { type: "object" },
      metadata: { concurrent: true, readOnly: true, visible: true },
      async execute() { c.mono += 25; return { ok: true, output: "ok" }; },
    });
    await drain(query([user], dependencies({ tools, timingClock: c, onTiming: r => records.push(r),
      modelGateway: { async *stream() {
        for (const id of ["a", "b", "c"]) yield { type: "tool_use", toolUse: { id, name: "probe", input: {} } };
      } },
    }), { agentId: "test", maxTurns: 1 }));
    assert.deepEqual(records.filter(r => r.kind === "tool" && r.status === "finished").map(r => [r.queueMs, r.durationMs]),
      [[0, 25], [25, 25], [50, 25]]);
  } finally {
    if (previous === undefined) delete process.env.AGENT_MAX_TOOL_USE_CONCURRENCY;
    else process.env.AGENT_MAX_TOOL_USE_CONCURRENCY = previous;
  }
});

test("parallel tools record actual dispatch and settlement independently", async () => {
  const c = clock(), tools = new ToolRegistry(), records: TimingRecord[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  tools.register({ name: "probe", description: "stable", inputSchema: { type: "object" },
    metadata: { concurrent: true, readOnly: true, visible: true },
    async execute(_input, context) {
      if (context.toolUseId === "a") { await gate; c.mono = 100; }
      else { c.mono = 20; release(); }
      return { ok: true, output: "ok" };
    },
  });
  const events = await drain(query([user], dependencies({ tools, timingClock: c, onTiming: r => records.push(r),
    modelGateway: { async *stream() {
      yield { type: "tool_use", toolUse: { id: "a", name: "probe", input: {} } };
      yield { type: "tool_use", toolUse: { id: "b", name: "probe", input: {} } };
    } },
  }), { agentId: "test", maxTurns: 1 }));
  assert.equal(records.filter(r => r.kind === "tool" && r.status === "running").length, 2);
  assert.equal(records.filter(r => r.kind === "tool" && r.status === "finished").length, 2);
  assert.equal(events.at(-1)?.type, "terminal");
  assert.equal(records.at(-1)?.durationMs, 100);
});

test("aborted tools have unknown final duration; late settlement cannot rewrite closed query", async () => {
  const c = clock(), timing = new QueryTimingState(c);
  timing.queueTool("running"); timing.startTool("running"); timing.queueTool("queued");
  c.mono = 50;
  const closed = timing.finish("aborted_tools");
  assert.equal(closed[0].status, "interrupted");
  assert.equal(closed[0].elapsedMs, 50);
  assert.equal(closed[0].durationMs, undefined);
  assert.equal(closed[1].startedAt, undefined);
  c.mono = 100;
  assert.equal(timing.finishTool("running", true), undefined);
  assert.equal(timing.startTool("queued"), undefined);
  assert.equal(timing.snapshot().durationMs, 50);
});

test("model error and pre-aborted queries have terminal timing", async () => {
  for (const abort of [false, true]) {
    const controller = new AbortController();
    if (abort) controller.abort();
    const records: TimingRecord[] = [];
    await drain(query([user], dependencies({ onTiming: r => records.push(r),
      modelGateway: { async *stream(): AsyncIterable<ModelStreamEvent> { throw new Error("failure"); } },
    }), { agentId: "test", abortSignal: controller.signal }));
    assert.equal(records.at(-1)?.outcome, abort ? "aborted_streaming" : "model_error");
    assert.equal(records.at(-1)?.status, "finished");
  }
});

test("timing values and UUIDs never change Chat/Responses wire requests, cache identity or diagnostics", async () => {
  async function run(wall: number, step: number) {
    const requests: ModelRequest[] = [], events: AgentEvent[] = [];
    let now = 0;
    const timingClock: TimingClock = { wallNow: () => wall, monotonicNow: () => (now += step) };
    const deps = dependencies({ timingClock, modelGateway: { async *stream(request) {
      requests.push(request);
      if (requests.length === 1) {
        yield { type: "response_incomplete", responseId: "response-fixed", reason: "max_output_tokens" };
      } else yield { type: "assistant_message", message: { ...user, role: "assistant", id: "answer-fixed" } };
    } } });
    for await (const event of query([structuredClone(user)], deps, { agentId: "test", model: "gpt-5" })) events.push(event);
    return {
      chat: requests.map(r => buildChatRequest(r, { model: "gpt-5" })),
      responses: requests.map(r => buildResponsesRequest(r, { model: "gpt-5" })),
      identity: requests.map(r => buildPromptCacheIdentity(r.systemPrompt, r.tools, r.model, r.messages)),
      metrics: events.filter(e => e.type === "context.metrics").map(e => e.metrics),
      timing: events.filter(e => e.type === "timing.updated"),
    };
  }
  const a = await run(1800000000000, 1), b = await run(1900000000000, 987);
  assert.notDeepEqual(a.timing, b.timing);
  assert.deepEqual(a.chat, b.chat);
  assert.deepEqual(a.responses, b.responses);
  assert.deepEqual(a.identity, b.identity);
  assert.deepEqual(a.metrics, b.metrics);
  assert.doesNotMatch(JSON.stringify(a.responses), /durationMs|firstOutputMs|runId|timing/);
});

test("tool rounds and persisted resume keep identical wire bodies and cache keys with or without early headers", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "neo-timing-cache-"));
  try {
    async function run(sessionId: string, step: number) {
      const requests: ModelRequest[] = [], records: TimingRecord[] = [];
      const tools = new ToolRegistry();
      tools.register({ name: "probe", description: "stable", inputSchema: { type: "object" },
        metadata: { concurrent: false, readOnly: true, visible: true },
        async execute() { return { ok: true, output: { value: "stable result" } }; },
      });
      const store = await SessionStore.open({ agentId: "test", rootDir: root, sessionId, resume: true });
      store.recordMessage(user);
      let now = 0;
      const deps = dependencies({ tools,
        timingClock: { wallNow: () => 1800000000000 + step, monotonicNow: () => (now += step) },
        onTiming: record => { records.push(record); store.recordTiming(record); },
        modelGateway: { async *stream(request) {
          requests.push(request);
          if (requests.length === 1) {
            if (step > 1) {
              yield { type: "tool_call_started", callId: "call-fixed", name: "probe" };
              yield { type: "retrying", attempt: 1, delayMs: 0, error: new Error("retry fixture") };
              yield { type: "tool_call_started", callId: "call-fixed", name: "probe" };
            }
            yield { type: "assistant_message", message: { ...user, id: "tool-message", role: "assistant",
              blocks: [{ type: "tool_use", id: "call-fixed", name: "probe", input: {} }] } };
            yield { type: "tool_use", toolUse: { id: "call-fixed", name: "probe", input: {} } };
          } else yield { type: "assistant_message", message: { ...user, id: "answer-fixed", role: "assistant" } };
        } },
      });
      for await (const event of query([user], deps, { agentId: "test", model: "gpt-5" })) {
        if (event.type === "message") store.recordMessage(event.message);
      }
      const restored = await SessionStore.open({ agentId: "test", rootDir: root, sessionId, resume: true });
      assert(restored.getTimings().some(record => record.kind === "tool" && record.status === "finished"));
      await drain(query(restored.getInitialMessages(), deps, { agentId: "test", model: "gpt-5" }));
      assert.equal(requests.length, 3);
      return { records,
        chat: requests.map(request => buildChatRequest(request, { model: "gpt-5" })),
        responses: requests.map(request => buildResponsesRequest(request, { model: "gpt-5" })),
        keys: requests.map(r => buildPromptCacheIdentity(r.systemPrompt, r.tools, r.model, r.messages)),
      };
    }
    const a = await run("one", 1), b = await run("two", 800);
    assert.notDeepEqual(a.records, b.records);
    assert.deepEqual(a.chat, b.chat);
    assert.deepEqual(a.responses, b.responses);
    assert.deepEqual(a.keys, b.keys);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("tool settlements are timestamped while the query consumer is paused; cancellation stays unknown", async () => {
  for (const abort of [false, true]) {
    const c = clock(), records: TimingRecord[] = [], tools = new ToolRegistry();
    const controller = new AbortController();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    tools.register({ name: "probe", description: "stable", inputSchema: { type: "object" },
      metadata: { concurrent: true, readOnly: true, visible: true },
      async execute() { await gate; return { ok: true, output: "ok" }; },
    });
    const stream = query([user], dependencies({ tools, timingClock: c, onTiming: r => records.push(r),
      modelGateway: { async *stream() { yield { type: "tool_use", toolUse: { id: "a", name: "probe", input: {} } }; } },
    }), { agentId: "test", maxTurns: 1, abortSignal: controller.signal });
    for await (const event of { [Symbol.asyncIterator]: () => ({ next: () => stream.next() }) }) {
      if (event.type === "timing.updated" && event.timing.kind === "tool" && event.timing.status === "running") break;
    }
    c.mono = 40;
    if (abort) {
      controller.abort();
      await drain(stream);
      assert.equal(records.find(r => r.kind === "tool" && r.status === "interrupted")?.durationMs, undefined);
      assert(records.some(r => r.kind === "tool" && r.status === "interrupted"));
    }
    release();
    await new Promise(resolve => setImmediate(resolve));
    if (abort) assert(!records.some(r => r.kind === "tool" && r.status === "finished"));
    else {
      assert.equal(records.find(r => r.kind === "tool" && r.status === "finished")?.durationMs, 40);
      c.mono = 900;
      await drain(stream);
      assert.equal(records.find(r => r.kind === "tool" && r.status === "finished")?.durationMs, 40);
      assert.equal(records.at(-1)?.durationMs, 900);
    }
  }
});

test("reused tool call IDs in later turns get independent timing identities", () => {
  const c = clock(), timing = new QueryTimingState(c);
  const first = timing.queueTool("a"); timing.startTool("a");
  c.mono = 20; timing.finishTool("a", true);
  const second = timing.queueTool("a"); timing.startTool("a");
  c.mono = 50; timing.finishTool("a", false);
  assert.notEqual(first.id, second.id);
  assert.deepEqual(timing.toolSnapshots().map(r => [r.durationMs, r.outcome]), [[20, "completed"], [30, "failed"]]);
});

test("session records timing separately; reload/compaction never inject it into model history", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "neo-timing-"));
  try {
    const open = () => SessionStore.open({ agentId: "test", rootDir: root, sessionId: "session", resume: true });
    const store = await open(), c = clock(), timing = new QueryTimingState(c, user.id);
    store.recordMessage(user);
    store.recordTiming(timing.snapshot());
    c.mono = 80;
    store.recordTiming(timing.finish("completed")[0]);
    const interrupted = new QueryTimingState(c);
    store.recordTiming(interrupted.snapshot(), 3);
    store.recordCompactCheckpoint([user], "manualcompact");
    const loaded = await open();
    assert.deepEqual(loaded.getInitialMessages(), [user]);
    assert.equal(loaded.getTimings()[0].durationMs, 80);
    assert.equal(loaded.getTimings()[1].status, "interrupted");
    assert.equal(loaded.getTimings()[1].durationMs, undefined);
    assert.equal(loaded.getTimings()[1].finishedAt, undefined);
    assert(!loaded.getDisplayEntries().some(e => (e as { type: string }).type === "timing"));
    const rows = (await readFile(store.transcriptPath, "utf8")).trim().split("\n").map(row => JSON.parse(row));
    assert.equal(rows.filter(r => r.type === "timing").length, 3);
    assert.equal(rows.find(r => r.runGeneration)?.runGeneration, 3);
    loaded.reset();
    assert.deepEqual((await open()).getTimings(), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("QueryEngine exposes live core snapshots without Web, restores final timing and isolates new sessions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "neo-engine-timing-"));
  try {
    const c = clock();
    const opts = { ...dependencies(), timingClock: c, agentId: "test", session: { rootDir: root, sessionId: "one", resume: true } };
    const engine = new QueryEngine(opts);
    const stream = engine.sendUserText("hello");
    while ((await stream.next()).value?.type !== "timing.updated") { /* reach core start */ }
    c.mono = 150;
    assert.equal(engine.getTimingRecords()[0].elapsedMs, 150);
    const snapshot = engine.getTimingRecords(); snapshot[0].elapsedMs = 999;
    assert.equal(engine.getTimingRecords()[0].elapsedMs, 150);
    await stream.return(undefined);
    assert.equal(engine.getTimingRecords()[0].durationMs, 150);
    const restored = new QueryEngine(opts); await restored.initialize();
    assert.equal(restored.getTimingRecords()[0].durationMs, 150);
    assert.equal(restored.getTimingRecords()[0].outcome, "consumer_closed");
    await restored.newSession();
    assert.deepEqual(restored.getTimingRecords(), []);
    engine.reset();
    assert.deepEqual(engine.getTimingRecords(), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("tool header is observable before arguments without execution or first-output inflation", async () => {
  const c = clock(), records: TimingRecord[] = [];
  const stream = query([user], dependencies({ timingClock: c, onTiming: r => records.push(r),
    modelGateway: { async *stream() {
      c.mono = 10;
      yield { type: "tool_call_started", callId: "a", name: "file_edit" };
      c.mono = 20;
      yield { type: "tool_call_delta", callId: "a", name: "file_edit", argumentsDelta: '{"path":' };
    } },
  }), { agentId: "test", maxTurns: 1 });
  const events: AgentEvent[] = [];
  for await (const event of stream) {
    events.push(event);
    if (event.type === "tool_call.started") {
      assert.deepEqual(event, { type: "tool_call.started", callId: "a", name: "file_edit" });
      assert.equal(c.mono, 10);
      assert(!events.some(e => e.type === "tool.started" || e.type === "tool_call.delta"));
    }
  }
  assert(events.some(e => e.type === "tool_call.started"));
  assert(!events.some(e => e.type === "tool.started"));
  assert.equal(records.at(-1)?.firstOutputMs, 20);
});
