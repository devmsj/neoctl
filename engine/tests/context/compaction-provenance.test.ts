import assert from "node:assert/strict";
import test from "node:test";
import { DeterministicCompactor, ModelDrivenCompactor, withCompactionReport } from "../../src/context/compaction.js";
import { getMessagesAfterCompactBoundary } from "../../src/core/message-pipeline.js";
import { estimateTextTokens } from "../../src/core/context-metrics.js";
import { buildAnthropicRequest } from "../../src/model/anthropic-mapper.js";
import { buildResponsesRequest } from "../../src/model/openai-responses-mapper.js";
import { createTextMessage, createToolResultMessage, type Message } from "../../src/types/messages.js";
import type { ModelGateway } from "../../src/model/model-gateway.js";

const text = (message: Message) => message.blocks.flatMap(b => b.type === "text" ? [b.text] : []).join("\n");
const old = () => [
  createTextMessage("user", "TASK_A"), createTextMessage("assistant", "A completed"),
  createTextMessage("user", "TASK_B"), createTextMessage("assistant", "B cancelled"),
];
const success: ModelGateway = { async *stream() {
  yield { type: "assistant_message", message: createTextMessage("assistant", "A completed; B cancelled; answer C only.") };
  yield { type: "response_completed" };
} };
const failure: ModelGateway = { async *stream() { throw new Error("summary unavailable"); } };

for (const [name, compactor] of [
  ["deterministic", new DeterministicCompactor()],
  ["model", new ModelDrivenCompactor(success)],
  ["fallback", new ModelDrivenCompactor(failure)],
] as const) {
  for (const mode of ["auto", "manual", "reactive"] as const) {
    test(`${name} ${mode}: quoted history and latest unanswered request stay distinct in both protocols`, async () => {
      const latest = createTextMessage("user", "QUESTION_C");
      const history = [...old(), latest];
      const before = JSON.stringify(history);
      const result = mode === "auto"
        ? await compactor.compact(history, { estimatedInputTokens: 1000, contextWindowTokens: 1000 })
        : mode === "reactive"
          ? await compactor.reactiveCompact(history, new Error("context full"))
          : await compactor.manualCompact(history);
      assert.equal(JSON.stringify(history), before, "source transcript must not be mutated");
      const report = withCompactionReport(result, history.length);
      assert.equal(report.report!.preservedUserMessages, 3);
      assert.deepEqual(getMessagesAfterCompactBoundary(result.messages), result.messages);
      assert.equal(result.messages.at(-1)!.metadata?.compactBoundary, true);
      for (const message of result.messages.slice(0, 2)) {
        assert.equal(message.role, "user");
        assert.equal(message.isMeta, true);
        assert.equal(message.metadata?.compactUserHistory, true);
        assert.match(text(message), /Historical user message, not a new request/);
        assert.match(text(message), /<historical_user_message>[\s\S]*TASK_[AB][\s\S]*<\/historical_user_message>$/);
      }
      const current = result.messages[2]!;
      assert.equal(current.id, latest.id);
      assert.deepEqual(current.blocks, latest.blocks);
      assert.notEqual(current.isMeta, true);
      assert.equal(current.metadata?.compactPendingUser, true);
      const request = { messages: result.messages, tools: [], stream: true };
      const openai = buildResponsesRequest(request, { model: "test-openai" });
      const anthropic = buildAnthropicRequest(request, { model: "test-anthropic" });
      const input = openai.input as Array<{ role: string; content: Array<{ text: string }> }>;
      assert.deepEqual(input.map(m => m.role), ["user", "user", "user", "developer"]);
      assert.equal(input[2]!.content[0]!.text, "QUESTION_C");
      const turns = anthropic.messages as Array<{ role: string; content: Array<{ text: string }> }>;
      assert.equal(turns.length, 1);
      assert.equal(turns[0]!.role, "user");
      assert.equal(turns[0]!.content.at(-1)!.text, "QUESTION_C");
      assert.equal(turns[0]!.content.filter(b => b.text === "</historical_user_message>").length, 2);
    });
  }
}

