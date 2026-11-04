import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { ModelSettingsStore } from "../../src/model/settings-store.js";
import { createWebRuntime } from "../../src/web/index.js";

test("applying composition leaves a running engine on its old model and tools, including forked sessions", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "neo-composition-runtime-"));
  const env = { ...process.env };
  process.env.NEO_MODEL_CONFIG_DIR = home;
  process.env.NEO_ENV_FILE = path.join(home, "empty.env"); writeFileSync(process.env.NEO_ENV_FILE, "");
  process.env.MODEL_PROVIDER = "openai"; process.env.OPENAI_API_KEY = "test-key"; process.env.OPENAI_MODEL = "gpt-6.1-sol";
  process.env.AGENT_SESSION_TRANSCRIPT = "0";
  let signalFirst!: () => void, release!: () => void;
  const first = new Promise<void>(r => signalFirst = r), gate = new Promise<void>(r => release = r);
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests.push(body);
    if (requests.length === 1) { signalFirst(); await gate; }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ type: "response.output_text.delta", item_id: "msg", output_index: 0, content_index: 0, delta: "done" })}\n\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "r", status: "completed", output: [{ type: "message", id: "msg", role: "assistant", content: [{ type: "output_text", text: "done" }] }] } })}\n\n`);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const consume = async (stream: AsyncIterable<unknown>) => { for await (const _ of stream) { /* drain */ } };
  try {
    const store = new ModelSettingsStore(); let state = store.initialize(process.env);
    state.composition.main.model = "gpt-6.1-sol"; state.composition.main.effort = "high";
    state = store.apply(state.revision, state.composition);
    const runtime = await createWebRuntime({ cwd: home, sessionRootDir: path.join(home, "sessions"), resume: false });
    const old = runtime.engine;
    const running = consume(old.sendUserText("reply done")); await first;
    state = store.saveConnection(state.revision, { ...state.connections[0]!, key: "", models: [...(state.connections[0]!.models ?? []), "gpt-5.6-sol"] });
    const next = structuredClone(state.composition); next.main.model = "gpt-5.6-sol"; next.image.model = ""; next.search.model = ""; next.search.exa = false;
    state = store.apply(state.revision, next);
    const fork = old.forkForSession(undefined, false); runtime.engine = fork;
    await consume(fork.sendUserText("reply done"));
    assert.equal(requests[0].model, "gpt-6.1-sol"); assert.equal(requests[1].model, "gpt-5.6-sol");
    assert.ok(requests[0].tools.some((t: any) => t.name === "image_create"));
    assert.ok(!requests[1].tools.some((t: any) => t.name === "image_create" || t.name === "web_search"));
    const oldTurn = (old as any).options.acquireTurnResources(old);
    assert.ok(oldTurn.tools.get("image_create")); assert.ok(oldTurn.tools.get("web_search")); oldTurn.release();
    release(); await running;
    assert.equal(old.getModelSettings().model, "gpt-6.1-sol");
    await consume(old.sendUserText("new task")); assert.equal(requests.at(-1).model, "gpt-5.6-sol");
    await old.settleSessionWrites(); await fork.settleSessionWrites();
  } finally {
    release(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r()));
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key]; Object.assign(process.env, env);
    rmSync(home, { recursive: true, force: true });
  }
});
