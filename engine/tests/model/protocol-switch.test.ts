import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { inheritedModelReasoning, resolveModelReasoningUpdate } from "../../src/model/reasoning-switch.js";
import { buildAnthropicRequest } from "../../src/model/anthropic-mapper.js";
import { buildResponsesRequest } from "../../src/model/openai-responses-mapper.js";
import { buildChatRequest } from "../../src/model/openai-chat-mapper.js";
import { projectToolHistory } from "../../src/model/tool-history.js";
import { createTextMessage, createToolResultMessage, type Message } from "../../src/types/messages.js";
import { QueryEngine } from "../../src/core/query-engine.js";
import { ToolRegistry } from "../../src/tools/registry.js";

const home = mkdtempSync(path.join(os.tmpdir(), "neo-switch-test-"));
const previous = process.env.NEO_MODEL_CONFIG_DIR;
process.env.NEO_MODEL_CONFIG_DIR = home;
test.after(() => { if (previous === undefined) delete process.env.NEO_MODEL_CONFIG_DIR; else process.env.NEO_MODEL_CONFIG_DIR = previous; rmSync(home, { recursive: true, force: true }); });

test("inherited settings are adapted, explicit choices and same-model settings are not rewritten", () => {
  assert.equal(inheritedModelReasoning(null, "claude-opus-5-5"), undefined);
  assert.equal(inheritedModelReasoning(null, "claude-haiku-5-5"), null);
  const current = { effort: "high" as const, summary: "auto" as const };
  assert.deepEqual(inheritedModelReasoning(current, "claude-opus-5-5"), { effort: "high" });
  assert.equal(inheritedModelReasoning(current, "gpt-5.6-sol"), current);
  assert.deepEqual(resolveModelReasoningUpdate(undefined, current, "claude-opus-5-5", false), { reasoning: current, update: false });
  assert.deepEqual(resolveModelReasoningUpdate("off", current, "claude-opus-5-5", true), { reasoning: null, update: true });
  assert.deepEqual(current, { effort: "high", summary: "auto" });
});

test("engine-only model switches also adapt inherited settings without explicit overrides", async () => {
  const engine = new QueryEngine({ model: "gpt-5.6-sol", reasoning: { effort: "high", summary: "auto" }, tools: new ToolRegistry(), session: { enabled: false }, modelGateway: { async *stream() {} } });
  await engine.updateSessionSettings({ model: "claude-opus-5-5" });
  assert.deepEqual(engine.getModelSettings().reasoning, { effort: "high" });
  engine.setModel("gpt-5.6-sol", null, true);
  engine.setModel("claude-opus-5-5");
  assert.equal(engine.getModelSettings().reasoning, undefined);
});

for (const input of [[], null, "bad", 5, true]) test(`non-object history ${JSON.stringify(input)} is quoted in both protocols without mutation`, () => {
  const invalid = { id: "bad_call", name: "probe", input };
  const valid = { id: "good_call", name: "probe", input: { value: 7 } };
  const messages: Message[] = [createTextMessage("user", "Start"), {
    ...createTextMessage("assistant", "checking"), blocks: [{ type: "text", text: "checking" }, { type: "tool_use", ...invalid }, { type: "tool_use", ...valid }],
  }, createToolResultMessage(invalid, false, { error: "input must be an object" }), createToolResultMessage(valid, true, "7"), createTextMessage("user", "Continue")];
  const original = JSON.stringify(messages);
  const projected = projectToolHistory(messages);
  assert.equal(projected.flatMap(m => m.blocks).filter(b => b.type === "tool_use").length, 1);
  assert.equal(projected.flatMap(m => m.blocks).filter(b => b.type === "tool_result").length, 1);
  for (const body of [buildAnthropicRequest({ messages, tools: [], stream: false }, { model: "claude-haiku-5-5" }), buildResponsesRequest({ messages, tools: [], stream: false }, { model: "gpt-5.6-luna" }), buildChatRequest({ messages, tools: [], stream: false }, { model: "gpt-5.6-luna" })]) {
    const wire = JSON.stringify(body);
    assert.match(wire, /non-object arguments, quoted only, do not re-execute/);
    assert.match(wire, /recorded status: failure/);
    assert.match(wire, /good_call/);
  }
  const chat = buildChatRequest({ messages, tools: [], stream: false }, { model: "gpt-5.6-luna" }).messages as Array<{ role: string; tool_calls?: unknown[] }>;
  const callIndex = chat.findIndex(m => m.tool_calls?.length);
  assert.equal(chat[callIndex + 1].role, "tool", "quoted failures must not interrupt valid parallel results");
  assert.equal(JSON.stringify(messages), original);
  assert.deepEqual(projectToolHistory(projected), projected);
});

test("valid history remains the exact same object", () => {
  const messages = [createTextMessage("user", "hello")];
  assert.equal(projectToolHistory(messages), messages);
});
