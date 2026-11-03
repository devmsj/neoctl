import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createServer } from "node:http";
import { once } from "node:events";
import { loadModelCatalog, findModelMetadata, saveModelMetadata, deleteModelMetadata, assertModelNotRemoved, type ModelMetadata } from "../../src/model/context-window.js";
import { registerSettingsConsumer, modelUsage, interruptModelUsers } from "../../src/model/settings-sync.js";
import { handleModelSettingsRequest } from "../../src/web/model-settings-api.js";
import { createModelGatewayFromConfig } from "../../src/model/provider-factory.js";
import { createTextMessage } from "../../src/types/messages.js";
import { defaultComposition, validateComposition } from "../../src/model/settings-store.js";

const home = mkdtempSync(path.join(tmpdir(), "neo-metadata-crud-"));
const previous = process.env.NEO_MODEL_CONFIG_DIR;
process.env.NEO_MODEL_CONFIG_DIR = home;
test.after(() => { if (previous === undefined) delete process.env.NEO_MODEL_CONFIG_DIR; else process.env.NEO_MODEL_CONFIG_DIR = previous; rmSync(home, { recursive: true, force: true }); });
const custom = (id: string): ModelMetadata => ({ id, provider: "custom", protocols: ["openai"], modelIds: [id], reasoning: false });

test("ID rename, case/alias collisions, concurrent edit-delete and explicit recreation", () => {
  const first = custom("custom-10"); saveModelMetadata(first);
  const rev = loadModelCatalog().revision;
  const renamed = { ...first, id: "custom-2", modelIds: ["custom-2", "kept-alias"] };
  saveModelMetadata(renamed, first, rev);
  assert.equal(findModelMetadata("CUSTOM-2")?.id, "custom-2");
  assert.equal(findModelMetadata(first.id), undefined);
  assert.throws(() => assertModelNotRemoved(first.id), /重新选择/);
  assert.throws(() => saveModelMetadata({ ...first, id: "new" }, first, rev), /更新/);
  assert.throws(() => deleteModelMetadata(first), /不存在/);
  assert.throws(() => saveModelMetadata(custom("CUSTOM-2")), /已存在/);
  assert.throws(() => saveModelMetadata(custom("kept-alias")), /别名/);
  assert.throws(() => saveModelMetadata({ ...custom("other"), modelIds: ["custom-2"] }), /别名/);
  const stale = loadModelCatalog().revision;
  saveModelMetadata(custom("unrelated"));
  assert.throws(() => deleteModelMetadata(renamed, stale), /更新/);
  deleteModelMetadata(renamed, loadModelCatalog().revision);
  assert.throws(() => assertModelNotRemoved("kept-alias"), /删除/);
  const gateway = createModelGatewayFromConfig({ provider: "openai", apiKey: "test", baseUrl: "https://example.invalid", model: "custom-2" });
  assert.throws(() => gateway.stream({ messages: [createTextMessage("user", "x")], tools: [], stream: true }), /删除/);
  const c = defaultComposition(); c.main = { api: "a", model: "custom-2", effort: "high" };
  assert.throws(() => validateComposition(c, [{ id: "a", name: "a", kind: "openai", baseUrl: "https://example.invalid", key: "test" }]), /删除/);
  saveModelMetadata(renamed, undefined, loadModelCatalog().revision);
  assert.doesNotThrow(() => assertModelNotRemoved("custom-2"));
  assert.equal(findModelMetadata("kept-alias")?.id, "custom-2");
  const ids = loadModelCatalog().models.map(m => m.id);
  assert.deepEqual(ids, [...ids].sort((a, b) => a.localeCompare(b, "en", { numeric: true })));
});

test("deleted and renamed bundled IDs stay removed on fresh-process initialization; missing new defaults still append", () => {
  const catalog = loadModelCatalog();
  const removed = structuredClone(catalog.models.find(m => m.id === "gpt-6.1-sol")!);
  const renamed = structuredClone(catalog.models.find(m => m.id === "claude-fable-5-1")!);
  deleteModelMetadata(removed);
  saveModelMetadata({ ...renamed, id: "renamed-fable", modelIds: ["renamed-fable"] }, renamed);
  // Simulate an older data directory that has not seen one default yet.
  const file = path.join(home, "model-metadata.json");
  const data = JSON.parse(readFileSync(file, "utf8"));
  const missing = data.models.find((m: ModelMetadata) => !["renamed-fable", "custom-2", "unrelated"].includes(m.id));
  data.models = data.models.filter((m: ModelMetadata) => m.id !== missing.id);
  writeFileSync(file, JSON.stringify(data));
  const module = pathToFileURL(path.resolve("src/model/context-window.ts")).href;
  const run = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `const {loadModelCatalog}=await import(${JSON.stringify(module)}); console.log(JSON.stringify(loadModelCatalog()))`], { encoding: "utf8", env: { ...process.env } });
  assert.equal(run.status, 0, run.stderr);
  const fresh = JSON.parse(run.stdout);
  assert.ok(!fresh.models.some((m: ModelMetadata) => [removed.id, renamed.id].includes(m.id)));
  assert.ok(fresh.models.some((m: ModelMetadata) => m.id === missing.id));
  assert.ok(fresh.models.some((m: ModelMetadata) => m.id === "renamed-fable"));
});

test("delete confirmation rechecks live holders, includes aliases and rejects stale revision without interruption", async () => {
  saveModelMetadata({ ...custom("occupied"), modelIds: ["occupied-alias"] });
  let held = "", interrupted = 0;
  const consumer = { isModelConfigurationBusy: () => true, refreshModelConfigurationIfIdle() {}, getHeldModelIds: () => held ? [held] : [], interruptForModelRemoval() { interrupted++; } };
  registerSettingsConsumer(consumer);
  const server = createServer((req, res) => { void handleModelSettingsRequest(req, res, new URL(req.url!, "http://localhost")); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/model-settings`;
  const post = (route: string, body: unknown) => fetch(base + route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  try {
    const preview = await (await post("/metadata/usage", { id: "occupied" })).json() as any;
    assert.equal(preview.usage.holders, 0);
    held = "OCCUPIED-alias";
    assert.deepEqual(modelUsage(["occupied", "occupied-alias"]), { holders: 1, running: 1 });
    const body = { original: preview.original, catalogRevision: preview.catalogRevision, confirmed: true };
    const raced = await post("/metadata/delete", body);
    assert.equal(raced.status, 409); assert.match((await raced.json() as any).error, /中断会话/);
    assert.equal(interrupted, 0); assert.ok(findModelMetadata("occupied"));
    saveModelMetadata(custom("another"));
    assert.equal((await post("/metadata/delete", { ...body, interruptConfirmed: true })).status, 409);
    assert.equal(interrupted, 0);
    const latest = await (await post("/metadata/usage", { id: "occupied" })).json() as any;
    const deleted = await post("/metadata/delete", { original: latest.original, catalogRevision: latest.catalogRevision, confirmed: true, interruptConfirmed: true });
    assert.equal(deleted.status, 200, JSON.stringify(await deleted.json()));
    assert.equal(interrupted, 1); assert.equal(findModelMetadata("occupied-alias"), undefined);
    assert.equal((await post("/metadata/usage", { id: "occupied" })).status, 409);
    // Distinct homes do not leak usage or stop unrelated consumers.
    process.env.NEO_MODEL_CONFIG_DIR = path.join(home, "other");
    assert.deepEqual(modelUsage([held]), { holders: 0, running: 0 }); interruptModelUsers([held]); assert.equal(interrupted, 1);
  } finally { process.env.NEO_MODEL_CONFIG_DIR = home; held = ""; server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
});
