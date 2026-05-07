import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { InMemoryAppState } from "../app/app-state.js";
import type { ModelGateway, ModelRequest, ModelStreamEvent } from "../model/model-gateway.js";
import { QueryEngine } from "../core/query-engine.js";
import { ToolRegistry } from "../tools/registry.js";
import { runToolUse } from "../tools/run-tool-use.js";
import type { ToolUseContext } from "../tools/tool.js";
import { createTextMessage } from "../types/messages.js";
import { echoTool } from "../tools/builtins/echo-tool.js";
import { createAgentTool } from "./agent-tool.js";
import { StaticAgentCatalog, GENERAL_PURPOSE_AGENT } from "./agent-definition.js";
import { createTaskTools } from "../tasks/task-tools.js";
import { TaskStore } from "../tasks/task-store.js";

class ParentAndSubagentGateway implements ModelGateway {
  parentCalls = 0;
  subagentCalls = 0;

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    if (request.queryOrigin === "subagent") {
      this.subagentCalls += 1;
      const lastPrompt = request.messages.at(-1)?.blocks
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n") ?? "";
      const content = request.tools.length === 0 && lastPrompt.includes("short title")
        ? "Delegate Once Smoke Title"
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
  tools.register(echoTool);
  for (const tool of createTaskTools(taskStore)) tools.register(tool);
  tools.register(createAgentTool({
    modelGateway: gateway,
    tools,
    taskStore,
    agentCatalog: new StaticAgentCatalog([GENERAL_PURPOSE_AGENT]),
  }));

  const engine = new QueryEngine({ modelGateway: gateway, tools, maxTurns: 4, session: { rootDir: sessionRoot } });
  const events: string[] = [];
  for await (const event of engine.sendUserText("delegate once")) {
    events.push(event.type === "terminal" ? `${event.type}:${event.reason}` : event.type);
  }

  const listedSessions = await engine.listSessions(1);
  const syncOk =
    gateway.subagentCalls === 2 &&
    events.includes("tool.started") &&
    events.includes("tool.finished") &&
    events.includes("terminal:completed") &&
    listedSessions[0]?.title === "Delegate Once Smoke Title";

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

  const task = taskId ? taskStore.get(taskId) : undefined;
  const outputText = JSON.stringify(output.map((update) => update.message.blocks));
  const sendOk = send.at(-1)?.message.blocks.some((block) => block.type === "tool_result" && block.ok) ?? false;
  const listOk = list.at(-1)?.message.blocks.some((block) => block.type === "tool_result" && block.ok) ?? false;
  const outputFileOk = Boolean(task?.outputFile && existsSync(task.outputFile));
  const asyncOk = Boolean(taskId && task?.status === "completed" && outputText.includes("retrieval_status") && sendOk && listOk && outputFileOk);

  const ok = syncOk && asyncOk;
  console.log(JSON.stringify({ ok, syncOk, asyncOk, outputFileOk, sessionTitle: listedSessions[0]?.title, events, parentCalls: gateway.parentCalls, subagentCalls: gateway.subagentCalls, taskId, taskStatus: task?.status, outputFile: task?.outputFile }, null, 2));
  if (!ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
