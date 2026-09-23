import assert from "node:assert/strict";
import test from "node:test";
import { query, type TurnResources } from "../../src/core/query.js";
import { runAgent } from "../../src/core/run-agent.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { createTextMessage } from "../../src/types/messages.js";
import type { ModelRequest, ModelStreamEvent } from "../../src/model/model-gateway.js";
import type { ContextManager } from "../../src/context/context-manager.js";

const contextManager: ContextManager = { async build() { return { systemPrompt: "base", promptSections: [], userContext: { currentDate: "2026-09-23" }, systemContext: { cwd: process.cwd(), platform: process.platform } }; } };
function fixture() {
  let active = true, leases = 0, executed = 0;
  const tools = new ToolRegistry();
  tools.register({ name: "sample", description: "sample", inputSchema: { type: "object" }, metadata: { visible: true, readOnly: true, concurrent: true },
    validate() { return {}; }, async call() { executed++; return { ok: true, output: "old tool finished" }; } });
  const acquire = (): TurnResources => {
    const snapshot = active ? tools.clone() : new ToolRegistry();
    leases++;
    let released = false;
    return { tools: snapshot, promptSections: active ? [{ name: "sample", content: "PLUGIN_RULE" }] : [],
      release() { if (!released) { leases--; released = true; } } };
  };
  return { tools, acquire, disable() { active = false; tools.unregister("sample"); }, get leases() { return leases; }, get executed() { return executed; } };
}

test("model schema, prompt and execution retain one plugin snapshot; next turn observes removal", async () => {
  const f = fixture(), requests: ModelRequest[] = [];
  const modelGateway = { async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    requests.push(request);
    assert.equal(f.leases, 1);
    if (requests.length === 1) { f.disable(); yield { type: "tool_use", toolUse: { id: "call", name: "sample", input: {} } }; }
    else yield { type: "assistant_message", message: createTextMessage("assistant", "done") };
  } };
  for await (const _ of query([createTextMessage("user", "test")], { tools: f.tools, acquireTurnResources: f.acquire, modelGateway, contextManager }, { agentId: "main", maxTurns: 3 })) {}
  assert.equal(f.executed, 1);
  assert.equal(f.leases, 0);
  assert.deepEqual(requests[0].tools.map(tool => tool.name), ["sample"]);
  assert.deepEqual(requests[1].tools, []);
  assert.match(requests[0].systemPrompt!, /PLUGIN_RULE/);
  assert.doesNotMatch(requests[1].systemPrompt!, /PLUGIN_RULE/);
});

test("consumer return and context failure release leases even before model execution", async () => {
  const f = fixture();
  const deps = { tools: f.tools, acquireTurnResources: f.acquire, contextManager, modelGateway: { async *stream(): AsyncIterable<ModelStreamEvent> {} } };
  const stream = query([createTextMessage("user", "test")], deps, { agentId: "main" });
  while (f.leases === 0) assert.equal((await stream.next()).done, false);
  await stream.return("completed");
  assert.equal(f.leases, 0);
  const broken = { ...deps, contextManager: { async build(): Promise<never> { throw Error("context failed"); } } };
  await assert.rejects(async () => { for await (const _ of query([], broken, { agentId: "main" })) {} }, /context failed/);
  assert.equal(f.leases, 0);
});

test("subagents refresh independently each turn, retain allow/deny policy and keep the report tool", async () => {
  const f = fixture(), requests: ModelRequest[] = [];
  const modelGateway = { async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    requests.push(request);
    if (requests.length === 1) { f.disable(); yield { type: "tool_use", toolUse: { id: "child-call", name: "sample", input: {} } }; }
    else yield { type: "assistant_message", message: createTextMessage("assistant", "done") };
  } };
  const options = { agentId: "child", prompt: "test", agent: { agentType: "custom", description: "test", whenToUse: "test", systemPrompt: "child", tools: ["sample"] },
    dependencies: { tools: f.tools, acquireTurnResources: f.acquire, modelGateway, contextManager }, maxTurns: 3 };
  for await (const _ of runAgent(options)) {}
  assert.equal(f.executed, 1); assert.equal(f.leases, 0);
  assert.ok(requests[0].tools.some(t => t.name === "sample"));
  assert.ok(!requests[1].tools.some(t => t.name === "sample"));
  assert.ok(requests[1].tools.some(t => t.name === "subagent_report"));
  assert.match(requests[0].systemPrompt!, /PLUGIN_RULE/);
  assert.doesNotMatch(requests[1].systemPrompt!, /PLUGIN_RULE/);
});
