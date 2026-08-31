import assert from "node:assert/strict";
import type { AgentEvent } from "../types/events.js";
import { executeRunCommand, parseRunCliArgs, readRunPrompt, toJsonAgentEvent } from "./run-command.js";

const parsed = parseRunCliArgs(["--json", "--model", "gpt-5.6", "--reasoning=high", "fix", "tests"]);
assert.deepEqual(parsed, {
  ok: true,
  options: { json: true, model: "gpt-5.6", reasoning: "high", prompt: "fix tests" },
});
assert.equal(parseRunCliArgs(["--wat"]).ok, false);
assert.equal(parseRunCliArgs(["-"]).ok, true);

const pipedInput = Object.assign(
  (async function* () { yield " piped prompt\n"; })(),
  { isTTY: false },
) as unknown as import("./run-command.js").RunPromptInput;
assert.equal(await readRunPrompt(undefined, pipedInput), "piped prompt");

const errorEvent = toJsonAgentEvent({ type: "error", error: new TypeError("broken") }) as { error: { name: string; message: string } };
assert.equal(errorEvent.error.name, "TypeError");
assert.equal(errorEvent.error.message, "broken");

const events: AgentEvent[] = [
  { type: "assistant.delta", text: "hello" },
  { type: "assistant.delta", text: " world" },
  { type: "terminal", reason: "completed" },
];
const engine = {
  async *sendUserText(): AsyncGenerator<AgentEvent> {
    yield* events;
  },
};
let stdout = "";
let stderr = "";
const plain = await executeRunCommand(engine, "prompt", { json: false }, {
  stdout: { write: (chunk) => { stdout += chunk; } },
  stderr: { write: (chunk) => { stderr += chunk; } },
});
assert.deepEqual(plain, { exitCode: 0, terminalReason: "completed" });
assert.equal(stdout, "hello world\n");
assert.equal(stderr, "");

stdout = "";
const json = await executeRunCommand(engine, "prompt", { json: true }, {
  stdout: { write: (chunk) => { stdout += chunk; } },
  stderr: { write: () => undefined },
});
assert.equal(json.exitCode, 0);
const records = stdout.trim().split("\n").map((line) => JSON.parse(line) as AgentEvent);
assert.deepEqual(records.map((event) => event.type), ["assistant.delta", "assistant.delta", "terminal"]);

console.log("cli run smoke ok");
