import type { ContextManager } from "../context/context-manager.js";
import type { Compactor, ContextBudgetOptions } from "../context/compaction.js";
import type { ModelGateway } from "../model/model-gateway.js";
import { createTextMessage, type Message } from "../types/messages.js";
import type { Tool, ToolResult, ToolUseContext } from "../tools/tool.js";
import type { ToolRegistry } from "../tools/registry.js";
import { runAgent, type RunAgentDependencies } from "../core/run-agent.js";
import { createLocalAgentTask, updateProgressFromEvent, updateProgressFromMessage } from "./local-agent-task.js";
import {
  EXPLORE_AGENT,
  FORK_AGENT,
  GENERAL_PURPOSE_AGENT,
  StaticAgentCatalog,
  isForkChildContext,
  type AgentCatalog,
  type AgentDefinition,
  type AgentIsolation,
  type AgentPermissionMode,
} from "./agent-definition.js";
import { globalTaskStore, type TaskStore } from "../tasks/task-store.js";
import { globalAgentActivityStore, type AgentActivityStore } from "./agent-activity.js";
import path from "node:path";

export const AGENT_TOOL_NAME = "agent";

export const AGENT_TOOL_PROMPT_RULES = [
  "Fresh agents do not inherit conversation context; prompts must include goal, relevant files, constraints, and expected output.",
  "Fork agents inherit parent context and should receive a scoped directive, not a full background briefing.",
  "Background agents return an output file and task notification; do not fabricate results before the task completes.",
  "Use mode=explore for read-only codebase reconnaissance: file discovery, symbol tracing, architecture summaries, and implementation planning. Explore agents can inspect with exec_command but cannot edit/write or spawn subagents.",
  "To run multiple subagents truly in parallel in one model turn: set parallel=true (sync but concurrent), or run_in_background/mode=background (fire-and-forget with task_id). Without those, subagents run one after another and wall time stacks.",
  "Subagents are bounded by max turns (see agent definitions / AGENT_SUBAGENT_MAX_TURNS) and optional wall time (AGENT_SUBAGENT_WALL_TIMEOUT_MS) so they cannot run indefinitely.",
  "Launch independent agents in the same model turn when parallel work is useful.",
  "Avoid vague delegation; give each worker a concrete scope and say whether edits are allowed.",
].join("\n");

export interface AgentToolInput {
  prompt: string;
  description?: string;
  subagent_type?: string;
  model?: string;
  run_in_background?: boolean;
  /** When true with sync mode, allow concurrent execution with other parallel-safe agent calls in the same turn (multiple model streams). */
  parallel?: boolean;
  name?: string;
  team_name?: string;
  mode?: AgentPermissionMode | "sync" | "background" | "fork" | "explore";
  isolation?: AgentIsolation;
  /** Working directory for this subagent's tools (resolved against parent cwd when relative). */
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
  agentActivityStore?: AgentActivityStore;
}

export function createAgentTool(runtime?: AgentToolRuntime): Tool<AgentToolInput> {
  return {
    name: AGENT_TOOL_NAME,
    searchHint: "delegate work to a subagent",
    description: [
      "Delegate a scoped task to a subagent.",
      "Use parallel=true when issuing multiple agent calls in one turn so they run concurrently; otherwise they execute sequentially.",
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
        mode: { type: "string", description: "Execution/special mode: sync, background, fork, explore, or permission aliases." },
        isolation: { type: "string", enum: ["shared", "worktree", "remote"] },
        cwd: { type: "string", description: "Working directory for child tools (list/read/exec); resolved against parent cwd if relative." },
        parallel: { type: "boolean", description: "Set true when launching multiple independent agents in the same turn so they run concurrently." },
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
      return Boolean(input.run_in_background || input.mode === "background" || input.mode === "fork" || input.mode === "explore" || input.parallel === true);
    },
    async call(input, context, options) {
      if (!runtime) {
        return { ok: false, output: { error: "AgentTool runtime is not configured" } };
      }
      if ((input.mode === "fork" || input.mode === "explore" || input.subagent_type === EXPLORE_AGENT.agentType || (!input.subagent_type && input.run_in_background)) && isForkChildContext(context)) {
        return { ok: false, output: { error: "Fork child agents cannot spawn additional subagents" } };
      }

      const catalog = runtime.agentCatalog ?? new StaticAgentCatalog([GENERAL_PURPOSE_AGENT, EXPLORE_AGENT]);
      const fork = input.mode === "fork";
      const explore = input.mode === "explore";
      const agent = fork ? FORK_AGENT : catalog.resolve(explore ? EXPLORE_AGENT.agentType : input.subagent_type);
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

      return runSyncAgent({ input, context, options, runtime, agent, fork, agentId, description });
    },
  };
}

