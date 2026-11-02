import { findModelMetadata, saveModelMetadata } from "../../src/model/context-window.js";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { ModelSettingsStore } from "../../src/model/settings-store.js";
import { createWebRuntime, WebRepl } from "../../src/web/index.js";
import { publishModelSettings } from "../../src/model/settings-sync.js";

test("apply during streaming switches connection/protocol/tools at next API turn, not midstream", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "neo-next-turn-")), env = { ...process.env };
  process.env.NEO_MODEL_CONFIG_DIR = home; process.env.NEO_ENV_FILE = path.join(home, "empty.env"); writeFileSync(process.env.NEO_ENV_FILE, "");
  process.env.MODEL_PROVIDER = "openai"; process.env.OPENAI_API_KEY = "test"; process.env.OPENAI_MODEL = "gpt-6.1-sol"; process.env.AGENT_SESSION_TRANSCRIPT = "0";
  let first!: () => void, release!: () => void;
  const started = new Promise<void>(r => first = r), gate = new Promise<void>(r => release = r);
  const requests: Array<{ url: string; body: any }> = [];
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests.push({ url: req.url!, body });
    if (requests.length === 1) {
      first(); await gate;
      const tool = { type: "function_call", id: "fc", call_id: "c", name: "file_list", arguments: JSON.stringify({ path: home, maxEntries: 1 }), status: "completed" };
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end([
        { type: "response.output_item.added", output_index: 0, item: { ...tool, arguments: "" } },
        { type: "response.function_call_arguments.done", item_id: "fc", output_index: 0, arguments: tool.arguments },
        { type: "response.output_item.done", output_index: 0, item: tool },
        { type: "response.completed", response: { id: "old_response", status: "completed", output: [tool] } },
      ].map(e => `data: ${JSON.stringify(e)}\n\n`).join(""));
    } else {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end([
        { type: "message_start", message: { id: "new_message", type: "message", role: "assistant", model: "claude-fable-5", content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
        { type: "message_stop" },
      ].map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""));
    }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const store = new ModelSettingsStore(); let state = store.initialize(process.env);
    state = store.saveConnection(state.revision, { ...state.connections[0]!, protocols: ["openai", "anthropic"] });
    state = store.apply(state.revision, state.composition);
    const runtime = await createWebRuntime({ cwd: home, sessionRootDir: path.join(home, "sessions"), resume: false });
    const repl = new WebRepl(runtime);
    const idle = runtime.engine.forkForSession(undefined, false);
    const errors: unknown[] = [];
    const running = (async () => { for await (const e of runtime.engine.sendUserText("list then reply")) if (e.type === "error") errors.push(e); })();
    await started;
    const metadata = structuredClone(findModelMetadata("gpt-6.1-sol")!);
    saveModelMetadata({ ...metadata, reasoningEfforts: [...(metadata.reasoningEfforts ?? []), "custom-live"] }, metadata);
    assert.equal(publishModelSettings().deferred, true);
    assert.ok(!runtime.engine.getActiveModelCatalog().models.find(m => m.id === metadata.id)?.reasoningEfforts?.includes("custom-live"));
    assert.ok(idle.getActiveModelCatalog().models.find(m => m.id === metadata.id)?.reasoningEfforts?.includes("custom-live"));
    const c = structuredClone(state.composition); c.main.protocol = "messages"; c.main.model = "claude-fable-5"; c.image.api = ""; c.search.api = ""; c.search.exa = false;
    state = store.apply(state.revision, c);
    assert.equal(publishModelSettings().deferred, true);
    assert.equal(runtime.engine.getModelSettings().model, "gpt-6.1-sol");
    assert.equal(idle.getModelSettings().model, "claude-fable-5");
    // A sibling adopting the new global plan must not change this streaming session's catalog.
    const during = repl.snapshot();
    assert.equal(during.catalog?.modelProtocol, "openai");
    assert.ok(!during.catalog?.modelIds.some(id => id.startsWith("claude-")));
    release(); await running;
    assert.equal(errors.length, 0, JSON.stringify(errors));
    assert.equal(requests.length, 2);
    assert.equal(requests[0]!.url, "/v1/responses"); assert.equal(requests[1]!.url, "/v1/messages");
    assert.equal(requests[1]!.body.model, "claude-fable-5");
    assert.equal(requests[1]!.body.previous_response_id, undefined);
    assert.ok(!requests[1]!.body.tools.some((t: any) => t.name === "image_create" || t.name === "web_search"));
    assert.ok(requests[1]!.body.messages.some((m: any) => m.content.some((b: any) => b.type === "tool_result")));
    const after = repl.snapshot();
    assert.equal(after.catalog?.modelProtocol, "anthropic");
    assert.ok(after.catalog?.modelIds.every(id => id.startsWith("claude-")));
    assert.equal(publishModelSettings().deferred, false);
    await runtime.engine.settleSessionWrites(); await idle.settleSessionWrites();
  } finally {
    release(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r()));
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key]; Object.assign(process.env, env);
    rmSync(home, { recursive: true, force: true });
  }
});
