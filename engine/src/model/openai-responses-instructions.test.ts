import assert from "node:assert/strict";
import test from "node:test";
import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from "../context/prompts.js";
import { createTextMessage } from "../types/messages.js";
import type { ModelRequest } from "./model-gateway.js";
import { buildResponsesRequest } from "./openai-responses-mapper.js";

const prompt = `## Stable\nstable rules\n\n${SYSTEM_PROMPT_DYNAMIC_BOUNDARY}\n\n## Runtime\nagentId=main`;
const renderedPrompt = "## Stable\nstable rules\n\n## Runtime\nagentId=main";

function build(overrides: Partial<ModelRequest> = {}, model = "gpt-5.6") {
  return buildResponsesRequest({
    messages: [createTextMessage("user", "hello")],
    tools: [],
    stream: true,
    systemPrompt: prompt,
    ...overrides,
  }, { model });
}

for (const model of ["gpt-5.6", "gpt-5.2"]) {
  test(`${model}: sends stable and dynamic prompt only through instructions`, () => {
    const body = build({}, model);
    assert.equal(body.instructions, renderedPrompt);
    assert.deepEqual(body.input, [{ role: "user", content: [{ type: "input_text", text: "hello" }] }]);
    assert.ok(!JSON.stringify(body).includes(SYSTEM_PROMPT_DYNAMIC_BOUNDARY));
    assert.equal(typeof body.prompt_cache_key, "string");
  });
}

test("explicit instructions take precedence over systemPrompt, including an empty override", () => {
  assert.equal(build({ instructions: "explicit rules" }).instructions, "explicit rules");
  const empty = build({ instructions: "" });
  assert.ok(!Object.hasOwn(empty, "instructions"));
  assert.ok(!JSON.stringify(empty.input).includes("stable rules"));
});

test("absent, empty and dynamic-only prompts are supported", () => {
  assert.ok(!Object.hasOwn(build({ systemPrompt: undefined }), "instructions"));
  assert.ok(!Object.hasOwn(build({ systemPrompt: "" }), "instructions"));
  assert.equal(build({ systemPrompt: `${SYSTEM_PROMPT_DYNAMIC_BOUNDARY}\n\nruntime only` }).instructions, "runtime only");
  assert.equal(build({ systemPrompt: "stable only" }).instructions, "stable only");
});

test("previous_response_id continuations resend the complete instructions", () => {
  const body = build({ previousResponseId: "resp_previous" });
  assert.equal(body.previous_response_id, "resp_previous");
  assert.equal(body.instructions, renderedPrompt);
});

test("runtime context and historical system messages remain in input", () => {
  const runtime = {
    ...createTextMessage("user", "project memory"),
    isMeta: true,
    metadata: { runtimeContext: true, cacheStableRuntimeContext: true },
  };
  const body = build({ messages: [
    runtime,
    createTextMessage("system", "Internal continuation state"),
    createTextMessage("user", "hello"),
  ] });
  assert.equal(body.instructions, renderedPrompt);
  assert.deepEqual(body.input, [
    { role: "user", content: [{ type: "input_text", text: "project memory", prompt_cache_breakpoint: { mode: "explicit" } }] },
    { role: "developer", content: [{ type: "input_text", text: "Internal continuation state" }] },
    { role: "user", content: [{ type: "input_text", text: "hello" }] },
  ]);
  assert.deepEqual(body.prompt_cache_options, { mode: "implicit" });
  const withoutExplicitCaching = build({ messages: [runtime] }, "gpt-5.2");
  assert.ok(!JSON.stringify(withoutExplicitCaching).includes("prompt_cache_breakpoint"));
});