async function runSyncAgent(input: {
  input: AgentToolInput;
  context: ToolUseContext;
  options: { onProgress?: (event: { toolName: string; message: string; data?: unknown; channel?: "state" | "item" | "stdout" | "stderr" | "patch" | "artifact" | "metric"; operation?: "replace" | "append" | "upsert" | "remove"; key?: string; phase?: string }) => void };
  runtime: AgentToolRuntime;
  agent: AgentDefinition;
  fork: boolean;
  agentId: string;
  description: string;
}): Promise<ToolResult> {
  const agentMessages: Message[] = [];
  const workspaceCwd = resolveAgentWorkspaceCwd(input.input.cwd, input.context);
  const activityStore = input.runtime.agentActivityStore ?? globalAgentActivityStore;
  activityStore.start({
    agentId: input.agentId,
    agentType: input.agent.agentType,
    description: input.description,
    prompt: input.input.prompt,
    mode: resolveAgentActivityMode(input.input, input.fork, "sync"),
    cwd: workspaceCwd,
    model: input.input.model,
  });
  const wall = mergeAbortWithWallClock(input.context.abortSignal, resolveSubagentWallTimeoutMs());
  try {
    const stream = runAgent({
      agentId: input.agentId,
      agent: input.agent,
      prompt: input.input.prompt,
      parentContext: input.context,
      parentMessages: input.fork ? input.context.messages : undefined,
      dependencies: buildRunAgentDependencies(input.runtime),
      model: input.input.model,
      abortSignal: wall?.signal ?? input.context.abortSignal,
      fork: input.fork,
      workspaceCwd,
    });

    input.options.onProgress?.({ toolName: "agent", message: input.description, channel: "state", operation: "replace", phase: "running", data: { agent_id: input.agentId, agent_type: input.agent.agentType } });
    let completed = await stream.next();
    while (!completed.done) {
      activityStore.recordEvent(input.agentId, completed.value);
      emitSyncAgentEvent(input.options.onProgress, input.agentId, completed.value);
      if (completed.value.type === "message") agentMessages.push(completed.value.message);
      completed = await stream.next();
    }
    activityStore.complete(input.agentId, completed.value.result);

    return {
      ok: true,
      output: {
        status: "completed",
        description: input.description,
        ...completed.value.result,
      },
      newMessages: [createTextMessage("progress", `Subagent ${input.agentId} completed: ${input.description}`)],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    activityStore.fail(input.agentId, message);
    return {
      ok: false,
      output: { error: message, description: input.description },
    };
  } finally {
    wall?.dispose();
  }
}

function emitSyncAgentEvent(
  emit: ((event: { toolName: string; message: string; data?: unknown; channel?: "state" | "item" | "stdout" | "stderr" | "patch" | "artifact" | "metric"; operation?: "replace" | "append" | "upsert" | "remove"; key?: string; phase?: string }) => void) | undefined,
  agentId: string,
  event: import("../types/events.js").AgentEvent,
): void {
  if (!emit) return;
  if (event.type === "tool.started") {
    emit({ toolName: "agent", message: childToolPurpose(event.toolUse), channel: "item", operation: "upsert", key: event.toolUse.id, phase: "tool_running", data: { agent_id: agentId, child_event: event } });
    return;
  }
  if (event.type === "tool.progress") {
    emit({ toolName: "agent", message: event.progress.message || childToolPurpose(event.toolUse), channel: "state", operation: "replace", key: event.toolUse.id, phase: event.progress.phase ?? "tool_progress", data: { agent_id: agentId, child_event: event } });
    return;
  }
  if (event.type === "tool.result.available") {
    emit({ toolName: "agent", message: childToolPurpose(event.toolUse), channel: "item", operation: "upsert", key: event.toolUse.id, phase: event.ok ? "tool_completed" : "tool_failed", data: { agent_id: agentId, child_event: event } });
    return;
  }
  if (event.type === "state" && event.phase !== "running_tools") {
    emit({ toolName: "agent", message: event.detail || event.phase, channel: "state", operation: "replace", phase: event.phase, data: { agent_id: agentId } });
  }
}

function childToolPurpose(toolUse: { name: string; input: unknown }): string {
  if (toolUse.input && typeof toolUse.input === "object" && !Array.isArray(toolUse.input)) {
    const input = toolUse.input as Record<string, unknown>;
    const description = typeof input.description === "string" ? input.description.trim() : "";
    if (description) return description;
    if (toolUse.name === "read" && typeof input.path === "string") return `读取 ${path.basename(input.path)}`;
    if (toolUse.name === "list" && typeof input.path === "string") return `查看 ${input.path}`;
    if (toolUse.name === "grep" && typeof input.query === "string") return `搜索 ${input.query}`;
    if (toolUse.name === "exec_command" && typeof input.cmd === "string") return input.cmd;
  }
  return toolUse.name;
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
    agentType: input.agent.agentType,
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
  isResume?: boolean;
  existingMessages?: Message[];
}): Promise<void> {
  input.taskStore.markRunning(input.taskId);
  const task = input.taskStore.get(input.taskId);
  const workspaceCwd = resolveAgentWorkspaceCwd(input.input.cwd, input.context);
  const activityStore = input.runtime.agentActivityStore ?? globalAgentActivityStore;
  const mode = resolveAgentActivityMode(input.input, input.fork, "background");
  activityStore.start({
    agentId: input.agentId,
    taskId: input.taskId,
    agentType: input.agent.agentType,
    description: input.description,
    prompt: input.input.prompt,
    mode,
    cwd: workspaceCwd,
    model: input.input.model,
  });
  const wall = mergeAbortWithWallClock(input.abortController.signal, resolveSubagentWallTimeoutMs());
  try {
    const stream = runAgent({
      agentId: input.agentId,
      agent: input.agent,
      prompt: input.input.prompt,
      parentContext: input.context,
      parentMessages: input.fork ? input.context.messages : undefined,
      dependencies: buildRunAgentDependencies(input.runtime),
      model: input.input.model,
      abortSignal: wall?.signal ?? input.abortController.signal,
      fork: input.fork,
      existingMessages: input.existingMessages,
      workspaceCwd,
    });

    let completed = await stream.next();
    while (!completed.done) {
      const event = completed.value;
      activityStore.recordEvent(input.agentId, event);
      const current = input.taskStore.get(input.taskId);
      if (!current || current.status === "killed") {
        activityStore.fail(input.agentId, "Task killed", "killed");
        return;
      }
      if (event.type !== "message") {
        updateProgressFromEvent(current, event);
        input.taskStore.upsert(current);
      }
      if (event.type === "message") {
        current.messages.push(event.message);
        updateProgressFromMessage(current, event.message);
        input.taskStore.upsert(current);
      }

      if (event.type === "terminal" || completed.done) break;

      const pending = input.taskStore.drainPendingMessages(input.taskId);
      if (pending.length > 0) {
        const currentTask = input.taskStore.get(input.taskId);
        if (currentTask) {
          for (const msg of pending) {
            currentTask.messages.push(msg);
          }
          input.taskStore.upsert(currentTask);
        }
      }

      completed = await stream.next();
    }

    if (!completed.done) {
      let remaining = await stream.next();
      while (!remaining.done) {
        const event = remaining.value;
        activityStore.recordEvent(input.agentId, event);
        const current = input.taskStore.get(input.taskId);
        if (!current || current.status === "killed") {
          activityStore.fail(input.agentId, "Task killed", "killed");
          return;
        }
        if (event.type === "message") {
          current.messages.push(event.message);
          updateProgressFromMessage(current, event.message);
          input.taskStore.upsert(current);
        }
        remaining = await stream.next();
      }
      completed = remaining;
    }

    input.taskStore.complete(input.taskId, completed.value.result);
    activityStore.complete(input.agentId, completed.value.result);
    const finished = input.taskStore.get(input.taskId);
    if (finished) {
      finished.messages.push(createTaskNotification(finished.agentId, finished.taskId, finished.status, completed.value.result.content));
      input.taskStore.upsert(finished);
    }
    if (task) task.notified = false;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    input.taskStore.fail(input.taskId, message);
    activityStore.fail(input.agentId, message);
  } finally {
    wall?.dispose();
  }
}

