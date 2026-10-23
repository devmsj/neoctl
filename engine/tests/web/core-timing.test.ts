import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { QueryTimingState, type TimingRecord } from "../../src/core/query-timing.js";
import { WebRepl, restoreWebHistoryLines } from "../../src/web/index.js";
import type { AgentEvent } from "../../src/types/events.js";
import { createTextMessage, createToolResultMessage } from "../../src/types/messages.js";

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


test("completed text and next model request do not retain generating-reply status", async () => {
  const repl = new WebRepl(runtime(() => []) as never);
  const handle = (repl as unknown as { handleEvent(event: AgentEvent): void }).handleEvent.bind(repl);
  const chunks: string[] = [];
  const response = Object.assign(new EventEmitter(), { writeHead() {}, write(chunk: string) { chunks.push(chunk); return true; } });
  repl.subscribe(response as never);
  try {
    handle({ type: "assistant.delta", text: "previous visible reply" });
    assert.equal(repl.snapshot(false).status.modelOutput?.kind, "text");
    handle({ type: "assistant.output.done" });
    assert.equal(repl.snapshot(false).status.phase, "calling_model");
    assert.equal(repl.snapshot(false).status.modelOutput, undefined);
    await new Promise(resolve => setTimeout(resolve, 40));
    const delta = chunks.filter(chunk => chunk.includes("\nevent: delta\n")).at(-1)!;
    assert.equal(JSON.parse(delta.split("data: ")[1]).status.modelOutput, undefined);
    handle({ type: "assistant.delta", text: "" });
    assert.equal(repl.snapshot(false).status.modelOutput, undefined);
    handle({ type: "assistant.delta", text: "next reply" });
    handle({ type: "message", message: createTextMessage("assistant", "next reply") });
    assert.equal(repl.snapshot(false).status.modelOutput, undefined);
    handle({ type: "assistant.delta", text: "old text" });
    handle({ type: "state", phase: "calling_model" });
    assert.equal(repl.snapshot(false).status.modelOutput, undefined);
    handle({ type: "tool_call.started", callId: "next-tool", name: "file_read" });
    handle({ type: "assistant.output.done" });
    assert.equal(repl.snapshot(false).status.modelOutput?.kind, "tool_call", "a late text boundary must not erase current tool generation");
  } finally { response.emit("close"); }
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


test("tool connection membership survives later model calls for frontend timed playback", () => {
  const repl = new WebRepl(runtime(() => []) as never);
  const handle = (repl as unknown as { handleEvent(event: AgentEvent): void }).handleEvent.bind(repl);
  const row = (id: string) => repl.snapshot(false).lines.find(line => line.toolUseId === id)!;
  const chunks: string[] = [];
  const response = Object.assign(new EventEmitter(), { writeHead() {}, write(chunk: string) { chunks.push(chunk); return true; } });
  repl.subscribe(response as never);
  try {
    handle({ type: "state", phase: "calling_model" });
    handle({ type: "tool_call.started", callId: "turn-a", name: "file_read" });
    assert.equal(row("turn-a").connectPreviousTool, false);
    handle({ type: "tool_call.ready", toolUse: { id: "turn-a", name: "file_read", input: { path: "a" } } });
    handle({ type: "tool_call.started", callId: "turn-b", name: "file_list" });
    assert.equal(row("turn-b").connectPreviousTool, true);
    handle({ type: "state", phase: "running_tools" });
    assert.equal(row("turn-b").connectPreviousTool, true);
    handle({ type: "message", message: createToolResultMessage({ id: "turn-b", name: "file_list", input: {} }, true, "done") });
    assert.equal(row("turn-b").connectPreviousTool, true, "results preserve the current group");
    handle({ type: "state", phase: "calling_model" });
    assert.equal(row("turn-b").connectPreviousTool, true);
    const sync = JSON.parse(chunks.filter(chunk => chunk.includes("\nevent: sync\n")).at(-1)!.split("data: ")[1]);
    assert.equal(sync.lines.find((line: { toolUseId: string }) => line.toolUseId === "turn-b").connectPreviousTool, true, "SSE retains membership for fixed frontend playback");
    handle({ type: "tool_call.started", callId: "turn-c", name: "file_read" });
    assert.equal(row("turn-c").connectPreviousTool, false);
    handle({ type: "tool_call.started", callId: "turn-d", name: "file_read" });
    assert.equal(row("turn-d").connectPreviousTool, true);
    handle({ type: "state", phase: "calling_model" });
    assert.equal(row("turn-d").connectPreviousTool, true, "new model calls do not erase existing membership");
    handle({ type: "tool_call.ready", toolUse: { id: "turn-e", name: "file_list", input: {} } });
    handle({ type: "tool_call.ready", toolUse: { id: "turn-f", name: "file_list", input: {} } });
    assert.equal(row("turn-f").connectPreviousTool, true, "nonstreaming ready calls also connect");
    handle({ type: "assistant.delta", text: "Actual reply" });
    assert.equal(row("turn-f").connectPreviousTool, true);
  } finally { response.emit("close"); }
});
