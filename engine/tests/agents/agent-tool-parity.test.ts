import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAgentTool, type AgentToolRuntime } from "../../src/agents/agent-tool.js";
import { AgentActivityStore } from "../../src/agents/agent-activity.js";
import { GENERAL_PURPOSE_AGENT } from "../../src/agents/agent-definition.js";
import { resolveAgentTools } from "../../src/core/run-agent.js";
import { TaskStore } from "../../src/tasks/task-store.js";
import { InMemoryAppState } from "../../src/app/app-state.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import type { Tool, ToolUseContext } from "../../src/tools/tool.js";
import type { ModelGateway, ModelStreamEvent } from "../../src/model/model-gateway.js";
import { createTextMessage } from "../../src/types/messages.js";

const tool = (name: string, extra: Partial<Tool> = {}): Tool => ({ name, description: name, inputSchema: { type: "object" },
  metadata: { readOnly: true, concurrent: true, visible: true }, async call() { return { ok: true, output: name }; }, ...extra } as Tool);
// Like image_inspect: available only when the *current* model supports images, unknown without a context.
const visionOnly = tool("image_inspect", { isEnabled: (context?: ToolUseContext) => context?.options?.mainLoopModel === "vision-model" });
function parentTools() {
  const registry = new ToolRegistry();
  for (const item of [visionOnly, tool("file_read"), tool("file_edit"), tool("file_write"), tool("plan_update"), tool("subagent_run"), tool("subagent_resume"), tool("subagent_list"), tool("off_in_parent"), tool("helper", { metadata: { readOnly: true, concurrent: true, visible: false } })]) registry.register(item);
  registry.setEnabled("off_in_parent", false);
  return registry;
}
const context = (model: string) => ({ options: { mainLoopModel: model } }) as unknown as ToolUseContext;
const visible = (registry: ToolRegistry, model: string) => registry.list(context(model), { includeDeferred: true }).map(item => item.name).sort();

test("a subagent has exactly the parent's tools; only explicit lists restrict them", () => {
  const child = resolveAgentTools(parentTools(), GENERAL_PURPOSE_AGENT);
  assert.deepEqual(visible(child, "vision-model"), ["file_edit", "file_read", "file_write", "image_inspect", "plan_update", "subagent_list", "subagent_report"],
    "context-dependent tools are judged per child turn, not dropped up front; parent-disabled and hidden stay so");
  assert.deepEqual(visible(child, "text-model").includes("image_inspect"), false, "the child's own model decides image availability");
  assert.equal(child.isEnabled("off_in_parent"), false);
  assert.equal(child.names({ includeDisabled: true }).includes("helper"), true);
  assert.equal(child.isEnabled("subagent_run"), undefined, "scheduling stays with the main agent");
  const restricted = resolveAgentTools(parentTools(), GENERAL_PURPOSE_AGENT, ["image_inspect", "file_write"]);
  assert.deepEqual(visible(restricted, "vision-model"), ["file_edit", "file_read", "plan_update", "subagent_list", "subagent_report"]);
});

test("disallowed_tools is the only tool control and is validated against the main agent's tools", async () => {
  const store = new TaskStore();
  const runtime = { taskStore: store, tools: parentTools() } as unknown as AgentToolRuntime;
  const parent = { agentId: "parent", messages: [], appState: new InMemoryAppState("parent", process.cwd()) } as unknown as ToolUseContext;
  const unknown = await createAgentTool(runtime).call!({ prompt: "x", disallowed_tools: ["file_edit", "ghost"] }, parent, {});
  assert.equal(unknown.ok, false);
  assert.match(JSON.stringify(unknown.output), /Unknown tool name\(s\) in disallowed_tools: ghost/);
  assert.equal(store.list().length, 0, "no task is created for rejected tool control");
  const schema = createAgentTool(runtime).inputSchema as { properties: Record<string, unknown> };
  assert.equal("tools" in schema.properties, false, "no allowlist: the main agent blocks, it does not list");
  for (const mode of ["explore", "fork"]) assert.throws(() => createAgentTool(runtime).validate!({ prompt: "x", mode } as never, parent), /mode must be sync or background/);
});

test("disallowed_tools from the main agent reaches the child request and survives persistence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "neo-agent-parity-"));
  try {
    const store = new TaskStore();
    store.bindSession(root);
    const requested: string[][] = [];
    const gateway: ModelGateway = { async *stream(request): AsyncIterable<ModelStreamEvent> {
      requested.push((request.tools ?? []).map(definition => definition.name).sort());
      yield { type: "assistant_message", message: { ...createTextMessage("assistant", "OK"), blocks: [{ type: "text", text: "OK", displayChannel: "visible" }] } };
      yield { type: "response_completed", stopReason: "completed" };
    } };
    const runtime: AgentToolRuntime = { taskStore: store, modelGateway: gateway, tools: parentTools(), agentActivityStore: new AgentActivityStore(),
      agent: { ...GENERAL_PURPOSE_AGENT, requiresReport: false },
      contextManager: { async build(input) { return { systemPrompt: "test", promptSections: [], userContext: {}, systemContext: { cwd: input.cwd ?? "", platform: process.platform } }; } },
      compactor: { async compact(messages) { return { messages: [...messages], changed: false }; } },
    };
    const parent = { agentId: "parent", messages: [], appState: new InMemoryAppState("parent", root), session: { sessionId: "parent", sessionDir: root },
      options: { mainLoopModel: "vision-model" } } as unknown as ToolUseContext;
    const plain = await createAgentTool(runtime).call!({ prompt: "default" }, parent, {});
    assert.equal(plain.ok, true);
    assert.ok(requested[0]!.includes("image_inspect"), "default child sees image_inspect like the parent");
    const limited = await createAgentTool(runtime).call!({ prompt: "limited", disallowed_tools: ["image_inspect", " file_edit ", "image_inspect"] }, parent, {});
    assert.equal(limited.ok, true);
    assert.equal(requested[1]!.includes("image_inspect"), false);
    assert.equal(requested[1]!.includes("file_edit"), false);
    const task = store.list().find(item => item.executionOptions?.disallowedTools)!;
    assert.deepEqual(task.executionOptions?.disallowedTools, ["image_inspect", "file_edit"]);
    store.flush();
    const restored = new TaskStore();
    restored.bindSession(root);
    assert.deepEqual(restored.get(task.taskId)?.executionOptions?.disallowedTools, ["image_inspect", "file_edit"], "resume keeps the explicit restriction");
  } finally { await rm(root, { recursive: true, force: true }); }
});
