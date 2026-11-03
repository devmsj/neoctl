import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { ModelSettingsStore, defaultComposition, validateComposition, supportedEfforts, compositionModelConfig } from "../../src/model/settings-store.js";
import { loadModelCatalog, saveModelMetadata, findModelMetadata } from "../../src/model/context-window.js";
import { compositionProviders, registerCompositionTools } from "../../src/model/composition-runtime.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { handleModelSettingsRequest, testModelComposition } from "../../src/web/model-settings-api.js";

const home = mkdtempSync(path.join(tmpdir(), "neo-model-settings-"));
const previous = process.env.NEO_MODEL_CONFIG_DIR;
process.env.NEO_MODEL_CONFIG_DIR = home;
test.after(() => { if (previous === undefined) delete process.env.NEO_MODEL_CONFIG_DIR; else process.env.NEO_MODEL_CONFIG_DIR = previous; rmSync(home, { recursive: true, force: true }); });
const api = { id: "a", name: "custom", kind: "openai" as const, key: "test-key", baseUrl: "http://127.0.0.1:1/v1" };
const main = () => ({ ...defaultComposition(), main: { api: "a", model: "gpt-4.1-mini", effort: "high" } });

test("metadata initializes, preserves edits, naturally sorts and hot reloads", () => {
  const file = path.join(home, "model-metadata.json");
  writeFileSync(file, JSON.stringify({ models: [{ id: "custom10", provider: "custom", modelIds: ["custom10"], imageInput: false }, { id: "custom2", provider: "custom", modelIds: ["custom2"], imageInput: false }] }));
  saveModelMetadata({ id: "gpt-4.1-mini", provider: "openai", modelIds: ["gpt-4.1-mini"], reasoning: false, imageInput: true });
  const catalog = loadModelCatalog();
  assert.ok(catalog.models.length > 2);
  assert.ok(catalog.models.findIndex(m => m.id === "custom2") < catalog.models.findIndex(m => m.id === "custom10"));
  const original = structuredClone(findModelMetadata("custom2")!);
  saveModelMetadata({ ...original, imageInput: true }, original);
  assert.equal(findModelMetadata("custom2")?.imageInput, true);
  assert.throws(() => saveModelMetadata({ ...original, imageInput: false }, original), /更新/);
  assert.throws(() => saveModelMetadata({ id: "duplicate", provider: "custom", modelIds: ["custom2"] }), /重复/);
  const disk = JSON.parse(readFileSync(file, "utf8"));
  disk.models.find((m: { id: string }) => m.id === "custom2").imageInput = false;
  writeFileSync(file, JSON.stringify(disk));
  assert.equal(findModelMetadata("custom2")?.imageInput, false);
});

test("API archives preserve keys; apply is immutable; revisions prevent lost updates", () => {
  const store = new ModelSettingsStore(path.join(home, "store"));
  let state = store.initialize({ OPENAI_API_KEY: "original", OPENAI_MODEL: "gpt-4.1-mini" });
  assert.equal(state.applied, undefined);
  assert.equal(store.publicState(state).pendingConnections, true);
  state = store.apply(state.revision, state.composition);
  const applied = JSON.parse(JSON.stringify(state.applied));
  assert.equal(store.publicState(state).pendingConnections, false);
  const revision = state.revision;
  state = store.saveConnection(state.revision, { ...state.connections[0]!, name: "renamed", key: "" });
  assert.equal(state.connections[0]?.key, "original");
  assert.deepEqual(state.applied, applied);
  assert.equal(store.publicState(state).pendingConnections, true);
  assert.throws(() => store.saveConnection(revision, state.connections[0]!), /更新/);
  assert.throws(() => store.removeConnection(state.revision, "openai"), /引用/);
  assert.equal(JSON.stringify(store.publicState(state)).includes('"key":'), false);
});

test("protocol/capability validation, reasoning and output constraints", () => {
  const c = main();
  validateComposition(c, [api]);
  assert.equal(compositionModelConfig(c, [api])?.defaultReasoning, null);
  c.main.model = "unknown-model";
  assert.throws(() => validateComposition(c, [api]), /推理/);
  c.main.model = "claude-sonnet-5-5";
  validateComposition(c, [{ ...api, kind: "anthropic" }]);
  assert.ok(!supportedEfforts(c.main.model, "anthropic").includes("minimal"));
  c.image.api = "a";
  assert.throws(() => validateComposition(c, [{ ...api, kind: "anthropic" }]), /OpenAI/);
  c.image.api = "";
  c.main = { ...c.main, tokens: "0" } as typeof c.main;
  assert.throws(() => validateComposition(c, [{ ...api, kind: "anthropic" }]), /整数/);
});

