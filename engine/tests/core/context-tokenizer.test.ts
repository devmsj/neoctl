import test from "node:test";
import assert from "node:assert/strict";
import { encode } from "gpt-tokenizer";
import { estimateTextTokens, buildContextMetrics } from "../../src/core/context-metrics.js";
import { createTextMessage } from "../../src/types/messages.js";

test("ESM runtime really loads the tokenizer instead of silently falling back", () => {
  for (const text of ["hello world", "检查文件，继续运行。", '{"path":"test.txt","content":"alpha=7"}']) {
    assert.equal(estimateTextTokens(text), encode(text).length);
  }
  const metrics = buildContextMetrics({ model: "claude-haiku-5-5", contextWindowTokensOverride: 256000, messages: [createTextMessage("user", "hello")], systemPrompt: "test", tools: [] });
  assert.ok(metrics.estimatedInputTokens > 0);
  assert.equal(metrics.contextUsageRatio, metrics.estimatedInputTokens / 256000);
});
