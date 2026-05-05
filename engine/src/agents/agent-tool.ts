import type { ContextManager } from "../context/context-manager";
import type { Compactor, ContextBudgetOptions } from "../context/compaction";
import type { ModelGateway } from "../model/model-gateway";
import { createTextMessage, type Message } from "../types/messages";
import type { Tool, ToolResult, ToolUseContext } from "../tools/tool";
import type { ToolRegistry } from "../tools/registry";
import { runAgent, type RunAgentDependencies } from "../core/run-agent";
import { createLocalAgentTask, updateProgressFromMessage } from "./local-agent-task";
import {
  FORK_AGENT,
  GENERAL_PURPOSE_AGENT,
  StaticAgentCatalog,
  isForkChildContext,
  type AgentCatalog,
  type AgentDefinition,
  type AgentIsolation,
  type AgentPermissionMode,
} from "./agent-definition";
import { globalTaskStore, type TaskStore } from "../tasks/task-store";

export const AGENT_TOOL_NAME = "agent";

export const AGENT_TOOL_PROMPT_RULES = [
  "Fresh agents do not inherit conversation context; prompts must include goal, relevant files, constraints, and expected output.",
  "Fork agents inherit parent context and should receive a scoped directive, not a full background briefing.",
  "Background agents return an output file and task notification; do not fabricate results before the task completes.",
  "Launch independent agents in the same model turn when parallel work is useful.",
  "Avoid vague delegation; give each worker a concrete scope and say whether edits are allowed.",
].join("\n");

export interface AgentToolInput {
  prompt: string;
  description?: string;
  subagent_type?: string;
  model?: string;
  run_in_background?: boolean;
  name?: string;
  team_name?: string;
  mode?: AgentPermissionMode | "sync" | "background" | "fork";
  isolation?: AgentIsolation;
  cwd?: string;
}

export interface AgentToolRuntime {
  modelGateway: ModelGateway;
  tools: ToolRegistry;
  contextManager?: ContextManager;
  compactor?: Compactor;
  contextBudget?: ContextBudgetOptions;
  taskStore?: TaskStore;
  agentCatalog?: AgentCatalog;
}

export function createAgentTool(runtime?: AgentToolRuntime): Tool<AgentToolInput> {
  return {
    name: AGENT_TOOL_NAME,
    searchHint: "delegate work to a subagent",
    description: [
      "Delegate a scoped task to a subagent.",
      AGENT_TOOL_PROMPT_RULES,
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Complete task instructions for the child agent." },
        description: { type: "string", description: "Short task label for progress and task lists." },
        subagent_type: { type: "string", description: "Agent definition to use. Omit for general-purpose or fork mode." },
        model: { type: "string" },
        run_in_background: { type: "boolean" },
        name: { type: "string", description: "Optional stable name for later SendMessage routing." },
        team_name: { type: "string" },
        mode: { type: "string" },
        isolation: { type: "string", enum: ["shared", "worktree", "remote"] },
        cwd: { type: "string" },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["completed", "async_launched"] },
        agent_id: { type: "string" },
      },
    },
    metadata: { readOnly: false, concurrent: true, visible: true, requiresApproval: false, searchHint: "delegate subagent work" },
    validate(input: unknown): AgentToolInput {
      const value = input as AgentToolInput;
      if (!value.prompt?.trim()) throw new Error("agent.prompt is required");
      return value;
    },
    isConcurrencySafe(input) {
      return Boolean(input.run_in_background || input.mode === "background" || input.mode === "fork");
    },
    async call(input, context, options) {
      if (!runtime) {
        return { ok: false, output: { error: "AgentTool runtime is not configured" } };
      }
      if ((input.mode === "fork" || (!input.subagent_type && input.run_in_background)) && isForkChildContext(context)) {
        return { ok: false, output: { error: "Fork child agents cannot spawn additional subagents" } };
      }

      const catalog = runtime.agentCatalog ?? new StaticAgentCatalog([GENERAL_PURPOSE_AGENT]);
      const fork = input.mode === "fork";
      const agent = fork ? FORK_AGENT : catalog.resolve(input.subagent_type);
      const description = input.description ?? input.prompt.slice(0, 80);
      const background = Boolean(input.run_in_background || input.mode === "background" || fork || agent.background);
      const agentId = makeAgentId(input.name ?? agent.agentType);

      if (input.team_name && input.name) {
        return {
          ok: true,
          output: {
            status: "async_launched",
            agent_id: agentId,
            team_name: input.team_name,
            name: input.name,
            description,
            message: "Teammate routing is represented as a named background agent in this scaffold.",
          },
        };
      }

      if (background) {
        return launchAsyncAgent({ input, context, options, runtime, agent, fork, agentId, description });
      }

      return runSyncAgent({ input, context, runtime, agent, fork, agentId, description });
    },
  };
}

