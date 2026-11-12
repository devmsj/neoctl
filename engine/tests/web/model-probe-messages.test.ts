import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { defaultComposition } from "../../src/model/settings-store.js";
import { saveModelMetadata } from "../../src/model/context-window.js";
import { testModelComposition } from "../../src/web/model-settings-api.js";

test("Messages probe reads completed assistant tool blocks, preserves thinking replay, and rejects invalid/truncated calls", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "neo-messages-probe-")), previous = process.env.NEO_MODEL_CONFIG_DIR;
  process.env.NEO_MODEL_CONFIG_DIR = home;
  let mode = "valid", calls = 0;
  const bodies: any[] = [];
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); bodies.push(body); calls++;
    assert.equal(req.url, "/v1/messages");
    const continuation = body.messages.some((m: any) => m.content.some((b: any) => b.type === "tool_result"));
    const use = { type: "tool_use", id: "probe-1", name: mode === "wrong-name" ? "different_tool" : "configuration_probe", input: { value: mode === "wrong-value" ? "7" : 7 } };
    const blocks: Array<Record<string, unknown>> = continuation || mode === "text-only" ? [{ type: "text", text: "The result is 7." }] : [{ type: "thinking", thinking: "Call the probe.", signature: "test-signature" }, use];
    const events: any[] = [{ type: "message_start", message: { id: "m1", role: "assistant", content: [], usage: { input_tokens: 1, output_tokens: 0 } } }];
    blocks.forEach((block, index) => {
      const start = block.type === "text" ? { ...block, text: "" } : block.type === "tool_use" ? { ...block, input: {} } : block;
      events.push({ type: "content_block_start", index, content_block: start });
      if (block.type === "tool_use") events.push({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
      if (block.type === "text") events.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } });
      events.push({ type: "content_block_stop", index });
    });
    if (mode !== "truncated") events.push({ type: "message_delta", delta: { stop_reason: continuation || mode === "text-only" ? "end_turn" : "tool_use" }, usage: { output_tokens: 2 } }, { type: "message_stop" });
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    saveModelMetadata({ id: "messages-probe", provider: "custom", protocols: ["anthropic"], modelIds: ["messages-probe"], reasoning: false });
    const c = defaultComposition(); c.main = { api: "a", protocol: "messages", model: "messages-probe", effort: "high" };
    const connections = [{ id: "a", name: "test", kind: "anthropic" as const, key: "test-key", baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, }];
    const run = () => testModelComposition(c, connections, ["main"], false);
    assert.equal((await run())[0]?.ok, true);
    assert.equal(calls, 2);
    const replay = bodies[1].messages.find((m: any) => m.role === "assistant");
    assert.ok(replay.content.some((b: any) => b.type === "thinking" && b.signature === "test-signature"));
    assert.equal(replay.content.filter((b: any) => b.type === "tool_use").length, 1);
    assert.equal(bodies[1].messages.flatMap((m: any) => m.content).filter((b: any) => b.type === "tool_result").length, 1);
    for (mode of ["wrong-name", "wrong-value", "text-only", "truncated"]) {
      const before: number = calls;
      const result = (await run())[0]!;
      assert.equal(result.ok, false, mode);
      assert.equal(calls, before + (mode === "truncated" ? 6 : 1), mode + " must not start a continuation (truncated transport uses the existing retry budget)");
    }
  } finally {
    server.closeAllConnections(); await new Promise<void>(r => server.close(() => r()));
    if (previous === undefined) delete process.env.NEO_MODEL_CONFIG_DIR; else process.env.NEO_MODEL_CONFIG_DIR = previous;
    rmSync(home, { recursive: true, force: true });
  }
});
