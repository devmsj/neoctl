import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { QueryTimingState, type TimingRecord } from "../../src/core/query-timing.js";
import { WebRepl, restoreWebHistoryLines } from "../../src/web/index.js";
import type { AgentEvent } from "../../src/types/events.js";
import { createToolResultMessage } from "../../src/types/messages.js";

const call = { id: "a", name: "probe", input: {} };
function runtime(getTimingRecords: () => TimingRecord[]) {
  return {
    engine: {
      getTimingRecords,
      getDisplayEntries: () => [{ type: "message", message: createToolResultMessage(call, true, "ok") }],
      snapshot: () => ({ session: { sessionId: "timing-test" } }),
      isFastMode: () => false,
      getAppPrompt: () => ({ hasActivePrompt: false }),
      onSessionTitleChange: () => () => undefined,
    },
    usage: { snapshot: () => ({}), add: () => undefined, reset: () => undefined },
    taskStore: { subscribe: () => () => undefined, list: () => [] },
    execProcessManager: { subscribe: () => () => undefined, subscribeOutput: () => () => undefined, list: () => [] },
  };
}

test("Web snapshot and SSE project core monotonic facts, reconnect does not reset the origin", async () => {
  let mono = 0;
  const timing = new QueryTimingState({ wallNow: () => 1800000000000, monotonicNow: () => mono });
  timing.queueTool("a"); timing.startTool("a");
  const repl = new WebRepl(runtime(() => [timing.snapshot(), ...timing.toolSnapshots()]) as never);
  mono = 1500;
  assert.equal(repl.snapshot(false).status.queryTiming?.elapsedMs, 1500);
  assert.equal(repl.snapshot(false).status.toolTimings?.[0].elapsedMs, 1500);
  assert.equal(repl.snapshot(false).lines[0].timing?.id, timing.toolSnapshots()[0].id);
  const chunks: string[] = [];
  const response = Object.assign(new EventEmitter(), { writeHead() {}, write(chunk: string) { chunks.push(chunk); return true; } });
  repl.subscribe(response as never);
  const firstSync = chunks.find(chunk => chunk.includes("\nevent: sync\n"))!;
  assert.equal(JSON.parse(firstSync.split("data: ")[1]).status.queryTiming.elapsedMs, 1500);
  mono = 3000;
  const records = [timing.finishTool("a", true)!, ...timing.finish("completed")];
  const handleEvent = (repl as unknown as { handleEvent(event: AgentEvent): void }).handleEvent.bind(repl);
  for (const record of records) handleEvent({ type: "timing.updated", timing: record });
  await new Promise(resolve => setTimeout(resolve, 40));
  const delta = chunks.filter(chunk => chunk.includes("\nevent: delta\n")).at(-1)!;
  assert.equal(JSON.parse(delta.split("data: ")[1]).status.queryTiming.durationMs, 3000);
  assert.equal(repl.snapshot(false).lines[0].timing?.durationMs, 3000);
  response.emit("close");
  mono = 999999;
  const reloaded = new WebRepl(runtime(() => [timing.snapshot(), ...timing.toolSnapshots()]) as never);
  assert.equal(reloaded.snapshot(false).status.queryTiming?.durationMs, 3000);
  assert.equal(reloaded.snapshot(false).lines[0].timing?.durationMs, 3000);
});

test("historical tool timings are kept on display lines, not resent with every current status; ambiguous IDs stay unknown", () => {
  const old = new QueryTimingState(); old.queueTool("a"); old.startTool("a"); old.finishTool("a", true); old.finish("completed");
  const current = new QueryTimingState();
  let records = [old.snapshot(), ...old.toolSnapshots(), current.snapshot()];
  const rt = runtime(() => records);
  const repl = new WebRepl(rt as never);
  assert.equal(repl.snapshot(false).status.queryTiming?.id, current.snapshot().id);
  assert.deepEqual(repl.snapshot(false).status.toolTimings, []);
  assert.equal(repl.snapshot(false).lines[0].timing?.id, old.toolSnapshots()[0].id);
  current.queueTool("a");
  records = [...records, ...current.toolSnapshots()];
  assert.equal(restoreWebHistoryLines(rt as never)[0].timing, undefined);
  records = [];
  assert.equal(repl.snapshot(false).status.queryTiming, undefined);
  assert.equal(restoreWebHistoryLines(rt as never)[0].timing, undefined);
});


test("early tool activity reaches snapshot/SSE without argument leakage or token increments", async () => {
  const repl = new WebRepl(runtime(() => []) as never);
  const handle = (repl as unknown as { handleEvent(event: AgentEvent): void }).handleEvent.bind(repl);
  const chunks: string[] = [];
  const response = Object.assign(new EventEmitter(), { writeHead() {}, write(chunk: string) { chunks.push(chunk); return true; } });
  repl.subscribe(response as never);
  try {
    const header = { type: "tool_call.started", callId: "a", name: "file_edit" } as const;
    handle(header);
    assert.deepEqual(repl.snapshot(false).status.modelOutput, { kind: "tool_call", callId: "a", name: "file_edit" });
    assert.equal(repl.snapshot(false).status.streamedOutputTokens, 0);
    assert.equal(repl.snapshot(false).status.currentTool, undefined);
    await new Promise(resolve => setTimeout(resolve, 40));
    const delta = chunks.filter(chunk => chunk.includes("\nevent: delta\n")).at(-1)!;
    assert.equal(JSON.parse(delta.split("data: ")[1]).status.modelOutput.name, "file_edit");
    handle({ type: "tool_call.delta", callId: "a", argumentsDelta: '{"secret":"never publish partial input' });
    assert.equal(repl.snapshot(false).status.modelOutput?.kind, "tool_call");
    assert(!JSON.stringify(repl.snapshot(false).status).includes("secret"));
    assert(repl.snapshot(false).status.streamedOutputTokens > 0);
    // Interleaved unknown call must not borrow another call's name.
    handle({ type: "tool_call.delta", callId: "b", argumentsDelta: "{" });
    assert.deepEqual(repl.snapshot(false).status.modelOutput, { kind: "tool_call", callId: "b", name: undefined });
    for (const boundary of [
      { type: "state", phase: "preparing" },
      { type: "state", phase: "running_tools" },
      { type: "retrying", attempt: 1, delayMs: 10, error: new Error("retry") },
      { type: "terminal", reason: "completed" },
    ] as AgentEvent[]) {
      handle(header); handle(boundary);
      assert.equal(repl.snapshot(false).status.modelOutput, undefined);
    }
    handle(header);
    handle({ type: "assistant.delta", text: "hello" });
    assert.deepEqual(repl.snapshot(false).status.modelOutput, { kind: "text" });
    handle({ type: "thinking.delta", text: "reasoning" });
    assert.equal(repl.snapshot(false).status.modelOutput, undefined);
  } finally { response.emit("close"); }
});
