import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ModelSettingsStore, routeModel, resolveComposition, validateComposition, compositionModelConfig, type ApiConnection, type Composition } from "../../src/model/settings-store.js";
import { createCompositionGateway, compositionProviders } from "../../src/model/composition-runtime.js";

const home = mkdtempSync(path.join(tmpdir(), "neo-priority-"));
const previous = process.env.NEO_MODEL_CONFIG_DIR;
process.env.NEO_MODEL_CONFIG_DIR = home;
test.after(() => { if (previous === undefined) delete process.env.NEO_MODEL_CONFIG_DIR; else process.env.NEO_MODEL_CONFIG_DIR = previous; rmSync(home, { recursive: true, force: true }); });

const conn = (id: string, protocols: ApiConnection["protocols"], models: string[]): ApiConnection => ({ id, name: id, kind: protocols![0]!, protocols, baseUrl: `https://${id}.invalid`, key: "k", models });
const composition = (order: Composition["order"], main: string, image = "", search = ""): Composition => ({
  order, main: { api: "", model: main, effort: "high" }, image: { api: "", model: image },
  search: { api: "", model: search, toolType: "web_search", exa: false, exaUrl: "https://mcp.exa.ai/mcp", exaTool: "web_search_exa" },
});

test("top-most enabled connection that lists the model wins; disabled or unlisted connections are skipped", () => {
  const a = conn("a", ["openai"], ["gpt-6.1-sol", "gpt-image-2.5-sunburst"]), b = conn("b", ["openai", "anthropic"], ["gpt-6.1-sol", "claude-haiku-5-5"]);
  const c = composition([{ id: "a", enabled: true }, { id: "b", enabled: true }], "gpt-6.1-sol", "gpt-image-2.5-sunburst", "gpt-6.1-sol");
  assert.equal(routeModel("gpt-6.1-sol", c, [a, b])?.connection.id, "a");
  assert.deepEqual(routeModel("claude-haiku-5-5", c, [a, b]), { connection: b, protocol: "anthropic" }, "model metadata decides the protocol");
  const reordered = { ...c, order: [{ id: "b", enabled: true }, { id: "a", enabled: true }] };
  assert.equal(routeModel("gpt-6.1-sol", reordered, [a, b])?.connection.id, "b");
  const disabled = { ...c, order: [{ id: "a", enabled: false }, { id: "b", enabled: true }] };
  assert.equal(routeModel("gpt-6.1-sol", disabled, [a, b])?.connection.id, "b");
  assert.equal(routeModel("gpt-image-2.5-sunburst", disabled, [a, b]), undefined, "image model is not listed on b");
  const r = resolveComposition(c, [a, b]);
  assert.deepEqual([r.main.api, r.main.protocol, r.image.api, r.search.api], ["a", "responses", "a", "a"]);
  validateComposition(c, [a, b]);
  assert.throws(() => validateComposition(disabled, [a, b]), /图片生成：没有已启用的 API/);
});

test("search and image only use OpenAI-compatible routes; Anthropic main uses Messages", () => {
  const anth = conn("x", ["anthropic"], ["claude-haiku-5-5", "gpt-6.1-sol"]), oa = conn("y", ["openai"], ["gpt-6.1-sol"]);
  const c = composition([{ id: "x", enabled: true }, { id: "y", enabled: true }], "claude-haiku-5-5", "", "gpt-6.1-sol");
  assert.equal(routeModel("gpt-6.1-sol", c, [anth, oa], "openai")?.connection.id, "y");
  assert.equal(compositionModelConfig(c, [anth, oa])?.provider, "anthropic");
  assert.equal(compositionProviders(c, [anth, oa]).openai !== undefined, true);
});

test("session model switch routes to that model's own connection without failover", () => {
  const a = conn("a", ["openai"], ["gpt-6.1-sol"]), b = conn("b", ["anthropic"], ["claude-haiku-5-5"]);
  const c = composition([{ id: "a", enabled: true }, { id: "b", enabled: true }], "gpt-6.1-sol");
  const routed = createCompositionGateway(c, [a, b]);
  assert.equal(routed.config?.baseUrl, "https://a.invalid");
  assert.deepEqual(routed.heldConnections().filter(Boolean), ["a"]);
  routed.gateway.stream({ model: "claude-haiku-5-5", messages: [], tools: [], stream: true });
  assert.deepEqual(routed.heldConnections().filter(Boolean), ["b"]);
  assert.throws(() => routed.gateway.stream({ model: "claude-opus-5-5", messages: [], tools: [], stream: true }), /没有已启用的 API/);
});

test("legacy explicit-api state migrates to a priority list; apply snapshots enabled connections", () => {
  const dir = path.join(home, "legacy"); mkdirSync(dir, { recursive: true });
  const legacy = { version: 1, revision: "r1", connections: [{ id: "a", name: "A", kind: "openai", baseUrl: "https://a.invalid", key: "k" }, { id: "b", name: "B", kind: "openai", baseUrl: "https://b.invalid", key: "k" }],
    composition: { main: { api: "a", model: "gpt-6.1-sol", effort: "high" }, image: { api: "", model: "gpt-image-2.5-sunburst" }, search: { api: "a", model: "gpt-6.1-sol", toolType: "web_search", exa: true, exaUrl: "https://mcp.exa.ai/mcp", exaTool: "web_search_exa" } } };
  writeFileSync(path.join(dir, "model-settings.json"), JSON.stringify(legacy));
  const store = new ModelSettingsStore(dir);
  let s = store.read()!;
  assert.deepEqual(s.composition.order, [{ id: "a", enabled: true }, { id: "b", enabled: false }]);
  assert.ok(s.connections.every(x => x.models!.includes("gpt-6.1-sol") && x.models!.includes("gpt-image-2.5-sunburst") && !x.models!.includes("claude-haiku-5-5")), "first migration keeps the protocol-wide model list");
  s = store.saveConnection(s.revision, { ...s.connections[1]!, models: [] });
  assert.equal(s.composition.image.model, "", "image generation was off");
  s = store.apply(s.revision, s.composition);
  assert.deepEqual(s.applied!.connections.map(x => x.id), ["a"]);
  assert.equal(store.publicState(s).pendingConnections, false);
  s = store.saveConnection(s.revision, { ...s.connections[1]!, models: ["gpt-6.1-sol"] });
  assert.equal(store.publicState(s).pendingConnections, false, "disabled connection edits do not affect the applied plan");
  s = store.saveConnection(s.revision, { ...s.connections[0]!, key: "", models: [] });
  assert.equal(store.publicState(s).pendingConnections, true);
  const next = structuredClone(s.composition); next.order = [{ id: "a", enabled: true }, { id: "b", enabled: true }];
  s = store.apply(s.revision, next);
  assert.equal(s.applied!.composition.main.api, "b");
  const before = s.applied!.revision;
  s = store.removeConnection(s.revision, "b");
  assert.notEqual(s.applied!.revision, before);
  assert.equal(s.applied!.composition.main.api, "");
  assert.equal(s.applied!.composition.main.model, "gpt-6.1-sol");
});
