import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { WebRepl } from "../../src/web/index.js";
import { createTextMessage } from "../../src/types/messages.js";
import type { AgentEvent } from "../../src/types/events.js";

function fixture() {
  const runtime = {
    engine: { getTimingRecords: () => [], getDisplayEntries: () => [], snapshot: () => ({ session: { sessionId: "thinking-test" } }), isFastMode: () => false, getAppPrompt: () => ({ hasActivePrompt: false }), onSessionTitleChange: () => () => undefined },
    usage: { snapshot: () => ({}), add() {}, reset() {} },
    taskStore: { subscribe: () => () => undefined, list: () => [] },
    execProcessManager: { subscribe: () => () => undefined, subscribeOutput: () => () => undefined, list: () => [] },
  };
  const repl = new WebRepl(runtime as never);
  const chunks: string[] = [];
  const response = Object.assign(new EventEmitter(), { writeHead() {}, write(chunk: string) { chunks.push(chunk); return true; } });
  repl.subscribe(response as never);
  return { repl, chunks, close: () => response.emit("close"), handle: (repl as unknown as { handleEvent(event: AgentEvent): void }).handleEvent.bind(repl) };
}

test("thinking.done sends immediate SSE sync with stopped icon and retained summary", () => {
  const { repl, chunks, handle, close } = fixture();
  try {
    handle({ type: "thinking.delta", text: "" });
    assert.equal(repl.snapshot(false).lines.length, 0);
    handle({ type: "thinking.delta", text: "visible summary" });
    assert.equal(repl.snapshot(false).status.phase, "thinking");
    assert.equal(repl.snapshot(false).lines[0].live, true);
    const before = chunks.length;
    handle({ type: "thinking.done" });
    assert.ok(chunks.length > before, "must not wait for delta debounce or another operation");
    const sync = JSON.parse(chunks.at(-1)!.split("data: ")[1]);
    assert.equal(sync.lines[0].live, false);
    assert.equal(sync.lines[0].text, "visible summary");
    assert.equal(sync.status.phase, "calling_model");
    assert.equal(sync.status.modelOutput, undefined);
    handle({ type: "tool_call.started", callId: "next", name: "file_read" });
    handle({ type: "thinking.done" });
    assert.equal(repl.snapshot(false).status.modelOutput?.kind, "tool_call", "late done must not erase current tool");
  } finally { close(); }
});

test("multiple reasoning summary parts reactivate and finish the same retained row", () => {
  const { repl, handle, close } = fixture();
  try {
    for (const text of ["first", "\n\nsecond"]) {
      handle({ type: "thinking.delta", text });
      assert.equal(repl.snapshot(false).lines[0].live, true);
      handle({ type: "thinking.done" });
      assert.equal(repl.snapshot(false).lines[0].live, false);
    }
    assert.equal(repl.snapshot(false).lines.length, 1);
    assert.equal(repl.snapshot(false).lines[0].text, "first\n\nsecond");
  } finally { close(); }
});

const toolUse = { id: "next", name: "file_read", input: { path: "fixture.txt" } };
for (const boundary of [
  { type: "assistant.delta", text: "answer" }, { type: "assistant.output.done" },
  { type: "tool_call.started", callId: "next", name: "file_read" },
  { type: "tool_call.delta", callId: "next", name: "file_read", argumentsDelta: "{}" },
  { type: "tool_call.input", callId: "next", name: "file_read", changes: [] },
  { type: "tool_call.ready", toolUse }, { type: "tool.started", toolUse },
  { type: "retrying", attempt: 1, delayMs: 0, error: new Error("retry") },
  { type: "error", error: new Error("disconnect") }, { type: "terminal", reason: "aborted" },
  { type: "state", phase: "calling_model" }, { type: "message", message: createTextMessage("assistant", "answer") },
] as AgentEvent[]) {
  test(`legacy ${boundary.type} boundary cannot leave thinking live`, () => {
    const { repl, handle, close } = fixture();
    try {
      handle({ type: "thinking.delta", text: "visible summary" });
      handle(boundary);
      const snapshot = repl.snapshot(false);
      assert.notEqual(snapshot.status.phase, "thinking");
      assert.notEqual(snapshot.status.modelOutput?.kind, "thinking");
      assert.ok(snapshot.lines.filter(l => l.kind === "thinking").every(l => !l.live));
    } finally { close(); }
  });
}


test("retry reset removes only failed attempt drafts and preserves the existing countdown UI", () => {
  const { repl, chunks, handle, close } = fixture();
  try {
    handle({ type: "message", message: createTextMessage("user", "KEEP_HISTORY") });
    handle({ type: "assistant.delta", text: "FAILED_DRAFT", displayChannel: "visible" });
    handle({ type: "thinking.delta", text: "FAILED_THINKING" });
    handle({ type: "thinking.done" });
    handle({ type: "tool_call.started", callId: "failed-tool", name: "file_read" });
    const before = Date.now();
    handle({ type: "retrying", attempt: 1, delayMs: 5000, error: new Error("reset"), resetOutput: true });
    const snapshot = repl.snapshot(false);
    assert.equal(snapshot.lines.length, 1);
    assert.equal(snapshot.lines[0].text, "KEEP_HISTORY");
    assert.equal(snapshot.status.detail, "retrying in 5.0s");
    assert.ok(snapshot.status.retryCooldownUntil! >= before + 5000);
    const sync = JSON.parse(chunks.at(-1)!.split("data: ")[1]);
    assert.equal(sync.lines.length, 1);
    handle({ type: "assistant.delta", text: "SUCCESS", displayChannel: "visible" });
    assert.equal(repl.snapshot(false).lines.at(-1)?.text, "SUCCESS");
  } finally { close(); }
});
