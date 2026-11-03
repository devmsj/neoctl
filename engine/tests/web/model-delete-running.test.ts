import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { createWebRuntime, WebRepl } from "../../src/web/index.js";
import { handleModelSettingsRequest } from "../../src/web/model-settings-api.js";
import { ModelSettingsStore } from "../../src/model/settings-store.js";
import { modelUsage, connectionUsage } from "../../src/model/settings-sync.js";
import { agentSettingsBoundary } from "../../src/model/agent-settings-boundary.js";
import { QueryEngine } from "../../src/core/query-engine.js";
import { ToolRegistry } from "../../src/tools/registry.js";

for (const target of ["model", "connection"] as const) test(`confirmed ${target} deletion interrupts live work, clears selections and preserves history`, async () => {
  const home = mkdtempSync(path.join(tmpdir(), "neo-delete-stream-")), env = { ...process.env };
  process.env.NEO_MODEL_CONFIG_DIR = home;
  process.env.NEO_ENV_FILE = path.join(home, "empty.env"); writeFileSync(process.env.NEO_ENV_FILE, "");
  process.env.MODEL_PROVIDER = "openai"; process.env.OPENAI_API_KEY = "test"; process.env.OPENAI_MODEL = "gpt-6.1-sol";
  process.env.AGENT_SESSION_TRANSCRIPT = "0";
  let started!: () => void, count = 0;
  const ready = new Promise<void>(resolve => started = resolve);
  const upstream = createServer(async (req, res) => {
    for await (const chunk of req) { void chunk; }
    count++;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write('data: {"type":"response.created","response":{"id":"held","status":"in_progress"}}\n\n');
    started();
    // Keep streaming until deletion aborts the client; no real provider is contacted.
  });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
  const api = createServer((req, res) => { void handleModelSettingsRequest(req, res, new URL(req.url!, "http://localhost")); });
  api.listen(0, "127.0.0.1"); await once(api, "listening");
  const post = (route: string, body: unknown) => fetch(`http://127.0.0.1:${(api.address() as { port: number }).port}/api/model-settings${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const store = new ModelSettingsStore(); let state = store.initialize(process.env);
    const c = structuredClone(state.composition); c.image.api = ""; c.search.api = ""; c.search.exa = false;
    state = store.apply(state.revision, c);
    const runtime = await createWebRuntime({ cwd: home, resume: false });
    const repl = new WebRepl(runtime);
    const idle = runtime.engine.forkForSession(undefined, false);
    const child = agentSettingsBoundary(undefined, "gpt-6.1-sol"); child.start();
    const events: any[] = [];
    const run = (async () => { for await (const event of runtime.engine.sendUserText("held stream")) events.push(event); })();
    await ready;
    assert.ok(modelUsage(["gpt-6.1-sol"]).holders >= 3);
    const connectionId = c.main.api;
    const preview = await (await post(target === "model" ? "/metadata/usage" : "/connection/usage", { id: target === "model" ? "gpt-6.1-sol" : connectionId })).json() as any;
    assert.ok(preview.usage.running >= 2);
    const compactRuns: Promise<unknown>[] = [];
    const compactEngines: QueryEngine[] = [];
    for (const pure of (target === "model" ? [false, true] : [])) {
      let compactStarted!: () => void;
      const compactReady = new Promise<void>(r => compactStarted = r);
      const wait = (_messages: unknown, budget: any) => new Promise<any>((_resolve, reject) => {
        compactStarted();
        budget.abortSignal.addEventListener("abort", () => reject(budget.abortSignal.reason), { once: true });
      });
      const engine = new QueryEngine({ model: "gpt-6.1-sol", tools: new ToolRegistry(), modelGateway: { async *stream() {} }, beforeQuery() {}, session: { enabled: false }, compactor: { compact: wait, manualCompact: wait, pureCompact: wait } });
      compactEngines.push(engine);
      compactRuns.push((pure ? engine.pureCompact() : engine.compact()).then(() => { throw new Error("deleted-model compaction committed"); }, () => undefined));
      await compactReady;
      assert.equal(engine.isModelConfigurationBusy(), true);
    }
    const route = target === "model" ? "/metadata/delete" : "/connection/delete";
    const payload = { ...preview, id: connectionId, confirmed: true };
    const refused = await post(route, payload);
    assert.equal(refused.status, 409, "active usage requires explicit interruption confirmation");
    assert.equal(child.signal.aborted, false);
    const deleted = await post(route, { ...payload, interruptConfirmed: true });
    // The API expects catalogRevision and original, not a client-authored holder list.
    assert.equal(deleted.status, 200, JSON.stringify(await deleted.json()));
    await Promise.race([Promise.all([run, ...compactRuns]), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("stream was not interrupted")), 4000); })]);
    assert.ok(child.signal.aborted); child.stop();
    assert.equal(runtime.engine.isModelConfigurationBusy(), false);
    assert.ok(events.some(e => e.type === "terminal" && e.reason.startsWith("aborted")), JSON.stringify(events));
    assert.equal(runtime.engine.getModelSettings().model, undefined);
    assert.equal(idle.getModelSettings().model, undefined);
    assert.ok(runtime.engine.getHistoryMessages().some(m => m.blocks.some(b => b.type === "text" && b.text === "held stream")));
    if (target === "model") assert.ok(!repl.snapshot().catalog?.modelIds.includes("gpt-6.1-sol"));
    assert.equal(repl.snapshot().modelSettings?.model, undefined);
    assert.equal(store.read()?.applied?.composition.main.model, "");
    if (target === "connection") assert.equal(connectionUsage(connectionId).holders, 0);
    const next: any[] = [];
    for await (const event of runtime.engine.sendUserText("do not contact removed model")) next.push(event);
    assert.equal(count, 1);
    assert.ok(next.some(e => e.type === "error"), JSON.stringify(next));
    await runtime.engine.settleSessionWrites(); await idle.settleSessionWrites();
    // Explicit application can restore a cleared session; metadata saves cannot.
    if (target === "connection") {
      let latest = store.read()!;
      latest = store.saveConnection(latest.revision, { id: "", name: "replacement", kind: "openai", key: "test", baseUrl: process.env.OPENAI_BASE_URL! });
      const restored = structuredClone(latest.composition); restored.main.api = latest.connections[0]!.id; restored.main.model = "gpt-6.1-sol";
      const applied = await post("/apply", { revision: latest.revision, composition: restored });
      assert.equal(applied.status, 200, JSON.stringify(await applied.json()));
      assert.equal(runtime.engine.getModelSettings().model, "gpt-6.1-sol");
      assert.equal(idle.getModelSettings().model, "gpt-6.1-sol");
    }
  } finally {
    clearTimeout(timer);
    upstream.closeAllConnections(); api.closeAllConnections();
    await Promise.all([new Promise<void>(r => upstream.close(() => r())), new Promise<void>(r => api.close(() => r()))]);
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key]; Object.assign(process.env, env);
    rmSync(home, { recursive: true, force: true });
  }
});
