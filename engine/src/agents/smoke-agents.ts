import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { InMemoryAppState } from "../app/app-state.js";
import type { ModelGateway, ModelRequest, ModelStreamEvent } from "../model/model-gateway.js";
import { QueryEngine } from "../core/query-engine.js";
import { finalizeAgentTool, resolveAgentTools } from "../core/run-agent.js";
import { ToolRegistry } from "../tools/registry.js";
import { runToolUse } from "../tools/run-tool-use.js";
import type { Tool, ToolUseContext } from "../tools/tool.js";
import { createTextMessage } from "../types/messages.js";
import { createAgentTool } from "./agent-tool.js";
import { StaticAgentCatalog, EXPLORE_AGENT, GENERAL_PURPOSE_AGENT } from "./agent-definition.js";
import { createSubagentTools } from "../tasks/subagent-tools.js";
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
    async call(_input, _context, options) {
      if (name === "terminal_run") options.onProgress?.({ toolName: name, message: "terminal output", channel: "stdout", operation: "append", key: "output", data: { type: "terminal.output.delta", stream: "stdout", text: "child-output" } });
      if (name === "file_read") options.onProgress?.({ toolName: name, message: "patch output", channel: "patch", operation: "append", key: "patch", data: { patch: "child-patch" } });
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
  reportRecoveryPrompts = 0;
  forcedReportToolChoices = 0;

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
      const isTitleRequest = allPromptText.includes("Summarize this session as a short title") || allPromptText.includes("Refine this existing session title");
      if (lastPrompt.includes("REQUIRED FINALIZATION:")) this.reportRecoveryPrompts += 1;
      if (request.toolChoice && typeof request.toolChoice === "object" && request.toolChoice.type === "function" && request.toolChoice.name === "subagent_report") {
        this.forcedReportToolChoices += 1;
      }
      const hasToolResult = request.messages.some((message) => message.blocks.some((block) => block.type === "tool_result"));
      const hasAgentReportResult = request.messages.some((message) =>
        message.blocks.some((block) => block.type === "tool_result" && block.name === "subagent_report"),
      );
      const hasFinalAgentReportResult = request.messages.some((message) =>
        message.blocks.some((block) => {
          if (block.type !== "tool_result" || block.name !== "subagent_report" || !block.ok) return false;
          const output = block.output;
          if (!output || typeof output !== "object") return false;
          const status = (output as { status?: unknown }).status;
          const final = (output as { final?: unknown }).final;
          return final === true || status === "completed" || status === "incomplete";
        }),
      );
      if (isExploreSmoke && !hasToolResult && !lastPrompt.includes("REQUIRED FINALIZATION:")) {
        yield {
          type: "tool_use",
          toolUse: {
            id: "call_explore_list",
            name: "file_list",
            input: {},
          },
        };
        yield { type: "response_completed", responseId: `sub_${this.subagentCalls}`, stopReason: "tool_calls" };
        return;
      }
      if (isExploreSmoke && !hasFinalAgentReportResult && lastPrompt.includes("REQUIRED FINALIZATION:")) {
        yield {
          type: "tool_use",
          toolUse: {
            id: "call_explore_report_final",
            name: "subagent_report",
            input: {
              content: [
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
              ].join("\n"),
              status: "completed",
            },
          },
        };
        yield { type: "response_completed", responseId: `sub_${this.subagentCalls}`, stopReason: "tool_calls" };
        return;
      }
      if (isExploreSmoke && !hasAgentReportResult) {
        yield {
          type: "tool_use",
          toolUse: {
            id: "call_explore_report_draft",
            name: "subagent_report",
            input: { content: "## Draft\n- src/agents/agent-definition.ts inspection is in progress.", status: "draft" },
          },
        };
        yield { type: "response_completed", responseId: `sub_${this.subagentCalls}`, stopReason: "tool_calls" };
        return;
      }
      if (isExploreSmoke && hasAgentReportResult && !hasFinalAgentReportResult) {
        yield { type: "assistant_message", message: createTextMessage("assistant", "我将继续做只读检查，重新获取关键文件内容以避免依赖已清理的上下文。") };
        yield { type: "response_completed", responseId: `sub_${this.subagentCalls}`, stopReason: "completed" };
        return;
      }

      if (!isTitleRequest && !hasFinalAgentReportResult) {
        const workerToolName = hasToolResult ? "subagent_report" : "terminal_run";
        yield {
          type: "tool_use",
          toolUse: {
            id: `call_worker_${workerToolName}_${this.subagentCalls}`,
            name: workerToolName,
            input: workerToolName === "subagent_report"
              ? { content: `worker result: ${lastPrompt.slice(0, 24)}`, status: "completed" }
              : {},
          },
        };
        yield { type: "response_completed", responseId: `sub_${this.subagentCalls}`, stopReason: "tool_calls" };
        return;
      }

      const content = isTitleRequest && lastPrompt.includes("Previous title:")
        ? "Refined Delegate Smoke Title"
        : isTitleRequest && lastPrompt.includes("short title")
          ? "Delegate Once Smoke Title"
          : isExploreSmoke
            ? "我将继续做只读检查，重新获取关键文件内容以避免依赖已清理的上下文。"
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
          name: "subagent_run",
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
  for (const name of ["file_list", "file_read", "file_search", "web_search", "plan_update"]) tools.register(makeSmokeTool(name, true));
  for (const name of ["file_edit", "file_write", "terminal_run", "terminal_control"]) tools.register(makeSmokeTool(name, false));
  tools.register(smokePassthroughTool);
  for (const tool of createSubagentTools(taskStore)) tools.register(tool);
  tools.register(createAgentTool({
    modelGateway: gateway,
    tools,
    taskStore,
    agentCatalog: new StaticAgentCatalog([GENERAL_PURPOSE_AGENT, EXPLORE_AGENT]),
  }));
  const exploreToolNames = new Set(resolveAgentTools(tools, EXPLORE_AGENT).names());
  const exploreToolsOk =
    ["file_list", "file_read", "file_search", "web_search", "terminal_run", "terminal_control", "subagent_report"].every((name) => exploreToolNames.has(name)) &&
    ["file_edit", "file_write", "subagent_run", "plan_update", "smoke_passthrough"].every((name) => !exploreToolNames.has(name));

  process.env.AGENT_SESSION_TITLE_DELAY_MS = "0";
  const engine = new QueryEngine({ modelGateway: gateway, tools, maxTurns: 4, session: { rootDir: sessionRoot } });
  const events: string[] = [];
  const childProgressChannels: string[] = [];
  for await (const event of engine.sendUserText("delegate once")) {
    events.push(event.type === "terminal" ? `${event.type}:${event.reason}` : event.type);
    if (event.type === "tool.progress" && event.toolUse.name === "subagent_run" && event.progress.channel) childProgressChannels.push(event.progress.channel);
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
  const childSessionRoot = path.join(listedSessions[0]?.sessionDir ?? "", "subagents");
  const childSessionEntries = listedSessions[0]
    ? await fs.readdir(childSessionRoot, { withFileTypes: true }).catch(() => [])
    : [];
  const childTranscriptOk = childSessionEntries.some((entry) =>
    entry.isDirectory() && existsSync(path.join(childSessionRoot, entry.name, "transcript.jsonl")),
  );
  const childSessionsHiddenFromList = listedSessions.length === 1;
  const syncOk =
    afterInitialTitleCalls === 3 &&
    afterRefinementTitleCalls === afterInitialTitleCalls + 1 &&
    events.includes("tool.started") &&
    events.includes("tool.finished") &&
    events.includes("terminal:completed") &&
    listedSessions[0]?.title === "Refined Delegate Smoke Title" &&
    childTranscriptOk &&
    childSessionsHiddenFromList;

  let inheritedToolResultMemoryCalls = 0;
  const inheritedToolResultMemory: NonNullable<ToolUseContext["toolResultMemory"]> = {
    state: { seenIds: new Set(), replacements: new Map() },
    async processToolResult(_toolUseId, output) {
      inheritedToolResultMemoryCalls += 1;
      return { output };
    },
    async applyBudget(messages) {
      return { messages: [...messages], records: [] };
    },
  };
  const context: ToolUseContext = {
    agentId: "main",
    tools,
    appState: new InMemoryAppState("main"),
    messages: [createTextMessage("user", "parent context")],
    toolResultMemory: inheritedToolResultMemory,
    emit: () => undefined,
  };

  const launch = await runToolUse({
    id: "call_agent_async",
    name: "subagent_run",
    input: { prompt: "background check", description: "background worker", run_in_background: true, name: "bg1" },
  }, context);
  const launchResult = launch.at(-1)?.message.blocks.find((block) => block.type === "tool_result");
  const taskId = (launchResult?.type === "tool_result" && typeof launchResult.output === "object" && launchResult.output)
    ? (launchResult.output as { task_id?: string }).task_id
    : undefined;

  if (taskId) await taskStore.waitForTerminal(taskId, { timeoutMs: 30000 });

  const output = taskId ? await runToolUse({
    id: "call_task_output",
    name: "subagent_output",
    input: { task_id: taskId, block: false },
  }, context) : [];
  const send = await runToolUse({
    id: "call_send",
    name: "subagent_message",
    input: { target: "bg1", message: "follow up" },
  }, context);
  const list = await runToolUse({ id: "call_list", name: "subagent_list", input: {} }, context);
  const memoryCallsBeforeExplore = inheritedToolResultMemoryCalls;

  const explore = await runToolUse({
    id: "call_agent_explore",
    name: "subagent_run",
    input: { prompt: "map readonly paths", description: "explore worker", mode: "explore" },
  }, context);
  const exploreResult = explore.flatMap((update) => update.message.blocks).find((block) => block.type === "tool_result");
  const exploreOutput = exploreResult?.type === "tool_result" && typeof exploreResult.output === "object" && exploreResult.output
    ? exploreResult.output as { agent_type?: string; status?: string; content?: string; total_tool_use_count?: number }
    : undefined;
  const exploreContent = exploreOutput?.content ?? "";
  const exploreReportOk =
    countMarkdownSections(exploreContent) >= 3 &&
    hasListItem(exploreContent) &&
    hasLikelyFilePath(exploreContent);
  const exploreNoProgressOnly = !/(?:接下来|继续读取|继续探索|I will continue|next I will)/i.test(exploreContent);
  const exploreDraftDidNotEndRun = (exploreOutput?.total_tool_use_count ?? 0) >= 3;
  const exploreInheritedToolResultMemory = inheritedToolResultMemoryCalls > memoryCallsBeforeExplore;
  const exploreOk =
    exploreResult?.type === "tool_result" &&
    exploreResult.ok === true &&
    exploreOutput?.status === "completed" &&
    exploreOutput.agent_type === EXPLORE_AGENT.agentType &&
    gateway.reportRecoveryPrompts === 1 &&
    gateway.forcedReportToolChoices >= 1 &&
    exploreInheritedToolResultMemory &&
    exploreDraftDidNotEndRun &&
    exploreReportOk &&
    exploreNoProgressOnly;

  const missingReport = finalizeAgentTool({
    agentId: "explore_missing_report",
    agentType: EXPLORE_AGENT.agentType,
    agent: EXPLORE_AGENT,
    messages: [createTextMessage("assistant", "I will continue checking files.")],
    durationMs: 0,
    totalToolUseCount: 1,
  });
  const missingReportOk =
    missingReport.status === "incomplete" &&
    missingReport.content.includes("Subagent ended without a final subagent_report") &&
    missingReport.content.includes("## Partial output");

  const task = taskId ? taskStore.get(taskId) : undefined;
  const outputText = JSON.stringify(output.map((update) => update.message.blocks));
  const sendOk = send.at(-1)?.message.blocks.some((block) => block.type === "tool_result" && block.ok) ?? false;
  const listOk = list.at(-1)?.message.blocks.some((block) => block.type === "tool_result" && block.ok) ?? false;
  const outputFileOk = Boolean(task?.outputFile && existsSync(task.outputFile));
  const asyncOk = Boolean(taskId && task?.status === "completed" && outputText.includes("retrieval_status") && sendOk && listOk && outputFileOk);

  const childProgressSemanticsOk = childProgressChannels.includes("stdout");
  const ok = syncOk && asyncOk && exploreToolsOk && exploreOk && missingReportOk && childProgressSemanticsOk;
  console.log(JSON.stringify({ ok, syncOk, asyncOk, exploreToolsOk, exploreOk, missingReportOk, childProgressSemanticsOk, childProgressChannels, exploreReportOk, exploreDraftDidNotEndRun, exploreInheritedToolResultMemory, inheritedToolResultMemoryCalls, memoryCallsBeforeExplore, exploreNoProgressOnly, exploreOutput, outputFileOk, sessionTitle: listedSessions[0]?.title, childTranscriptOk, childSessionsHiddenFromList, childSessionRoot, childSessionEntries: childSessionEntries.map((entry) => entry.name), events, parentCalls: gateway.parentCalls, subagentCalls: gateway.subagentCalls, reportRecoveryPrompts: gateway.reportRecoveryPrompts, forcedReportToolChoices: gateway.forcedReportToolChoices, afterInitialTitleCalls, afterRefinementTitleCalls, taskId, taskStatus: task?.status, taskAgentType: task?.agentType, outputFile: task?.outputFile }, null, 2));
  if (!ok) process.exitCode = 1;
}

function countMarkdownSections(text: string): number {
  return text.match(/(?:^|\n)#{2,6}\s+\S/g)?.length ?? 0;
}

function hasListItem(text: string): boolean {
  return /(?:^|\n)\s*[-*]\s+\S/.test(text);
}

function hasLikelyFilePath(text: string): boolean {
  return /(?:^|\n)\s*[-*]\s+(?:[A-Za-z]:)?[^\n:]{0,160}(?:[\\/][^\n:]+|\.[A-Za-z0-9]{1,12})(?::|\s+-|\s+—|\s+–|\s|$)/.test(text);
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
