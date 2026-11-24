import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { ModelSpeedMeter, ModelSpeedStore } from "../../src/core/model-speed.js";

function clock(start = 0) {
  let now = start;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}

test("meter measures first output from send and speed from first output to end", () => {
  const time = clock();
  const meter = new ModelSpeedMeter("m1", time.now);
  time.advance(1200);
  meter.firstOutput();
  time.advance(300);
  meter.firstOutput();
  time.advance(1700);
  meter.usage({ outputTokens: 100 }, true);
  meter.usage({ outputTokens: 200 });
  meter.usage({ outputTokens: 50 }, true);
  const sample = meter.finish(new Date("2026-11-23T00:00:00Z"));
  assert.deepEqual(sample, { at: "2026-11-23T00:00:00.000Z", model: "m1", firstTokenMs: 1200, tokensPerSecond: 100 });
});

test("meter omits speed for short output and records nothing without output", () => {
  const time = clock();
  const short = new ModelSpeedMeter("m1", time.now);
  time.advance(500);
  short.firstOutput();
  time.advance(1000);
  short.usage({ outputTokens: 5 });
  assert.equal(short.finish()?.tokensPerSecond, undefined);
  assert.equal(short.finish()?.firstTokenMs, 500);

  const unknownUsage = new ModelSpeedMeter("m1", time.now);
  unknownUsage.firstOutput();
  time.advance(1000);
  assert.equal(unknownUsage.finish()?.tokensPerSecond, undefined);

  assert.equal(new ModelSpeedMeter("m1", time.now).finish(), undefined);
  const noModel = new ModelSpeedMeter(undefined, time.now);
  noModel.firstOutput();
  assert.equal(noModel.finish(), undefined);
});

test("a retry restarts timing after its back-off and drops the failed attempt's output", () => {
  const time = clock();
  const meter = new ModelSpeedMeter("m1", time.now);
  time.advance(4000);
  meter.firstOutput();
  meter.usage({ outputTokens: 999 });
  meter.retry(2000);
  time.advance(2000 + 800);
  meter.firstOutput();
  time.advance(1000);
  meter.usage({ outputTokens: 40 });
  assert.deepEqual({ ...meter.finish(), at: undefined }, { at: undefined, model: "m1", firstTokenMs: 800, tokensPerSecond: 40 });
});

test("store scopes samples to one sessions root, keeps order and hides session paths", () => {
  const store = new ModelSpeedStore();
  const alice = path.resolve("/data/users/alice/sessions");
  const bob = path.resolve("/data/users/bob/sessions");
  const sample = (model: string) => ({ at: "2026-11-23T00:00:00.000Z", model, firstTokenMs: 1 });
  store.record({ ...sample("a1"), sessionDir: path.join(alice, "s1") });
  store.record({ ...sample("b1"), sessionDir: path.join(bob, "s1") });
  store.record({ ...sample("a2"), sessionDir: path.join(alice, "s1", "subagents", "agent-1") });
  store.record({ ...sample("x"), sessionDir: alice + "-other" });
  assert.deepEqual(store.recent(alice).map((item) => item.model), ["a1", "a2"]);
  assert.deepEqual(store.recent(bob), [sample("b1")]);
  assert.deepEqual(store.recent(alice, 1).map((item) => item.model), ["a2"]);
});

test("in-flight requests: elapsed and first output, restart on retry, scoped by root, gone once ended", () => {
  const time = clock(1000);
  const store = new ModelSpeedStore(time.now);
  const root = path.resolve("/data/users/alice/sessions");
  let notified = 0;
  store.subscribe(() => { notified += 1; });
  const live = store.begin("m1", path.join(root, "s1", "subagents", "a1"));
  time.advance(1500);
  assert.deepEqual(store.inFlight(root).map(({ id: _id, ...entry }) => entry), [{ model: "m1", elapsedMs: 1500 }]);
  assert.deepEqual(store.inFlight(path.resolve("/data/users/bob/sessions")), []);
  live.restart(500);
  time.advance(800);
  assert.equal(store.inFlight(root)[0]?.elapsedMs, 300);
  live.firstOutput();
  time.advance(1000);
  live.firstOutput();
  assert.deepEqual(store.inFlight(root).map(({ id: _id, ...entry }) => entry), [{ model: "m1", elapsedMs: 1300, firstTokenMs: 300 }]);
  live.end();
  live.end();
  live.firstOutput();
  assert.deepEqual(store.inFlight(root), []);
  assert.equal(notified, 4);
});

test("store is bounded and notifies subscribers until they unsubscribe", () => {
  const store = new ModelSpeedStore();
  const root = path.resolve("/sessions");
  let calls = 0;
  const stop = store.subscribe(() => { calls += 1; });
  for (let index = 0; index < 250; index++) store.record({ at: "", model: String(index), firstTokenMs: index, sessionDir: path.join(root, "s") });
  assert.equal(calls, 250);
  stop();
  store.record({ at: "", model: "last", firstTokenMs: 0, sessionDir: path.join(root, "s") });
  assert.equal(calls, 250);
  const recent = store.recent(root, 1000);
  assert.equal(recent.length, 200);
  assert.equal(recent.at(-1)?.model, "last");
});