async function runSyncAgent(input: {
  input: AgentToolInput;
  context: ToolUseContext;
  runtime: AgentToolRuntime;
  agent: AgentDefinition;
  fork: boolean;
  agentId: string;
  description: string;
}): Promise<ToolResult> {
  const agentMessages: Message[] = [];
  const stream = runAgent({
    agentId: input.agentId,
    agent: input.agent,
    prompt: input.input.prompt,
    parentContext: input.context,
    parentMessages: input.fork ? input.context.messages : undefined,
    dependencies: buildRunAgentDependencies(input.runtime),
    model: input.input.model,
    maxTurns: input.agent.maxTurns,
    abortSignal: input.context.abortSignal,
    fork: input.fork,
  });

  let completed = await stream.next();
  while (!completed.done) {
    if (completed.value.type === "message") agentMessages.push(completed.value.message);
    completed = await stream.next();
  }

  return {
    ok: true,
    output: {
      status: "completed",
      description: input.description,
      ...completed.value.result,
    },
    newMessages: [createTextMessage("progress", `Subagent ${input.agentId} completed: ${input.description}`)],
  };
}

function launchAsyncAgent(input: {
  input: AgentToolInput;
  context: ToolUseContext;
  options: { onProgress?: (event: { toolName: string; message: string; data?: unknown }) => void };
  runtime: AgentToolRuntime;
  agent: AgentDefinition;
  fork: boolean;
  agentId: string;
  description: string;
}): ToolResult {
  const taskStore = input.runtime.taskStore ?? globalTaskStore;
  const taskId = makeTaskId();
  const abortController = new AbortController();
  const task = createLocalAgentTask({
    taskId,
    agentId: input.agentId,
    description: input.description,
    prompt: input.input.prompt,
    abortController,
  });
  taskStore.upsert(task);
  if (input.input.name) taskStore.registerName(input.input.name, input.agentId);

  void runAsyncAgentLifecycle({ ...input, taskId, taskStore, abortController }).catch((error) => {
    taskStore.fail(taskId, error instanceof Error ? error.message : String(error));
  });

  return {
    ok: true,
    output: {
      status: "async_launched",
      agent_id: input.agentId,
      task_id: taskId,
      description: input.description,
      prompt: input.input.prompt,
      output_file: task.outputFile,
      can_read_output_file: true,
    },
  };
}

async function runAsyncAgentLifecycle(input: {
  input: AgentToolInput;
  context: ToolUseContext;
  runtime: AgentToolRuntime;
  agent: AgentDefinition;
  fork: boolean;
  agentId: string;
  description: string;
  taskId: string;
  taskStore: TaskStore;
  abortController: AbortController;
}): Promise<void> {
  input.taskStore.markRunning(input.taskId);
  const task = input.taskStore.get(input.taskId);
  const stream = runAgent({
    agentId: input.agentId,
    agent: input.agent,
    prompt: input.input.prompt,
    parentContext: input.context,
    parentMessages: input.fork ? input.context.messages : undefined,
    dependencies: buildRunAgentDependencies(input.runtime),
    model: input.input.model,
    maxTurns: input.agent.maxTurns,
    abortSignal: input.abortController.signal,
    fork: input.fork,
  });

  let completed = await stream.next();
  while (!completed.done) {
    const event = completed.value;
    const current = input.taskStore.get(input.taskId);
    if (!current || current.status === "killed") return;
    if (event.type === "message") {
      current.messages.push(event.message);
      updateProgressFromMessage(current, event.message);
      input.taskStore.upsert(current);
    }
    completed = await stream.next();
  }

  input.taskStore.complete(input.taskId, completed.value.result);
  const finished = input.taskStore.get(input.taskId);
  if (finished) {
    finished.messages.push(createTaskNotification(finished.agentId, finished.taskId, finished.status, completed.value.result.content));
    input.taskStore.upsert(finished);
  }
  if (task) task.notified = false;
}

function buildRunAgentDependencies(runtime: AgentToolRuntime): RunAgentDependencies {
  return {
    modelGateway: runtime.modelGateway,
    tools: runtime.tools,
    contextManager: runtime.contextManager,
    compactor: runtime.compactor,
    contextBudget: runtime.contextBudget,
  };
}

function createTaskNotification(agentId: string, taskId: string, status: string, content: string): Message {
  return createTextMessage("user", `<task-notification agent_id="${agentId}" task_id="${taskId}" status="${status}">\n${content}\n</task-notification>`);
}

function makeAgentId(prefix: string): string {
  return `${slug(prefix)}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function makeTaskId(): string {
  return `task_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "agent";
}
