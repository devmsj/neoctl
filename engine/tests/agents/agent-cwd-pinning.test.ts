import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAgentTool, type AgentToolRuntime } from "../../src/agents/agent-tool.js";
import { AgentActivityStore } from "../../src/agents/agent-activity.js";
import { GENERAL_PURPOSE_AGENT, StaticAgentCatalog } from "../../src/agents/agent-definition.js";
import { TaskStore } from "../../src/tasks/task-store.js";
import { InMemoryAppState } from "../../src/app/app-state.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import type { ToolUseContext } from "../../src/tools/tool.js";
import type { ModelGateway, ModelStreamEvent } from "../../src/model/model-gateway.js";
import { createTextMessage } from "../../src/types/messages.js";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));
async function until(check: () => boolean) {
  for (let i = 0; i < 1000; i++) { if (check()) return; await tick(); }
  throw new Error("Timed out waiting for fake-model lifecycle");
}

for (const background of [false, true]) test(`${background ? "async" : "sync"} subagent keeps the launch-time cwd when the parent cwd changes later`, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "neo-agent-cwd-"));
  try {
    const launchCwd = path.join(root, "launch"), laterCwd = path.join(root, "later");
    const appState = new InMemoryAppState("parent", launchCwd);
    const parent = { agentId: "parent", messages: [], appState, session: { sessionId: "parent", sessionDir: root },
      options: { mainLoopModel: "fake-model" } } as unknown as ToolUseContext;
    const cwds: (string | undefined)[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const store = new TaskStore();
    store.bindSession(root);
    const gateway: ModelGateway = { async *stream(): AsyncIterable<ModelStreamEvent> {
      await gate;
      yield { type: "assistant_message", message: { ...createTextMessage("assistant", "DONE"), blocks: [{ type: "text", text: "DONE", displayChannel: "visible" }] } };
      yield { type: "response_completed", stopReason: "completed" };
    } };
    const runtime: AgentToolRuntime = { taskStore: store, modelGateway: gateway, tools: new ToolRegistry(), agentActivityStore: new AgentActivityStore(),
      agentCatalog: new StaticAgentCatalog([{ ...GENERAL_PURPOSE_AGENT, requiresReport: false }]),
      contextManager: { async build(input) { cwds.push(input.cwd); return { systemPrompt: "test", promptSections: [], userContext: {}, systemContext: { cwd: input.cwd ?? "" } }; } },
      compactor: { async compact(messages) { return { messages: [...messages], changed: false }; } },
    };
    const call = createAgentTool(runtime).call!({ prompt: "work", run_in_background: background }, parent, {});
    // The parent moves on before the child's first turn is built.
    await until(() => store.list().some(task => task.status === "running"));
    appState.setCwd?.(laterCwd);
    (appState as unknown as { snapshot(): { cwd: string } }).snapshot = () => ({ cwd: laterCwd }) as never;
    release();
    const result = await call;
    assert.equal(result.ok, true);
    const task = store.list()[0]!;
    await until(() => store.get(task.taskId)?.status === "completed");
    assert.equal(task.executionOptions?.cwd, launchCwd);
    assert.ok(cwds.length > 0);
    assert.deepEqual([...new Set(cwds)], [launchCwd], "every child turn uses the cwd captured at launch");
  } finally { await rm(root, { recursive: true, force: true }); }
});
