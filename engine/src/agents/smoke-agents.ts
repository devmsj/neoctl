import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { InMemoryAppState } from "../app/app-state.js";
import type { ModelGateway, ModelRequest, ModelStreamEvent } from "../model/model-gateway.js";
import { QueryEngine } from "../core/query-engine.js";
import { resolveAgentTools } from "../core/run-agent.js";
import { ToolRegistry } from "../tools/registry.js";
import { runToolUse } from "../tools/run-tool-use.js";
import type { Tool, ToolUseContext } from "../tools/tool.js";
import { createTextMessage } from "../types/messages.js";
import { createAgentTool } from "./agent-tool.js";
import { StaticAgentCatalog, EXPLORE_AGENT, GENERAL_PURPOSE_AGENT } from "./agent-definition.js";
import { createTaskTools } from "../tasks/task-tools.js";
import { TaskStore } from "../tasks/task-store.js";

function makeSmokeTool(name: string, readOnly: boolean): Tool<Record<string, never>> {
  return {
    name,
    description: `Smoke test ${name} tool.`,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    metadata: { readOnly, concurrent: true, visible: true },
    validate() {
      return {};
    },
    async call() {
      return { ok: true, output: name };
    },
  };
}

const smokePassthroughTool: Tool<{ text: string }> = {
  name: "smoke_passthrough",
  description: "Smoke test passthrough tool.",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
    additionalProperties: false,
  },
  metadata: { readOnly: true, concurrent: true, visible: true },
  validate(input) {
    return input as { text: string };
  },
  async call(input) {
    return { ok: true, output: input.text };
  },
};

class ParentAndSubagentGateway implements ModelGateway {
  parentCalls = 0;
  subagentCalls = 0;

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    if (request.queryOrigin === "subagent") {
      this.subagentCalls += 1;
      const allPromptText = request.messages
        .flatMap((message) => message.blocks)
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      const lastPrompt = request.messages.at(-1)?.blocks
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n") ?? "";
      const isExploreSmoke = allPromptText.includes("map readonly paths");
      if (isExploreSmoke && !request.messages.some((message) => message.blocks.some((block) => block.type === "tool_result"))) {
        yield {
          type: "tool_use",
          toolUse: {
            id: "call_explore_list",
            name: "list",
            input: {},
          },
        };
        yield { type: "response_completed", responseId: `sub_${this.subagentCalls}`, stopReason: "tool_calls" };
        return;
      }

      const content = request.tools.length === 0 && lastPrompt.includes("Previous title:")
        ? "Refined Delegate Smoke Title"
        : request.tools.length === 0 && lastPrompt.includes("short title")
          ? "Delegate Once Smoke Title"
          : isExploreSmoke
            ? [
                "## Scope",
                "Map readonly paths.",
                "",
                "## Relevant files inspected",
                "- src/agents/agent-definition.ts: explore agent definition.",
                "",
                "## Key findings",
                "- src/agents/agent-definition.ts defines the explore agent as read-only.",
                "",
                "## Risks / unknowns",
                "- Smoke gateway uses synthetic tool output only.",
                "",
                "## Suggested next steps",
                "- Run the real explore agent against a repository fixture.",
              ].join("\n")
            : `worker result: ${lastPrompt.slice(0, 24)}`;
      yield { type: "assistant_message", message: createTextMessage("assistant", content) };
      yield { type: "response_completed", responseId: `sub_${this.subagentCalls}`, stopReason: "completed" };
      return;
    }

    this.parentCalls += 1;
    const hasToolResult = request.messages.some((message) => message.blocks.some((block) => block.type === "tool_result"));
    if (!hasToolResult) {
      yield {
        type: "tool_use",
        toolUse: {
          id: "call_agent_sync",
          name: "agent",
          input: { prompt: "investigate sync path", description: "sync investigation" },
        },
      };
      yield { type: "response_completed", responseId: "parent_1", stopReason: "tool_calls" };
      return;
    }

    yield { type: "assistant_message", message: createTextMessage("assistant", "parent done") };
    yield { type: "response_completed", responseId: "parent_2", stopReason: "completed" };
  }
}

