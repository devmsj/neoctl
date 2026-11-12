import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { EventEmitter, once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { AnthropicAdapter } from "../../src/model/anthropic-adapter.js";
import { query } from "../../src/core/query.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { createTextMessage } from "../../src/types/messages.js";
import { WebRepl } from "../../src/web/index.js";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
async function until(check: () => boolean) {
  for (let i = 0; i < 300; i++) { if (check()) return; await delay(10); }
  assert.fail("Timed out waiting for streamed preview");
}
const cases = [
  { name: "file_write", input: { description: "Stream the test operation", path: "probe.txt", content: "first second third" } },
  { name: "file_edit", input: { description: "Stream the test operation", path: "probe.txt", oldString: "old", newString: "first second third" } },
  { name: "terminal_run", input: { description: "Stream the test operation", cmd: "first second third" } },
  { name: "plan_update", input: { description: "Stream the test operation", items: [{ description: "first second third", status: "pending" }] } },
  { name: "custom_plugin", input: { description: "Stream the test operation", nested: { arbitrary: "first second third" } } },
];

for (const ending of ["complete", "max_tokens", "malformed", "disconnect", "abort"] as const) {
  test(`Anthropic HTTP → query → Web SSE streams every tool before execution (${ending})`, { timeout: 15000 }, async () => {
    const stages = [gate(), gate()];
    const abort = new AbortController();
    let requests = 0, responseStopped = false;
    const server = createServer(async (req, res) => {
      let raw = ""; for await (const chunk of req) raw += chunk;
      if (req.url?.endsWith("/count_tokens")) { res.writeHead(404); res.end("{}"); return; }
      const body = JSON.parse(raw);
      assert.ok(body.tools.every((tool: any) => tool.eager_input_streaming === true));
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const send = (event: Record<string, unknown>) => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      send({ type: "message_start", message: { id: `msg_${++requests}`, usage: {} } });
      if (requests > 1) {
        send({ type: "content_block_start", index: 0, content_block: { type: "text", text: "done" } });
        send({ type: "content_block_stop", index: 0 });
        send({ type: "message_delta", delta: { stop_reason: "end_turn" } });
        send({ type: "message_stop" }); res.end(); return;
      }
      const json = cases.map(c => JSON.stringify(c.input));
      const cuts = json.map(s => [s.indexOf("first") + 5, s.indexOf("second") + 6]);
      for (const [index, c] of cases.entries()) {
        send({ type: "content_block_start", index, content_block: { type: "tool_use", id: `call_${index}`, name: c.name, input: {} } });
        send({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: json[index]!.slice(0, cuts[index]![0]) } });
      }
      await stages[0]!.promise;
      // Interleave multiple IDs, keeping each JSON string incomplete.
      for (const index of [4, 2, 0, 3, 1]) send({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: json[index]!.slice(cuts[index]![0], cuts[index]![1]) } });
      await stages[1]!.promise;
      if (ending === "disconnect" || ending === "abort") { res.end(); return; }
      for (const [index] of cases.entries()) {
        const tail = ending === "complete" ? json[index]!.slice(cuts[index]![1]) : "";
        send({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: tail } });
        send({ type: "content_block_stop", index });
      }
      responseStopped = true;
      send({ type: "message_delta", delta: { stop_reason: ending === "max_tokens" ? "max_tokens" : "tool_use" } });
      send({ type: "message_stop" }); res.end();
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const { port } = server.address() as { port: number };
    const runtime = {
      engine: { getTimingRecords: () => [], getDisplayEntries: () => [], snapshot: () => ({ session: { sessionId: "tool-stream-test" } }), isFastMode: () => false, getAppPrompt: () => ({ hasActivePrompt: false }), onSessionTitleChange: () => () => undefined },
      usage: { snapshot: () => ({}), add() {}, reset() {} },
      taskStore: { subscribe: () => () => undefined, list: () => [] },
      execProcessManager: { subscribe: () => () => undefined, subscribeOutput: () => () => undefined, list: () => [] },
    };
    const repl = new WebRepl(runtime as never);
    const handle = (repl as unknown as { handleEvent(event: unknown): void }).handleEvent.bind(repl);
    const chunks: string[] = [];
    const subscriber = Object.assign(new EventEmitter(), { writeHead() {}, write(chunk: string) { chunks.push(chunk); return true; } });
    repl.subscribe(subscriber as never);
    const registry = new ToolRegistry(), executions: string[] = [], events: string[] = [];
    for (const c of cases) registry.register({
      name: c.name, description: "In-memory probe", inputSchema: { type: "object" },
      metadata: { visible: true, readOnly: true, concurrent: true },
      async execute(input) {
        assert.equal(responseStopped, true, "partial JSON must not execute");
        const { description: _purpose, ...businessInput } = c.input;
        assert.deepEqual(input, businessInput); executions.push(c.name);
        return { ok: true, output: "recorded" };
      },
    });
    const adapter = new AnthropicAdapter({ model: "claude-haiku-5-5", baseUrl: `http://127.0.0.1:${port}`, apiKey: "test", maxRetries: 0 });
    const running = (async () => {
      for await (const event of query([createTextMessage("user", "test")], {
        tools: registry, modelGateway: adapter,
        contextManager: { async build() { return { systemPrompt: "Test", promptSections: [], userContext: {}, systemContext: { cwd: process.cwd(), platform: process.platform } }; } },
      }, { agentId: "test", maxTurns: 2, abortSignal: abort.signal })) { events.push(event.type); handle(event); }
    })();
    const previews = () => repl.snapshot(false).lines.filter(line => line.activity?.phase === "generating");
    try {
      for (const [index, text] of ["first", "first second"].entries()) {
        await until(() => previews().length === cases.length && previews().every(line => JSON.stringify(line.activity!.input).includes(text)));
        assert.equal(responseStopped, false);
        assert.deepEqual(executions, []);
        assert.equal(events.includes("tool_call.ready"), false);
        await until(() => chunks.some(chunk => chunk.includes("line.activity.input") && chunk.includes(index === 0 ? "first" : "second")));
        for (const c of cases) assert.ok(previews().some(line => line.toolName === c.name));
        if (index === 1 && ending === "abort") abort.abort();
        stages[index]!.release();
      }
      await running;
      if (ending === "complete") {
        assert.deepEqual(executions.sort(), cases.map(c => c.name).sort());
        assert.equal(events.filter(type => type === "tool_call.ready").length, cases.length);
        assert.equal(requests, 2);
      } else {
        assert.deepEqual(executions, []);
        assert.equal(events.includes("tool_call.ready"), false);
      }
    } finally {
      stages.forEach(stage => stage.release()); abort.abort();
      await running.catch(() => {}); subscriber.emit("close");
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
}
