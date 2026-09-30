import assert from "node:assert/strict";
import test from "node:test";
import {
  findModelMetadata,
  reasoningEffortsForModel,
  resolveContextWindowTokens,
  supportsImageInput,
} from "../../src/model/context-window.js";

for (const model of ["gpt-6-sol", "gpt-6.1-sol"]) {
  test(`${model} has a 256k context and configured capabilities`, () => {
    const window = resolveContextWindowTokens(model, {});
    assert.equal(window.source, "known");
    assert.equal(window.tokens, 256000);
    assert.equal(window.model?.id, model);
    assert.equal(window.model?.provider, "openai");
    assert.equal(window.model?.maxOutputTokens, 128000);
    assert.equal(window.model?.reasoning, true);
    assert.equal(supportsImageInput(model), true);
    assert.deepEqual(reasoningEffortsForModel(model), ["none", "low", "medium", "high", "xhigh", "max"]);
    assert.equal(findModelMetadata(` ${model.toUpperCase()} `)?.id, model);
    assert.equal(findModelMetadata(`${model}-unknown`), undefined);
  });

  test(`${model} still respects context window environment overrides`, () => {
    assert.deepEqual(resolveContextWindowTokens(model, {
      MODEL_CONTEXT_WINDOW_TOKENS: "64000",
      OPENAI_CONTEXT_WINDOW_TOKENS: "128000",
    }), { tokens: 64000, source: "env" });
    assert.deepEqual(resolveContextWindowTokens(model, {
      OPENAI_CONTEXT_WINDOW_TOKENS: "128000",
    }), { tokens: 128000, source: "env" });
  });
}
