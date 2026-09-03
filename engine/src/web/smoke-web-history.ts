import assert from "node:assert/strict";
import { createTextMessage, createThinkingMessage } from "../types/messages.js";
import type { SessionDisplayEntry } from "../session/session-store.js";
import { restoreWebHistoryLines, WebRepl } from "./index.js";

const oldReport = {
  reason: "manualcompact" as const,
  summary: "old summary",
  continuationState: "old continuation",
  sourceMessages: 10,
  preservedUserMessages: 2,
  newWindowMessages: 3,
  charsFreed: 100,
  modelDriven: true,
  imageCount: 0,
};
const newReport = {
  ...oldReport,
  summary: "new summary",
  continuationState: "new continuation",
  sourceMessages: 20,
  preservedUserMessages: 4,
  newWindowMessages: 5,
  charsFreed: 200,
};
const entries: SessionDisplayEntry[] = [
  { type: "message", message: createTextMessage("user", "user before first compact") },
  { type: "message", message: createThinkingMessage("assistant reasoning before first compact") },
  { type: "message", message: createTextMessage("assistant", "assistant before first compact") },
  { type: "compact", createdAt: "2026-09-03T06:12:17.756Z", reason: "manualcompact", report: oldReport },
  { type: "message", message: createTextMessage("user", "user between compacts") },
  { type: "message", message: createTextMessage("assistant", "assistant between compacts") },
  { type: "compact", createdAt: "2026-09-03T06:44:41.985Z", reason: "manualcompact", report: newReport },
  { type: "message", message: createTextMessage("assistant", "assistant after second compact") },
];

const lines = restoreWebHistoryLines({
  engine: {
    getDisplayEntries: () => entries,
  },
} as never) as Array<Record<string, any>>;
const compactions = lines.filter((line) => line.compaction);
const texts = lines.map((line) => line.text);

assert.deepEqual(texts, [
  "user before first compact",
  "assistant reasoning before first compact",
  "assistant before first compact",
  "3 message(s) in new window, 2 user message(s) preserved",
  "user between compacts",
  "assistant between compacts",
  "5 message(s) in new window, 4 user message(s) preserved",
  "assistant after second compact",
]);
assert.equal(lines[0]?.kind, "user");
assert.equal(lines[1]?.kind, "thinking");
assert.equal(lines[2]?.kind, "assistant");
assert.equal(lines[5]?.kind, "assistant");
assert.equal(lines[7]?.kind, "assistant");
assert.equal(compactions.length, 2);
assert.equal(compactions[0]?.compaction?.current, false);
assert.equal(compactions[1]?.compaction?.current, true);
assert.equal(compactions[0]?.compaction?.createdAt, "2026-09-03T06:12:17.756Z");
assert.equal(compactions[1]?.compaction?.createdAt, "2026-09-03T06:44:41.985Z");

const runtime = {
  engine: {
    getDisplayEntries: () => entries,
    snapshot: () => ({ session: { sessionId: "smoke" } }),
    isFastMode: () => false,
    getAppPrompt: () => ({ hasActivePrompt: false, activePrompt: undefined }),
    onSessionTitleChange: () => () => undefined,
  },
  usage: { snapshot: () => ({}), add: () => undefined, reset: () => undefined },
  taskStore: { subscribe: () => () => undefined, list: () => [] },
  execProcessManager: {
    subscribe: () => () => undefined,
    subscribeOutput: () => () => undefined,
    list: () => [],
  },
} as never;
const repl = new WebRepl(runtime);
const initialSnapshot = repl.snapshot(false);
const initialIds = initialSnapshot.lines.map((line) => line.id);
assert.equal(new Set(initialIds).size, initialIds.length);
const append = (repl as unknown as { append: (line: Record<string, unknown>) => number }).append.bind(repl);
const appendedId = append({ kind: "assistant", text: "live assistant after restore" });
const afterAppend = repl.snapshot(false);
assert.ok(appendedId > Math.max(...initialIds));
assert.equal(new Set(afterAppend.lines.map((line) => line.id)).size, afterAppend.lines.length);
assert.equal(afterAppend.lines.at(-1)?.kind, "assistant");

console.log("web history smoke ok");