async function main(): Promise<void> {
  const gateway = new ParentAndSubagentGateway();
  const sessionRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-title-smoke-"));
  const taskStore = new TaskStore();
  const tools = new ToolRegistry();
  for (const name of ["list", "read", "grep", "search", "plan"]) tools.register(makeSmokeTool(name, true));
  for (const name of ["edit", "write", "exec"]) tools.register(makeSmokeTool(name, false));
  tools.register(smokePassthroughTool);
  for (const tool of createTaskTools(taskStore)) tools.register(tool);
  tools.register(createAgentTool({
    modelGateway: gateway,
    tools,
    taskStore,
    agentCatalog: new StaticAgentCatalog([GENERAL_PURPOSE_AGENT, EXPLORE_AGENT]),
  }));
  const exploreToolNames = new Set(resolveAgentTools(tools, EXPLORE_AGENT).names());
  const exploreToolsOk =
    ["list", "read", "grep", "search", "plan"].every((name) => exploreToolNames.has(name)) &&
    ["edit", "write", "exec", "agent", "smoke_passthrough"].every((name) => !exploreToolNames.has(name));

  process.env.AGENT_SESSION_TITLE_DELAY_MS = "0";
  const engine = new QueryEngine({ modelGateway: gateway, tools, maxTurns: 4, session: { rootDir: sessionRoot } });
  const events: string[] = [];
  for await (const event of engine.sendUserText("delegate once")) {
    events.push(event.type === "terminal" ? `${event.type}:${event.reason}` : event.type);
  }
  await waitFor(async () => (await engine.listSessions(1))[0]?.title === "Delegate Once Smoke Title");
  const afterInitialTitleCalls = gateway.subagentCalls;

  for await (const event of engine.sendUserText("tighten title")) {
    events.push(event.type === "terminal" ? `${event.type}:${event.reason}` : event.type);
  }

  const listedSessions = await waitFor(async () => {
    const listed = await engine.listSessions(1);
    return listed[0]?.title === "Refined Delegate Smoke Title" ? listed : undefined;
  });
  const afterRefinementTitleCalls = gateway.subagentCalls;
  const syncOk =
    afterInitialTitleCalls === 2 &&
    afterRefinementTitleCalls === afterInitialTitleCalls + 1 &&
    events.includes("tool.started") &&
    events.includes("tool.finished") &&
    events.includes("terminal:completed") &&
    listedSessions[0]?.title === "Refined Delegate Smoke Title";

  const context: ToolUseContext = {
    agentId: "main",
    tools,
    appState: new InMemoryAppState("main"),
    messages: [createTextMessage("user", "parent context")],
    emit: () => undefined,
  };

  const launch = await runToolUse({
    id: "call_agent_async",
    name: "agent",
    input: { prompt: "background check", description: "background worker", run_in_background: true, name: "bg1" },
  }, context);
  const launchResult = launch.at(-1)?.message.blocks.find((block) => block.type === "tool_result");
  const taskId = (launchResult?.type === "tool_result" && typeof launchResult.output === "object" && launchResult.output)
    ? (launchResult.output as { task_id?: string }).task_id
    : undefined;

  if (taskId) await taskStore.waitForTerminal(taskId, { timeoutMs: 30000 });

  const output = taskId ? await runToolUse({
    id: "call_task_output",
    name: "TaskOutput",
    input: { task_id: taskId, block: false },
  }, context) : [];
  const send = await runToolUse({
    id: "call_send",
    name: "SendMessage",
    input: { target: "bg1", message: "follow up" },
  }, context);
  const list = await runToolUse({ id: "call_list", name: "TaskList", input: {} }, context);

  const explore = await runToolUse({
    id: "call_agent_explore",
    name: "agent",
    input: { prompt: "map readonly paths", description: "explore worker", mode: "explore" },
  }, context);
  const exploreResult = explore.flatMap((update) => update.message.blocks).find((block) => block.type === "tool_result");
  const exploreOutput = exploreResult?.type === "tool_result" && typeof exploreResult.output === "object" && exploreResult.output
    ? exploreResult.output as { agent_type?: string; status?: string; content?: string; total_tool_use_count?: number }
    : undefined;
  const exploreContent = exploreOutput?.content ?? "";
  const exploreReportOk =
    exploreContent.includes("## Scope") &&
    exploreContent.includes("## Relevant files inspected") &&
    exploreContent.includes("## Key findings") &&
    exploreContent.includes("## Risks / unknowns") &&
    exploreContent.includes("## Suggested next steps");
  const exploreNoProgressOnly = !/(?:接下来|继续读取|继续探索|I will continue|next I will)/i.test(exploreContent);
  const exploreOk =
    exploreResult?.type === "tool_result" &&
    exploreResult.ok === true &&
    exploreOutput?.status === "completed" &&
    exploreOutput.agent_type === EXPLORE_AGENT.agentType &&
    (exploreOutput.total_tool_use_count ?? 0) > 0 &&
    exploreReportOk &&
    exploreNoProgressOnly;

  const task = taskId ? taskStore.get(taskId) : undefined;
  const outputText = JSON.stringify(output.map((update) => update.message.blocks));
  const sendOk = send.at(-1)?.message.blocks.some((block) => block.type === "tool_result" && block.ok) ?? false;
  const listOk = list.at(-1)?.message.blocks.some((block) => block.type === "tool_result" && block.ok) ?? false;
  const outputFileOk = Boolean(task?.outputFile && existsSync(task.outputFile));
  const asyncOk = Boolean(taskId && task?.status === "completed" && outputText.includes("retrieval_status") && sendOk && listOk && outputFileOk);

  const ok = syncOk && asyncOk && exploreToolsOk && exploreOk;
  console.log(JSON.stringify({ ok, syncOk, asyncOk, exploreToolsOk, exploreOk, exploreReportOk, exploreNoProgressOnly, exploreOutput, outputFileOk, sessionTitle: listedSessions[0]?.title, events, parentCalls: gateway.parentCalls, subagentCalls: gateway.subagentCalls, afterInitialTitleCalls, afterRefinementTitleCalls, taskId, taskStatus: task?.status, taskAgentType: task?.agentType, outputFile: task?.outputFile }, null, 2));
  if (!ok) process.exitCode = 1;
}

async function waitFor<T>(read: () => Promise<T | undefined>, timeoutMs = 1000): Promise<T> {
  const startedAt = Date.now();
  let value = await read();
  while (value === undefined && Date.now() - startedAt < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    value = await read();
  }
  if (value === undefined) throw new Error("Timed out waiting for condition");
  return value;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
