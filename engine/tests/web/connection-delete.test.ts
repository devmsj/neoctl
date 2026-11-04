import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { handleModelSettingsRequest } from "../../src/web/model-settings-api.js";
import { ModelSettingsStore } from "../../src/model/settings-store.js";
import { registerSettingsConsumer } from "../../src/model/settings-sync.js";
import { QueryEngine } from "../../src/core/query-engine.js";
import { ToolRegistry } from "../../src/tools/registry.js";

test("connection deletion rechecks active usage, preserves unrelated homes, clears idle references", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "neo-connection-delete-"));
  const previous = process.env.NEO_MODEL_CONFIG_DIR;
  process.env.NEO_MODEL_CONFIG_DIR = home;
  let held = true, busy = false, cleared = 0, otherCleared = 0;
  const consumer = { isModelConfigurationBusy: () => busy, refreshModelConfigurationIfIdle() {}, getHeldConnectionIds: () => held ? ["openai"] : [], interruptForModelRemoval() { held = false; cleared++; } };
  registerSettingsConsumer(consumer);
  process.env.NEO_MODEL_CONFIG_DIR = path.join(home, "other");
  const other = { ...consumer, interruptForModelRemoval() { otherCleared++; } };
  registerSettingsConsumer(other);
  process.env.NEO_MODEL_CONFIG_DIR = home;
  const server = createServer((req, res) => { void handleModelSettingsRequest(req, res, new URL(req.url!, "http://localhost")); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const post = (route: string, body: unknown) => fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/model-settings${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  try {
    const store = new ModelSettingsStore(); let state = store.initialize({ OPENAI_API_KEY: "fixture", OPENAI_MODEL: "gpt-6.1-sol" });
    state = store.apply(state.revision, state.composition);
    const preview = await (await post("/connection/usage", { id: "openai" })).json() as any;
    assert.deepEqual(preview.usage, { holders: 1, running: 0 });
    const payload = { revision: preview.revision, id: "openai", confirmed: true };
    busy = true;
    assert.equal((await post("/connection/delete", payload)).status, 409, "newly active holder requires reconfirmation");
    assert.equal(cleared, 0);
    busy = false;
    assert.equal((await post("/connection/delete", payload)).status, 200, "idle holder only needs ordinary confirmation");
    assert.equal(cleared, 1); assert.equal(otherCleared, 0);
    assert.equal(store.read()?.applied?.composition.main.api, "");
    assert.equal(store.read()?.connections.length, 0);
  } finally {
    server.closeAllConnections(); await new Promise<void>(r => server.close(() => r()));
    if (previous === undefined) delete process.env.NEO_MODEL_CONFIG_DIR; else process.env.NEO_MODEL_CONFIG_DIR = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

test("cleared session remains unconfigured after reopen and explicit selection restores it", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "neo-cleared-session-"));
  let calls = 0;
  const options = { model: "custom-model", modelGateway: { async *stream() { calls++; } }, tools: new ToolRegistry(), session: { rootDir: home, sessionId: "cleared", resume: false } };
  try {
    const engine = new QueryEngine(options); await engine.initialize();
    engine.interruptForModelRemoval(); await engine.settleSessionWrites();
    const resumed = new QueryEngine({ ...options, session: { ...options.session, resume: true } }); await resumed.initialize();
    assert.equal(resumed.getModelSettings().model, undefined);
    const events = []; for await (const event of resumed.sendUserText("must not call")) events.push(event);
    assert.equal(calls, 0); assert.ok(events.some(e => e.type === "error" && /模型未配置/.test(e.error.message)));
    const fork = resumed.forkForSession("cleared-fork", false); await fork.initialize();
    assert.equal(fork.getModelSettings().model, undefined);
    for await (const _event of fork.sendUserText("fork must not call")) { /* consume */ }
    assert.equal(calls, 0, "a fork must not revive the inherited provider default");
    await fork.settleSessionWrites();
    const unopened = new QueryEngine({ ...options, session: { ...options.session, sessionId: "unopened" } });
    unopened.interruptForModelRemoval(); await unopened.initialize();
    assert.equal(unopened.getModelSettings().model, undefined);
    await unopened.settleSessionWrites();
    resumed.setModel("custom-model");
    const restored = new QueryEngine({ ...options, session: { ...options.session, resume: true } }); await restored.initialize();
    assert.equal(restored.getModelSettings().model, "custom-model");
  } finally { rmSync(home, { recursive: true, force: true }); }
});
