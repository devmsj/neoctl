import { agentSettingsBoundary } from "../../src/model/agent-settings-boundary.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { createTextMessage } from "../../src/types/messages.js";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ModelSettingsStore, connectionProtocols, compositionModelConfig, validateComposition, defaultComposition } from "../../src/model/settings-store.js";
import { findModelMetadata, saveModelMetadata, modelProtocols } from "../../src/model/context-window.js";
import { buildAnthropicRequest } from "../../src/model/anthropic-mapper.js";
import { createModelGatewayFromConfig } from "../../src/model/provider-factory.js";
import { registerSettingsConsumer, observeModelSettings, publishModelSettings, trackSettingsGateway } from "../../src/model/settings-sync.js";

const home = mkdtempSync(path.join(tmpdir(), "neo-protocols-"));
const previous = process.env.NEO_MODEL_CONFIG_DIR;
process.env.NEO_MODEL_CONFIG_DIR = home;
test.after(() => { if (previous === undefined) delete process.env.NEO_MODEL_CONFIG_DIR; else process.env.NEO_MODEL_CONFIG_DIR = previous; rmSync(home, { recursive: true, force: true }); });

test("legacy connection migration, dual protocols, immutable apply and explicit routing", () => {
  const store = new ModelSettingsStore();
  let s = store.initialize({ OPENAI_API_KEY: "test", OPENAI_MODEL: "gpt-6.1-sol" });
  assert.deepEqual(connectionProtocols(s.connections[0]!), ["openai"]);
  s = store.saveConnection(s.revision, { ...s.connections[0]!, protocols: ["openai", "anthropic"], baseUrl: "https://example.invalid/api" });
  const c = structuredClone(s.composition); c.main.protocol = "messages"; c.main.model = "claude-fable-5-1";
  c.image.api = c.main.api; c.search.api = c.main.api;
  validateComposition(c, s.connections);
  assert.equal(compositionModelConfig(c, s.connections)?.provider, "anthropic");
  assert.equal(compositionModelConfig(c, s.connections)?.baseUrl, "https://example.invalid/api");
  s = store.apply(s.revision, c);
  const old = structuredClone(s.applied);
  s = store.saveConnection(s.revision, { ...s.connections[0]!, protocols: ["openai"] });
  assert.deepEqual(s.applied, old);
  assert.throws(() => validateComposition(c, s.connections), /接口/);
  assert.throws(() => store.saveConnection(s.revision, { ...s.connections[0]!, protocols: [] }), /接口/);
});

test("custom effort values persist without enum filtering and adaptive Messages forwards them", () => {
  const original = structuredClone(findModelMetadata("claude-fable-5-1")!);
  const entry = { ...original, protocols: ["openai", "anthropic"] as Array<"openai" | "anthropic">, reasoningEfforts: ["high", "ultra-v2"] };
  saveModelMetadata(entry, original);
  assert.deepEqual(findModelMetadata(entry.id)?.reasoningEfforts, ["high", "ultra-v2"]);
  assert.deepEqual(modelProtocols(findModelMetadata(entry.id)!), ["openai", "anthropic"]);
  assert.ok(readFileSync(path.join(home, "model-metadata.json"), "utf8").includes("ultra-v2"));
  const request = { model: entry.id, messages: [createTextMessage("user", "hello")], tools: [], stream: true, reasoning: { effort: "ultra-v2" } };
  assert.deepEqual(buildAnthropicRequest(request, { model: entry.id }).output_config, { effort: "ultra-v2" });
  assert.throws(() => saveModelMetadata({ ...entry, reasoningEfforts: ["bad value"] }, entry), /档位/);
  assert.throws(() => saveModelMetadata({ ...entry, reasoningEfforts: ["off"] }, entry), /档位/);
  const gateway = createModelGatewayFromConfig({ provider: "openai", apiKey: "test", model: entry.id, baseUrl: "https://example.invalid" });
  saveModelMetadata({ ...entry, reasoningEfforts: ["high"] }, entry);
  assert.throws(() => gateway.stream(request), /重新选择/);
});

test("compatibility uses explicit metadata rather than vendor; sync reports running consumers", () => {
  saveModelMetadata({ id: "deepseek-custom", provider: "deepseek", protocols: ["openai"], modelIds: ["deepseek-custom"], reasoning: true, reasoningEfforts: ["ultra"] });
  const c = defaultComposition(); c.main = { api: "a", protocol: "responses", model: "deepseek-custom", effort: "ultra" };
  const api = { id: "a", kind: "openai" as const, name: "a", baseUrl: "https://example.invalid", key: "test" };
  validateComposition(c, [api]);
  c.main.protocol = "messages";
  assert.throws(() => validateComposition(c, [{ ...api, protocols: ["openai", "anthropic"] }]), /模型不支持/);
  let running = true, idleRefresh = 0, busyRefresh = 0, notices = 0;
  const idle = { isModelConfigurationBusy: () => false, refreshModelConfigurationIfIdle: () => { idleRefresh++; } };
  const busy = { isModelConfigurationBusy: () => running, refreshModelConfigurationIfIdle: () => { busyRefresh++; } };
  const listener = () => { notices++; };
  registerSettingsConsumer(idle); registerSettingsConsumer(busy); observeModelSettings(listener);
  assert.deepEqual(publishModelSettings(), { deferred: true, runningSessions: 1 });
  assert.equal(idleRefresh, 1); assert.equal(busyRefresh, 0); assert.equal(notices, 1);
  running = false;
  assert.deepEqual(publishModelSettings(), { deferred: false, runningSessions: 0 });
  assert.equal(busyRefresh, 1);
});

test("child boundary adopts new plan without mutating original tools", () => {
  const store = new ModelSettingsStore();
  let s = store.read()!;
  const boundary = agentSettingsBoundary(); boundary.start();
  assert.equal(boundary.beforeTurn(), undefined);
  const c = structuredClone(s.composition); c.main.protocol = "responses"; c.main.model = "deepseek-custom"; c.main.effort = "ultra";
  c.image.api = ""; c.search.api = ""; c.search.exa = false;
  s = store.apply(s.revision, c);
  assert.equal(publishModelSettings().deferred, true);
  const update = boundary.beforeTurn();
  assert.equal(update?.settings?.model, "deepseek-custom");
  assert.equal(update?.settings?.reasoning?.effort, "ultra");
  assert.ok(update?.modelGateway);
  const tools = new ToolRegistry(); const snapshot = boundary.tools(tools);
  assert.notEqual(snapshot, tools);
  boundary.stop();
  assert.equal(publishModelSettings().deferred, false);
});

test("new child catches an application made after the parent request started", () => {
  const store = new ModelSettingsStore();
  let s = store.read()!;
  const parentGateway = trackSettingsGateway({ async *stream() {} }, s.applied?.revision);
  const c = structuredClone(s.composition);
  s = store.apply(s.revision, c);
  const boundary = agentSettingsBoundary(parentGateway);
  assert.equal(boundary.beforeTurn()?.settings?.model, c.main.model);
  assert.ok(boundary.beforeTurn()?.modelGateway);
});