export function resumeAgentTask(
  taskId: string,
  directive: string | undefined,
  runtime: AgentToolRuntime,
  taskStore: TaskStore,
  parentContext: ToolUseContext,
): Promise<{ ok: boolean; error?: string }> {
  const task = taskStore.get(taskId);
  if (!task) return Promise.resolve({ ok: false, error: `Unknown task: ${taskId}` });
  if (task.type !== "agent") return Promise.resolve({ ok: false, error: `Only agent tasks can be resumed` });

  const catalog = runtime.agentCatalog ?? new StaticAgentCatalog([GENERAL_PURPOSE_AGENT, EXPLORE_AGENT]);
  const agent = catalog.resolve(task.agentType);
  const abortController = new AbortController();

  task.status = "pending";
  task.abortController = abortController;
  task.error = undefined;
  task.completedAt = undefined;
  task.notified = false;
  taskStore.upsert(task);

  void runAsyncAgentLifecycle({
    input: { prompt: directive ?? "Continue where you left off." },
    context: parentContext,
    runtime,
    agent,
    fork: false,
    agentId: task.agentId,
    description: task.description,
    taskId: task.taskId,
    taskStore,
    abortController,
    isResume: true,
    existingMessages: [...task.messages],
  }).catch((error) => {
    taskStore.fail(taskId, error instanceof Error ? error.message : String(error));
  });

  return Promise.resolve({ ok: true });
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

function resolveAgentActivityMode(input: AgentToolInput, fork: boolean, fallback: "sync" | "background") {
  if (input.mode === "explore" || input.subagent_type === EXPLORE_AGENT.agentType) return "explore";
  if (fork) return "fork";
  return fallback;
}

function makeAgentId(prefix: string): string {
  return `${slug(prefix)}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function makeTaskId(): string {
  return `task_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function resolveAgentWorkspaceCwd(inputCwd: string | undefined, parentContext: ToolUseContext): string | undefined {
  if (!inputCwd?.trim()) return undefined;
  const root = path.resolve(parentContext.appState.snapshot().cwd ?? process.cwd());
  const trimmed = inputCwd.trim();
  return path.isAbsolute(trimmed) ? path.normalize(trimmed) : path.resolve(root, trimmed);
}

/** Wall-clock limit for a single subagent run. Default 10 minutes; set AGENT_SUBAGENT_WALL_TIMEOUT_MS=0 to disable. */
function resolveSubagentWallTimeoutMs(): number {
  const raw = process.env.AGENT_SUBAGENT_WALL_TIMEOUT_MS;
  if (raw === undefined || raw === "") return 600000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 600000;
  return n === 0 ? 0 : Math.floor(n);
}

function mergeAbortWithWallClock(
  parent: AbortSignal | undefined,
  wallMs: number,
): { signal: AbortSignal; dispose: () => void } | undefined {
  if (wallMs <= 0) return undefined;
  const controller = new AbortController();
  const tid = setTimeout(() => {
    controller.abort(new Error(`Subagent wall-clock timeout after ${wallMs}ms (set AGENT_SUBAGENT_WALL_TIMEOUT_MS=0 to disable)`));
  }, wallMs);
  const onParentAbort = () => {
    clearTimeout(tid);
    if (!controller.signal.aborted) controller.abort(parent?.reason ?? new Error("Aborted"));
  };
  parent?.addEventListener("abort", onParentAbort, { once: true });
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(tid);
      parent?.removeEventListener("abort", onParentAbort);
    },
  };
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "agent";
}
