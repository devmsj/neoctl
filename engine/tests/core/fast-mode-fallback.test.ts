import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { QueryEngine } from "../../src/core/query-engine.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { ModelAPIError } from "../../src/model/errors.js";
import type { ModelRequest, ModelStreamEvent } from "../../src/model/model-gateway.js";
import type { AgentEvent } from "../../src/types/events.js";
import { createTextMessage } from "../../src/types/messages.js";

async function collect(source: AsyncIterable<AgentEvent>) { const events: AgentEvent[] = []; for await (const event of source) events.push(event); return events; }
function gate() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
for (const laterChoice of [undefined, false, true]) test(`fallback persists, tools continue, newer choice ${laterChoice} survives`, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "neo-fast-fallback-"));
  const opened = gate(), release = gate(); const requests: ModelRequest[] = []; const toolFastModes: Array<boolean | undefined> = [];
  const tools = new ToolRegistry();
  tools.register({ name: "probe", description: "probe", inputSchema: { type: "object" }, metadata: { readOnly: true, concurrent: true, visible: true }, validate() { return {}; }, async call(_input, context) { toolFastModes.push(context.options?.fastMode); return { ok: true, output: "ok" }; } });
  const gateway = { async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    requests.push(request);
    if (requests.length === 1) { opened.resolve(); await release.promise; throw new ModelAPIError({ provider: "anthropic", status: 429, category: "rate_limit", message: "Usage credits are required for fast mode." }); }
    if (requests.length === 2) { yield { type: "tool_use", toolUse: { id: "probe", name: "probe", input: { description: "Run the test probe" } } }; yield { type: "response_completed" }; }
    else yield { type: "assistant_message", message: createTextMessage("assistant", "done") };
  } };
  const options = { model: "claude-haiku-5-5", tools, modelGateway: gateway, session: { rootDir: dir }, compactor: { async compact(messages: any[]) { return { messages, changed: false }; } } };
  try {
    const engine = new QueryEngine(options);
    await engine.setFastMode(true);
    const done = collect(engine.sendUserText("test")); await opened.promise;
    if (laterChoice !== undefined) await engine.updateSessionSettings({ fastMode: laterChoice });
    release.resolve(); const events = await done;
    assert.deepEqual(requests.map(r => r.fastMode), [true, false, laterChoice === true]);
    assert.deepEqual(toolFastModes, [false]);
    assert.equal(engine.isFastMode(), laterChoice === true);
    assert.deepEqual(engine.getPendingSessionSettings(), {});
    assert.equal(events.filter(e => e.type === "fast-mode.fallback").length, laterChoice === undefined ? 1 : 0);
    assert(!events.some(e => e.type === "error"));
    const snapshot = engine.snapshot();
    assert(snapshot.session);
    const restored = new QueryEngine({ ...options, session: { rootDir: dir, sessionId: snapshot.session.sessionId, resume: true } });
    await restored.initialize();
    assert.equal(restored.isFastMode(), laterChoice === true);
    assert(!JSON.stringify(engine.getHistoryMessages()).includes("fast-mode.fallback"));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
