import assert from "node:assert/strict";
import test from "node:test";
import { WebRepl } from "../../src/web/index.js";
import { ModelAPIError } from "../../src/model/errors.js";
import type { AgentEvent } from "../../src/types/events.js";

function repl() {
  return new WebRepl({
    engine: { getTimingRecords: () => [], getDisplayEntries: () => [], snapshot: () => ({ session: { sessionId: "retry-test" } }), isFastMode: () => false, getAppPrompt: () => ({ hasActivePrompt: false }), onSessionTitleChange: () => () => undefined },
    usage: { snapshot: () => ({}), add: () => undefined, reset: () => undefined },
    taskStore: { subscribe: () => () => undefined, list: () => [] },
    execProcessManager: { subscribe: () => () => undefined, subscribeOutput: () => () => undefined, list: () => [] },
  } as never);
}

test("every retry shows its reason with the same line shape as the final error", () => {
  const web = repl();
  const handle = (web as unknown as { handleEvent(event: AgentEvent): void }).handleEvent.bind(web);
  const error = (message: string) => new ModelAPIError({ provider: "openai", category: "rate_limit", status: 429, message });
  handle({ type: "assistant.delta", text: "partial draft" });
  handle({ type: "retrying", attempt: 1, delayMs: 5000, error: error("429 first"), resetOutput: true });
  handle({ type: "retrying", attempt: 2, delayMs: 10000, error: error("429 second") });
  handle({ type: "error", error: error("429 final") });
  const lines = web.snapshot(false).lines as unknown as Array<Record<string, unknown>>;
  assert.equal(lines.some(line => line.text === "partial draft"), false, "failed attempt draft is still discarded");
  const errors = lines.filter(line => line.kind === "error").map(({ id: _id, ...line }) => line);
  assert.deepEqual(errors, [
    { kind: "error", text: "429 first" },
    { kind: "error", text: "429 second" },
    { kind: "error", text: "429 final" },
  ]);
  assert.equal(web.snapshot(false).status.detail, "retrying in 10.0s", "countdown status is unchanged");
});
