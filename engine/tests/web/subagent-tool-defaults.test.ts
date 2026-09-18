import assert from "node:assert/strict";
import test from "node:test";
import { createAgentTool } from "../../src/agents/agent-tool.js";
import { GENERAL_PURPOSE_AGENT } from "../../src/agents/agent-definition.js";
import { resolveAgentTools } from "../../src/core/run-agent.js";
import { createSubagentTools } from "../../src/tasks/subagent-tools.js";
import { TaskStore } from "../../src/tasks/task-store.js";
import { ToolRegistry, isToolEnabledByDefault } from "../../src/tools/registry.js";
import { readFileTool } from "../../src/tools/builtins/filesystem-tools.js";
import { WebRepl, refreshGlobalToolOverrides, type WebRuntime } from "../../src/web/index.js";

const names = ["subagent_run", "subagent_output", "subagent_list", "subagent_get", "subagent_stop", "subagent_message", "subagent_resume"];

function fixture(globalOverrides: Record<string, boolean> = {}, sessionOverrides: Record<string, boolean> = {}) {
  const tools = new ToolRegistry();
  const builtins = [createAgentTool(), ...createSubagentTools(new TaskStore()), readFileTool];
  for (const tool of builtins) tools.register(tool);
  let persistedGlobal = { ...globalOverrides };
  let persistedSession = { ...sessionOverrides };
  const runtime = {
    tools,
    engine: {
      snapshot: () => ({ session: { sessionId: "test-session" } }),
      refreshToolsIfIdle: () => refreshGlobalToolOverrides(runtime),
    },
    toolSupport: {
      catalog: builtins.map(tool => ({ name: tool.name, source: "builtin" })),
      globalOverrides: { ...globalOverrides },
      sessionOverrides: { ...sessionOverrides },
      resolveGlobal: () => persistedGlobal,
      persistGlobal: async (value: Record<string, boolean>) => { persistedGlobal = { ...value }; },
      persistSession: async (_id: string, value: Record<string, boolean>) => { persistedSession = { ...value }; },
      resolveSession: async () => persistedSession,
    },
  } as unknown as WebRuntime;
  // Exercise production settings methods without unrelated SSE/history rendering.
  const repl = Object.create(WebRepl.prototype) as WebRepl;
  Object.assign(repl, { runtime, refreshToolConfiguration: async () => {} });
  refreshGlobalToolOverrides(runtime);
  return { tools, runtime, repl, persisted: () => ({ global: persistedGlobal, session: persistedSession }) };
}

function assertDisabled(tools: ToolRegistry, name: string) {
  assert.equal(tools.isEnabled(name), false, name);
  assert.equal(tools.get(name), undefined, "execution lookup must reject disabled tools");
  assert.ok(!tools.names().includes(name));
  assert.ok(!tools.definitions(undefined, { includeDeferred: true }).some(tool => tool.name === name));
  assert.ok(!tools.list(undefined, { includeDeferred: true }).some(tool => tool.name === name));
  assert.ok(tools.names({ includeDisabled: true }).includes(name), "keep configurable catalog entry");
}

test("all seven delegation tools default off in registry and web settings", () => {
  const { tools, repl } = fixture();
  for (const name of names) {
    assert.equal(isToolEnabledByDefault(name), false);
    assertDisabled(tools, name);
    assert.equal(repl.globalTools().items.find(tool => tool.name === name)?.configuredEnabled, false);
    const item = repl.sessionTools().items.find(tool => tool.name === name)!;
    assert.equal(item.mode, "inherit");
    assert.equal(item.globallyEnabled, false);
    assert.equal(item.effectiveEnabled, false);
  }
  assert.ok(tools.get("file_read"), "ordinary tools keep their defaults");
  assert.equal(isToolEnabledByDefault("subagent_future_tool"), false);
});

test("registry opt-in and aliases cannot bypass disabled defaults", () => {
  const tools = new ToolRegistry();
  const tool = { ...createAgentTool(), aliases: ["test_delegate"] };
  tools.register(tool);
  assertDisabled(tools, tool.name);
  assert.equal(tools.getByAlias("test_delegate"), undefined);
  assert.equal(tools.get("test_delegate"), undefined);
  tools.setEnabled("test_delegate", true);
  assert.equal(tools.get(tool.name), tool);
  assert.equal(tools.getByAlias("test_delegate"), tool);
  tools.unregister(tool.name);
  tools.register(tool);
  assertDisabled(tools, tool.name);
});

test("global save enables delegation explicitly and reset restores off", async () => {
  const { tools, repl, persisted } = fixture();
  const overrides = Object.fromEntries(names.map(name => [name, true]));
  assert.equal((await repl.setGlobalTools(overrides)).ok, true);
  assert.deepEqual(persisted().global, overrides);
  for (const name of names) {
    assert.ok(tools.get(name));
    assert.equal(repl.globalTools().items.find(tool => tool.name === name)?.configuredEnabled, true);
    assert.equal(repl.sessionTools().items.find(tool => tool.name === name)?.effectiveEnabled, true);
  }
  assert.equal((await repl.setGlobalTools({})).ok, true);
  for (const name of names) assertDisabled(tools, name);
});

test("session opt-in, inherit, reload and global/session precedence stay consistent", async () => {
  const { tools, repl } = fixture({ subagent_run: true }, { subagent_run: false, subagent_get: true });
  assertDisabled(tools, "subagent_run");
  assert.ok(tools.get("subagent_get"));
  assert.equal((await repl.setSessionTools({ subagent_run: "inherit", subagent_output: "enabled" })).ok, true);
  assert.ok(tools.get("subagent_run"));
  assert.ok(tools.get("subagent_output"));
  assertDisabled(tools, "subagent_get");
  assert.equal((await repl.setGlobalTools({})).ok, true);
  assertDisabled(tools, "subagent_run");
  assert.ok(tools.get("subagent_output"), "session opt-in survives global reset");
  tools.setEnabled("subagent_output", false);
  await repl.loadSessionTools("test-session");
  assert.ok(tools.get("subagent_output"), "saved session opt-in reloads");
  assert.equal((await repl.setSessionTools({ subagent_output: "inherit" })).ok, true);
  for (const name of names) assertDisabled(tools, name);
});

test("child registries preserve permitted explicit opt-ins but never allow nested delegation", () => {
  const { tools } = fixture({ subagent_get: true, subagent_run: true, subagent_resume: true });
  const child = resolveAgentTools(tools, { ...GENERAL_PURPOSE_AGENT, tools: ["*"], disallowedTools: [] });
  assert.ok(child.get("subagent_get"));
  assert.equal(child.get("subagent_run"), undefined);
  assert.equal(child.get("subagent_resume"), undefined);
  assert.ok(child.get("subagent_report"), "child-only report channel remains functional");
});
