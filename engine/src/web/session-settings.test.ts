import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { CompactionReport } from "../context/compaction.js";
import type { QueryEngine } from "../core/query-engine.js";
import { WebRepl, type WebRuntime } from "./index.js";

// Web contract tests: the real WebRepl is exercised with a deliberately stubbed
// updateSessionSettings boundary. These do NOT test QueryEngine's turn hooks.
// Run from engine/: node --import tsx --test src/web/session-settings.test.ts

type Patch = Parameters<QueryEngine["updateSessionSettings"]>[0];
type UpdateResult = Awaited<ReturnType<QueryEngine["updateSessionSettings"]>>;
type Metrics = WebRuntime["initialMetrics"];
type Internals = {
  busy: boolean;
  queuedInput: string | undefined;
  publishRuntimeContext(): void;
  pendingDeltaTimer?: NodeJS.Timeout;
  terminalOutputTimer?: NodeJS.Timeout;
};

function latch<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture(t: TestContext, busy = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "web-session-settings-"));
  const envPath = path.join(root, ".env");
  const envText = "OPENAI_MODEL=shared-model\nMODEL_CONTEXT_WINDOW_TOKENS=64000\n";
  fs.writeFileSync(envPath, envText);
  const processEnv = { ...process.env };
  const forbiddenCalls: string[] = [];
  const forbidden = (name: string) => () => { forbiddenCalls.push(name); throw new Error(`Forbidden Web settings side effect: ${name}`); };
  const gateway = Object.freeze({ setInner: forbidden("gateway.setInner") });
  const agentRuntime = { modelGateway: gateway };
  const appPrompt = Object.freeze({ hasActivePrompt: true, id: "existing-prompt", text: "unchanged prefix" });
  let pending: Patch = {};
  const settings = { model: "gpt-5.6-sol", reasoning: { effort: "medium" } };
  const metrics = { contextWindowTokens: 256_000, messageCount: 2 } as Metrics;
  const calls: Patch[] = [];
  let metricsCalls = 0;
  let publishCalls = 0;
  let update: (patch: Patch) => Promise<UpdateResult> = async (patch) => {
    if (busy) pending = { ...pending, ...patch };
    return { deferred: busy };
  };
  let readMetrics = async () => metrics;
  const engine = {
    getDisplayEntries: () => [], getHistoryMessages: () => [],
    snapshot: () => ({ messages: 2, ...settings, session: { sessionId: "owner-A", sessionDir: root } }),
    getModelSettings: () => ({ ...settings }), getPendingSessionSettings: () => ({ ...pending }),
    isFastMode: () => false, getAppPrompt: () => appPrompt,
    onSessionTitleChange: () => () => undefined,
    redactDisplayValue: <T>(value: T) => value,
    updateSessionSettings: async (patch: Patch) => { calls.push(patch); return update(patch); },
    contextMetrics: async () => { metricsCalls++; return readMetrics(); },
    prompt: forbidden("engine.prompt"), run: forbidden("engine.run"),
    setAppPrompt: forbidden("engine.setAppPrompt"), setSystemPrompt: forbidden("engine.setSystemPrompt"),
    setModelProvider: forbidden("engine.setModelProvider"),
    setModelSettings: forbidden("engine.setModelSettings"), setFastMode: forbidden("engine.setFastMode"),
    setContextWindowTokens: forbidden("engine.setContextWindowTokens"), manualCompact: forbidden("engine.manualCompact"),
  };
  const runtime = {
    engine, envPath, modelGateway: gateway, agentRuntime, initialMetrics: metrics,
    defaultReasoning: { effort: "medium" },
    taskStore: { subscribe: () => () => undefined, list: () => [], isTerminal: () => false },
    execProcessManager: { subscribe: () => () => undefined, subscribeOutput: () => () => undefined, list: () => [] },
  } as unknown as WebRuntime;
  const repl = new WebRepl(runtime);
  const internal = repl as unknown as Internals;
  internal.busy = busy;
  internal.queuedInput = busy ? "already queued user message" : undefined;
  internal.publishRuntimeContext = () => { publishCalls++; };
  const initial = repl.snapshot();
  t.after(() => {
    clearTimeout(internal.pendingDeltaTimer);
    clearTimeout(internal.terminalOutputTimer);
    try {
      assert.equal(fs.readFileSync(envPath, "utf8"), envText, "must not persist session settings to env file");
      assert.deepEqual({ ...process.env }, processEnv, "must not change process env");
      assert.equal(runtime.modelGateway, gateway, "shared gateway identity must survive");
      assert.equal(agentRuntime.modelGateway, gateway, "agent gateway identity must survive");
      assert.deepEqual(runtime.defaultReasoning, { effort: "medium" });
      assert.deepEqual(forbiddenCalls, [], "settings must use only the engine settings boundary");
      assert.equal(publishCalls, 0, "must not publish/inject runtime context");
      assert.equal(repl.snapshot().queuedInput, initial.queuedInput, "must not insert/replace chat queue");
      assert.equal(engine.getAppPrompt(), appPrompt);
      assert.ok(repl.snapshot().lines.every((line) => line.kind === "meta" && line.compaction), "only an actual compaction report may add a line");
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  return {
    repl, runtime, engine, calls, metrics, internal,
    metricsCalls: () => metricsCalls,
    setUpdate: (fn: typeof update) => { update = fn; },
    setMetrics: (fn: typeof readMetrics) => { readMetrics = fn; },
    setPending: (value: Patch) => { pending = value; },
  };
}

for (const busy of [false, true]) {
  test(`Web settings forward exact patches and deferred results (${busy ? "busy" : "idle"})`, async (t) => {
    const f = fixture(t, busy);
    assert.deepEqual(await f.repl.setSessionModel(" gpt-5.6-sol ", "high"), {
      ok: true, deferred: busy, modelSettings: { model: "gpt-5.6-sol", reasoning: { effort: "high" } },
    });
    assert.deepEqual(await f.repl.setFastMode(true), { ok: true, fastMode: true, deferred: busy });
    assert.deepEqual(await f.repl.setFastMode(false), { ok: true, fastMode: false, deferred: busy });
    assert.deepEqual(await f.repl.setContextWindowK("128"), {
      ok: true, contextWindowK: 128, contextWindowTokens: 128_000, deferred: busy,
    });
    assert.deepEqual(await f.repl.compactSession(), { ok: true, deferred: busy });
    assert.deepEqual(f.calls, [
      { model: "gpt-5.6-sol", reasoning: { effort: "high" } },
      { fastMode: true }, { fastMode: false }, { contextWindowTokens: 128_000 }, { compact: true },
    ]);
    assert.equal(f.metricsCalls(), busy ? 0 : 3, "deferred changes must not refresh stale metrics");
    assert.deepEqual(f.repl.snapshot().pendingSessionSettings, busy ? {
      model: "gpt-5.6-sol", reasoning: { effort: "high" }, fastMode: false, contextWindowTokens: 128_000, compact: true,
    } : {});
    assert.equal(f.repl.snapshot().busy, busy);
    assert.deepEqual(f.repl.snapshot().lines, []);
    if (!busy) assert.equal(f.runtime.initialMetrics, f.metrics);
  });
}

test("deferred comes from the engine result, not Web busy state", async (t) => {
  const f = fixture(t, false);
  f.setUpdate(async () => ({ deferred: true }));
  assert.deepEqual(await f.repl.setContextWindowK("1"), {
    ok: true, deferred: true, contextWindowK: 1, contextWindowTokens: 1000,
  });
  assert.equal(f.metricsCalls(), 0);
});

test("model/reasoning validation rejects malformed or unsupported values before the hook", async (t) => {
  const f = fixture(t);
  const invalid: [unknown, unknown][] = [
    [undefined, undefined], [null, undefined], [42, undefined], [{}, undefined], ["", undefined],
    ["   ", undefined], ["gpt 5", undefined], ["gpt\n5", undefined], ["gpt\u0000x", undefined], ["x".repeat(257), undefined],
    ["gpt-5.6-sol", null], ["gpt-5.6-sol", {}], ["gpt-5.6-sol", 1], ["gpt-5.6-sol", "HIGH"], ["gpt-5.6-sol", " high "],
    ["gpt-5.6-sol", "minimal"], ["unknown-custom-model", "high"],
  ];
  for (const [model, reasoning] of invalid) {
    const result = await f.repl.setSessionModel(model, reasoning);
    assert.equal(result.ok, false, JSON.stringify([model, reasoning]));
    if (!result.ok) { assert.equal(result.errorCode, "MODEL_INVALID"); assert.ok(result.error); }
  }
  assert.deepEqual(f.calls, []);
  assert.equal(f.metricsCalls(), 0);
});

test("reasoning off/default/omitted preserve distinct patch semantics and pending state", async (t) => {
  const f = fixture(t, true);
  await f.repl.setSessionModel("gpt-5.6-sol", "off");
  await f.repl.setSessionModel("gpt-5.6-sol", "default");
  f.setPending({ model: "gpt-5.6-sol", reasoning: { effort: "high" } });
  const unchanged = await f.repl.setSessionModel("gpt-5.6-sol", undefined);
  assert.deepEqual(unchanged, { ok: true, deferred: true, modelSettings: { model: "gpt-5.6-sol", reasoning: { effort: "high" } } });
  await f.repl.setSessionModel("unknown-custom-model", undefined);
  assert.deepEqual(f.calls, [
    { model: "gpt-5.6-sol", reasoning: null }, { model: "gpt-5.6-sol", reasoning: undefined },
    { model: "gpt-5.6-sol" }, { model: "unknown-custom-model", reasoning: undefined },
  ]);
});

test("context window accepts only positive integer k strings with safe token conversion", async (t) => {
  const f = fixture(t);
  for (const value of [undefined, null, 128, true, {}, [], "", "0", "-1", "+1", "1.5", "1e3", "0x10", " 128", "128 ", "128k", "NaN", "Infinity", "9007199254741", "9".repeat(400)]) {
    const result = await f.repl.setContextWindowK(value);
    assert.equal(result.ok, false, JSON.stringify(value));
    if (!result.ok) assert.equal(result.errorCode, "CONTEXT_WINDOW_INVALID");
  }
  assert.deepEqual(f.calls, []);
  assert.deepEqual(await f.repl.setContextWindowK("001"), { ok: true, deferred: false, contextWindowK: 1, contextWindowTokens: 1000 });
});

const report: CompactionReport = {
  reason: "manualcompact", summary: "Saved decisions", continuationState: "Continue remaining work",
  sourceMessages: 9, preservedUserMessages: 2, newWindowMessages: 3, charsFreed: 2400, modelDriven: true, imageCount: 1,
};

test("compact renders the returned report once and marks only the newest boundary current", async (t) => {
  const f = fixture(t);
  f.setUpdate(async () => ({ deferred: false, compaction: { changed: true, messages: [], report } }));
  assert.deepEqual(await f.repl.compactSession(), { ok: true, deferred: false });
  const line = f.repl.snapshot().lines[0]!;
  assert.equal(line.kind, "meta");
  assert.equal(line.title, "Context compaction");
  const { createdAt, current, ...facts } = line.compaction!;
  assert.ok(createdAt && !Number.isNaN(Date.parse(createdAt)));
  assert.equal(current, true);
  assert.deepEqual(facts, report);
  await f.repl.compactSession();
  assert.deepEqual(f.repl.snapshot().lines.map((entry) => entry.compaction?.current), [false, true]);
  assert.equal(f.metricsCalls(), 2);
});

const actions = [
  { name: "model", run: (repl: WebRepl) => repl.setSessionModel("gpt-5.6-sol", "high"), code: "MODEL_UPDATE_FAILED" },
  { name: "context", run: (repl: WebRepl) => repl.setContextWindowK("64"), code: "CONTEXT_WINDOW_UPDATE_FAILED" },
  { name: "fast", run: (repl: WebRepl) => repl.setFastMode(true), code: "FAST_MODE_UPDATE_FAILED" },
  { name: "compact", run: (repl: WebRepl) => repl.compactSession(), code: "COMPACTION_FAILED" },
];

for (const action of actions) {
  test(`${action.name}: engine rejection is an action failure, never a queued prompt`, async (t) => {
    const f = fixture(t, true);
    f.setUpdate(async () => { throw new Error("settings hook failed"); });
    assert.deepEqual(await action.run(f.repl), { ok: false, errorCode: action.code, error: "settings hook failed" });
    assert.equal(f.calls.length, 1);
    assert.equal(f.metricsCalls(), 0);
  });

  test(`${action.name}: delayed update cannot write another owner metrics or compaction lines`, async (t) => {
    const f = fixture(t);
    const gate = latch<UpdateResult>();
    f.setUpdate(() => gate.promise);
    const operation = action.run(f.repl);
    assert.equal(f.calls.length, 1);
    const ownerBMetrics = { contextWindowTokens: 32_000, messageCount: 17 } as Metrics;
    f.runtime.engine = { ...f.engine, snapshot: () => ({ messages: 17, session: { sessionId: "owner-B" } }) } as unknown as QueryEngine;
    f.runtime.initialMetrics = ownerBMetrics;
    const statusBefore = f.repl.snapshot().status;
    gate.resolve({ deferred: false, ...(action.name === "compact" ? { compaction: { changed: true, messages: [], report } } : {}) });
    assert.equal((await operation).ok, true);
    assert.equal(f.runtime.initialMetrics, ownerBMetrics);
    assert.equal(f.repl.snapshot().status, statusBefore);
    assert.equal(f.repl.snapshot().session?.sessionId, "owner-B");
    assert.deepEqual(f.repl.snapshot().lines, []);
  });
}

for (const action of actions.filter((entry) => entry.name !== "fast")) {
  test(`${action.name}: owner switch during async metrics read drops the old metrics`, async (t) => {
    const f = fixture(t);
    const entered = latch<void>();
    const gate = latch<Metrics>();
    f.setMetrics(() => { entered.resolve(); return gate.promise; });
    const operation = action.run(f.repl);
    await entered.promise;
    f.runtime.engine = { ...f.engine } as unknown as QueryEngine;
    const ownerBMetrics = { contextWindowTokens: 12_000, messageCount: 7 } as Metrics;
    f.runtime.initialMetrics = ownerBMetrics;
    const statusBefore = f.repl.snapshot().status;
    gate.resolve(f.metrics);
    assert.equal((await operation).ok, true);
    assert.equal(f.runtime.initialMetrics, ownerBMetrics);
    assert.equal(f.repl.snapshot().status, statusBefore);
  });
}

test("HTTP source contract: POST routes pass JSON fields directly to session-only methods", () => {
  // Static wiring check only; not an HTTP integration or a core-hook test.
  const source = fs.readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const routes = [
    ["session-model", "setSessionModel(body.model, body.reasoning)"],
    ["fast-mode", "setFastMode(body.enabled === true)"],
    ["context-window", "setContextWindowK(body.value)"],
    ["compact", "compactSession()"],
  ];
  for (const [route, call] of routes) {
    const marker = `if (req.method === "POST" && url.pathname === "/api/${route}")`;
    const start = source.indexOf(marker);
    assert.notEqual(start, -1, marker);
    const nextRoute = source.indexOf('if (req.method === ', start + marker.length);
    const block = source.slice(start, nextRoute < 0 ? undefined : nextRoute);
    assert.ok(block.includes(`return sendJson(res, await repl.${call});`), route);
    assert.ok(!/repl\.(submit|prompt|run)\(/u.test(block), "settings routes must not dispatch chat input");
  }
});
