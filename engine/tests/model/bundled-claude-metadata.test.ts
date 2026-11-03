import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { loadModelCatalog, validateModelCatalog, type ModelCatalog } from "../../src/model/context-window.js";
import { buildAnthropicRequest } from "../../src/model/anthropic-mapper.js";
import { createTextMessage } from "../../src/types/messages.js";

const home = mkdtempSync(path.join(tmpdir(), "neo-bundled-claude-"));
const previous = process.env.NEO_MODEL_CONFIG_DIR;
process.env.NEO_MODEL_CONFIG_DIR = home;
test.after(() => {
  if (previous === undefined) delete process.env.NEO_MODEL_CONFIG_DIR;
  else process.env.NEO_MODEL_CONFIG_DIR = previous;
  rmSync(home, { recursive: true, force: true });
});
const bundled = JSON.parse(readFileSync(new URL("../../src/model/model-metadata.json", import.meta.url), "utf8")) as ModelCatalog;
const ids = ["claude-fable-5-1", "claude-haiku-5-5", "claude-opus-5-5", "claude-sonnet-5-5"];
const efforts = ["low", "medium", "high", "xhigh", "max"];

test("bundled Claude catalog contains only current mainstream official IDs and verified limits", () => {
  validateModelCatalog(bundled);
  const models = bundled.models.filter(m => m.provider === "anthropic");
  assert.deepEqual(models.map(m => m.id), ids);
  for (const m of models) {
    assert.deepEqual(m.modelIds, [m.id]);
    assert.deepEqual(m.protocols, ["anthropic"]);
    assert.equal(m.contextWindowTokens, 256_000); // neo's configured usage ceiling, not the upstream maximum
    assert.equal(m.maxOutputTokens, 128_000);
    assert.equal(m.knowledgeCutoff, "2026-06");
    assert.equal(m.imageInput, true);
    assert.equal(m.reasoning, true);
    assert.deepEqual(m.reasoningEfforts, m.id === "claude-haiku-5-5" ? ["none", ...efforts] : efforts);
    assert.equal(bundled.sources?.[m.source!], "https://platform.claude.com/docs/en/models/overview");
  }
  assert.equal(bundled.sources?.["claude-effort"], "https://platform.claude.com/docs/en/build-with-claude/effort");
});

test("every advertised Claude effort maps to native parameters without silently changing the effort", () => {
  for (const model of loadModelCatalog().models.filter(m => m.provider === "anthropic")) {
    for (const effort of model.reasoningEfforts!) {
      const body = buildAnthropicRequest({ messages: [createTextMessage("user", "hello")], tools: [], stream: true, reasoning: { effort } }, { model: model.id });
      assert.deepEqual(body.thinking, effort === "none" ? { type: "disabled" } : { type: "adaptive", display: "summarized" });
      assert.deepEqual(body.output_config, effort === "none" ? undefined : { effort });
    }
    assert.throws(() => buildAnthropicRequest({ messages: [createTextMessage("user", "hello")], tools: [], stream: true, maxOutputTokens: 128_001 }, { model: model.id }), /max_tokens exceeds/);
    if (model.id !== "claude-haiku-5-5") {
      assert.throws(() => buildAnthropicRequest({ messages: [createTextMessage("user", "hello")], tools: [], stream: true, reasoning: null }, { model: model.id }), /cannot be disabled/);
    }
  }
});

test("existing catalogs preserve edits and old entries, append missing defaults, and respect explicit deletions", () => {
  const existing = structuredClone(bundled);
  const opus = existing.models.find(m => m.id === "claude-opus-5-5")!;
  opus.maxOutputTokens = 4096;
  opus.reasoningEfforts = ["high"];
  existing.models = existing.models.filter(m => !["claude-haiku-5-5", "claude-sonnet-5-5"].includes(m.id));
  existing.models.push({ id: "claude-legacy-user-entry", provider: "anthropic", modelIds: ["claude-legacy-user-entry"] });
  existing.excludedModelIds = ["claude-sonnet-5-5"];
  existing.sources = { "openai-models": "https://example.invalid/user-owned-source" };
  writeFileSync(path.join(home, "model-metadata.json"), JSON.stringify(existing));
  const module = pathToFileURL(path.resolve("src/model/context-window.ts")).href;
  const run = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `const {loadModelCatalog}=await import(${JSON.stringify(module)}); console.log(JSON.stringify(loadModelCatalog()))`], { encoding: "utf8", env: { ...process.env } });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout) as ModelCatalog;
  assert.deepEqual(result.models.find(m => m.id === opus.id), opus);
  assert.equal(result.sources?.["claude-models"], bundled.sources?.["claude-models"]);
  assert.equal(result.sources?.["claude-effort"], bundled.sources?.["claude-effort"]);
  assert.equal(result.sources?.["openai-models"], "https://example.invalid/user-owned-source");
  assert.ok(result.models.some(m => m.id === "claude-haiku-5-5"));
  assert.ok(result.models.some(m => m.id === "claude-legacy-user-entry"));
  assert.ok(!result.models.some(m => m.id === "claude-sonnet-5-5"));
  const resultIds = result.models.map(m => m.id);
  assert.deepEqual(resultIds, [...resultIds].sort((a, b) => a.localeCompare(b, "en", { numeric: true })));
});