test("image and search are independently available with an Anthropic main connection", () => {
  const c = main(); c.main.model = "claude-sonnet-5-5"; c.image.api = "b"; c.search.api = "b";
  const connections = [{ ...api, kind: "anthropic" as const }, { ...api, id: "b" }];
  validateComposition(c, connections);
  const tools = new ToolRegistry(); registerCompositionTools(tools, c, connections);
  assert.ok(tools.get("image_create")); assert.ok(tools.get("web_search"));
  tools.setEnabled("image_create", false); registerCompositionTools(tools, c, connections);
  assert.equal(tools.isEnabled("image_create"), false);
  c.image.api = ""; c.search.api = ""; c.search.exa = false;
  registerCompositionTools(tools, c, connections);
  assert.equal(tools.get("image_create"), undefined); assert.equal(tools.get("web_search"), undefined);
});

async function mock(handler: import("node:http").RequestListener) {
  const server = createServer(handler); server.listen(0, "127.0.0.1"); await once(server, "listening");
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

test("real HTTP detection verifies native Responses tool continuation and rejects fake success", async () => {
  let calls = 0;
  const server = await mock(async (req: any, res: any) => {
    let text = ""; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text); calls++;
    assert.equal(req.url, "/v1/responses"); assert.equal(req.headers.authorization, "Bearer test-key");
    assert.equal(body.model, "gpt-4.1-mini");
    const tool = { type: "function_call", id: "fc_1", call_id: "call_1", name: "configuration_probe", arguments: '{"value":7}', status: "completed" };
    const message = { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "7", annotations: [] }] };
    if (calls === 2) assert.ok(body.input.some((x: any) => x.type === "function_call_output"));
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const events = calls === 1 ? [
      { type: "response.output_item.added", output_index: 0, item: { ...tool, arguments: "" } },
      { type: "response.function_call_arguments.done", item_id: "fc_1", output_index: 0, arguments: tool.arguments },
      { type: "response.output_item.done", output_index: 0, item: tool },
      { type: "response.completed", response: { id: "r1", status: "completed", output: [tool] } },
    ] : [{ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "7" }, { type: "response.completed", response: { id: "r2", status: "completed", output: [message] } }];
    res.end(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(""));
  });
  try {
    const results = await testModelComposition(main(), [{ ...api, baseUrl: server.url + "/v1" }], ["main"], false);
    assert.equal(results[0]?.ok, true, JSON.stringify(results)); assert.equal(calls, 2);
  } finally { await server.close(); }
});

test("search probe requires a real web_search call and sources, independent of main settings", async () => {
  let real = false;
  const server = await mock(async (req: any, res: any) => {
    for await (const _ of req) { /* drain */ }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ output: [...(real ? [{ type: "web_search_call", status: "completed" }] : []), { type: "message", content: [{ type: "output_text", text: "API docs", annotations: [{ type: "url_citation", url: "https://platform.openai.com/docs", title: "Docs" }] }] }] }));
  });
  try {
    const c = main(); c.main.model = "unknown"; c.search.api = "a";
    const connections = [{ ...api, baseUrl: server.url }];
    assert.equal((await testModelComposition(c, connections, ["search"], false))[0]?.ok, false);
    real = true; assert.equal((await testModelComposition(c, connections, ["search"], false))[0]?.ok, true);
    await assert.rejects(testModelComposition(c, connections, ["image"], false), /费用/);
  } finally { await server.close(); }
});

test("model settings HTTP routes persist edits and return conflicts instead of overwriting", async () => {
  const store = new ModelSettingsStore(); store.initialize({});
  const server = await mock((req: any, res: any) => handleModelSettingsRequest(req, res, new URL(req.url, "http://localhost")));
  try {
    const state = await (await fetch(server.url + "/api/model-settings")).json() as any;
    const post = (revision: string) => fetch(server.url + "/api/model-settings/connection", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revision, connection: { ...api, id: "" } }) });
    const saved = await post(state.revision); assert.equal(saved.status, 200);
    assert.equal((await saved.json() as any).connections[0].hasKey, true);
    assert.equal((await post(state.revision)).status, 400);
  } finally { await server.close(); }
});