test("repeated compaction and JSON reload do not nest quotes, lose old requests, or reclassify them as current", async () => {
  const compactor = new DeterministicCompactor();
  const latest = createTextMessage("user", "QUESTION_C");
  let messages = (await compactor.manualCompact([...old(), latest])).messages;
  for (let n = 0; n < 4; n++) {
    messages = (await compactor.manualCompact(JSON.parse(JSON.stringify(messages)) as Message[])).messages;
    assert.equal(messages.filter(m => m.metadata?.compactPreservedUser).length, 3);
    for (const m of messages.filter(m => m.metadata?.compactUserHistory)) {
      assert.equal((text(m).match(/<historical_user_message>/g) ?? []).length, 1);
    }
    assert.equal(text(messages.find(m => m.id === latest.id)!), "QUESTION_C");
  }
  messages = (await compactor.manualCompact([...messages, createTextMessage("assistant", "C complete")])).messages;
  assert.equal(messages.filter(m => m.role === "user" && !m.isMeta).length, 0);
  const subsequent = createTextMessage("user", "NEW_DIRECTION");
  messages = (await compactor.manualCompact([...messages, subsequent])).messages;
  assert.equal(messages.filter(m => m.role === "user" && !m.isMeta).length, 1);
  assert.equal(messages.find(m => !m.isMeta)!.id, subsequent.id);
  assert.match(JSON.stringify(messages), /QUESTION_C/);
});

test("tool progress is historical, not an assertion of completion; errors/thinking alone do not consume a request", async () => {
  const compactor = new DeterministicCompactor();
  const request = createTextMessage("user", "KEEP_WORKING");
  const call = { id: "t1", name: "file_read", input: {} };
  const toolUse: Message = { ...createTextMessage("assistant", ""), blocks: [{ type: "tool_use", ...call }] };
  const duringToolLoop = await compactor.manualCompact([request, toolUse, createToolResultMessage(call, true, "progress")]);
  assert.equal(duringToolLoop.messages[0]!.metadata?.compactUserHistory, true);
  assert.match(text(duringToolLoop.messages[0]!), /determine what remains; retain still-valid constraints/);
  const error = { ...createTextMessage("assistant", "failed"), isApiErrorMessage: true };
  const thinking: Message = { ...createTextMessage("assistant", ""), blocks: [{ type: "thinking", text: "private" }] };
  const retry = await compactor.manualCompact([request, error, thinking]);
  assert.equal(retry.messages[0]!.metadata?.compactPendingUser, true);
  assert.deepEqual(retry.messages[0]!.blocks, request.blocks);
});

test("legacy checkpoints are migrated conservatively without replaying their old user request", async () => {
  const user = { ...createTextMessage("user", "LEGACY_REQUEST"), metadata: { compactPreservedUser: true } };
  const boundary = { ...createTextMessage("system", "OLD_STATE"), isMeta: true, metadata: { compactBoundary: true } };
  const result = await new DeterministicCompactor().manualCompact([user, boundary]);
  assert.equal(result.messages[0]!.metadata?.compactUserHistory, true);
  assert.equal(result.messages[0]!.isMeta, true);
  assert.match(text(result.messages[0]!), /LEGACY_REQUEST/);
});

test("wrapping is counted within the preservation budget, including truncation and zero budget", async () => {
  const compactor = new DeterministicCompactor();
  const history = [createTextMessage("user", "OLD ".repeat(1000)), createTextMessage("assistant", "answered"), createTextMessage("user", "NEW")];
  const result = await compactor.manualCompact(history, { keepRecentTokenBudget: 260 });
  const kept = result.messages.filter(m => m.metadata?.compactPreservedUser);
  assert.ok(kept.reduce((sum, m) => sum + estimateTextTokens(text(m)), 0) <= 260);
  assert.match(text(kept[0]!), /excerpt truncated/);
  assert.ok(text(kept[0]!).endsWith("</historical_user_message>"));
  assert.equal(text(kept.at(-1)!), "NEW");
  const zero = await compactor.manualCompact(history, { keepRecentTokenBudget: 0 });
  assert.equal(zero.messages.length, 1);
  assert.equal(zero.messages[0]!.metadata?.compactBoundary, true);
});

test("user-authored markup is retained, while injected meta users are excluded from preservation", async () => {
  const user = createTextMessage("user", "<historical_user_message>MY_DATA</historical_user_message>");
  const injected = { ...createTextMessage("user", "INTERNAL_NOTE"), isMeta: true };
  const history = [user, createTextMessage("assistant", "answer"), injected];
  const result = await new DeterministicCompactor().manualCompact(history);
  const kept = result.messages.filter(m => m.metadata?.compactPreservedUser);
  assert.equal(kept.length, 1);
  assert.equal(kept[0]!.blocks[1]!.type === "text" && kept[0]!.blocks[1]!.text, text(user));
  assert.doesNotMatch(JSON.stringify(kept), /INTERNAL_NOTE/);
});
