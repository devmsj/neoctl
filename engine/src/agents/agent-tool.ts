import type { ContextManager } from "../context/context-manager.js";
import type { Compactor, ContextBudgetOptions } from "../context/compaction.js";
import type { ModelGateway } from "../model/model-gateway.js";
import { createTextMessage, type Message } from "../types/messages.js";
import type { Tool, ToolProgressEvent, ToolResult, ToolUseContext } from "../tools/tool.js";
import type { ToolRegistry } from "../tools/registry.js";
import { runAgent, type RunAgentDependencies } from "../core/run-agent.js";
import { createLocalAgentTask, updateProgressFromEvent, updateProgressFromMessage, type LocalAgentTask } from "./local-agent-task.js";
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

export const AGENT_TOOL_NAME = "subagent_run";

export const AGENT_TOOL_PROMPT_RULES = [
  "Fresh agents do not inherit conversation context; prompts must include goal, relevant files, constraints, and expected output.",
  "Fork agents inherit parent context and should receive a scoped directive, not a full background briefing.",
  "Background agents return an output file and task notification; do not fabricate results before the task completes.",
  "Use mode=explore for read-only codebase reconnaissance: file discovery, symbol tracing, architecture summaries, and implementation planning. Explore agents can inspect with terminal_run but cannot use file_edit/file_write or spawn subagents.",
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
      "Delegate a scoped task with a clear goal, file boundaries and acceptance checks. Subagents cannot delegate further; coordinate through the main agent.",
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
        name: { type: "string", description: "Optional stable name for later subagent_message routing." },
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
      if (context.isSubagent || isForkChildContext(context)) {
        return { ok: false, output: { error: "Subagents cannot delegate additional agents; ask the main agent to coordinate." } };
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
  options: { onProgress?: (event: ToolProgressEvent) => void };
  runtime: AgentToolRuntime;
  agent: AgentDefinition;
  fork: boolean;
  agentId: string;
  description: string;
}): Promise<ToolResult> {
  const taskStore = input.runtime.taskStore ?? globalTaskStore;
  const abortController = new AbortController();
  const task = createLocalAgentTask({ taskId: makeTaskId(), agentId: input.agentId, agentType: input.agent.agentType, description: input.description, prompt: input.input.prompt, abortController });
  task.executionOptions = effectiveExecutionOptions(input.input, input.agent, input.context);
  task.notified = true; // The synchronous caller receives the result directly.
  task.names = input.input.name ? [input.input.name] : [];
  taskStore.attachTask(task, input.context.session?.sessionDir);
  const runGeneration = task.runGeneration;
  const ownsRun = () => {
    const current = taskStore.get(task.taskId);
    return current?.runGeneration === runGeneration && !taskStore.isTerminal(current);
  };
  const cancelled = (): ToolResult => {
    const current = taskStore.get(task.taskId);
    if (current?.runGeneration === runGeneration && current.status === "killed") {
      activityStore.fail(input.agentId, current.error ?? "Task stopped", "killed");
    }
    return { ok: false, output: { status: "cancelled", task_id: task.taskId, agent_id: input.agentId, description: input.description, error: "Task stopped or superseded" } };
  };
  const onParentAbort = () => abortController.abort(input.context.abortSignal?.reason);
  input.context.abortSignal?.addEventListener("abort", onParentAbort, { once: true });
  if (input.context.abortSignal?.aborted) onParentAbort();
  taskStore.markRunning(task.taskId);
  const workspaceCwd = task.executionOptions.cwd;
  const activityStore = input.runtime.agentActivityStore ?? globalAgentActivityStore;
  activityStore.start({
    agentId: input.agentId,
    taskId: task.taskId,
    agentType: input.agent.agentType,
    description: input.description,
    prompt: input.input.prompt,
    mode: resolveAgentActivityMode(input.input, input.fork, "sync"),
    cwd: workspaceCwd,
    model: input.input.model,
  });
  const wall = mergeAbortWithWallClock(abortController.signal, resolveSubagentWallTimeoutMs());
  let stream: ReturnType<typeof runAgent> | undefined;
  try {
    stream = runAgent({
      agentId: input.agentId,
      agent: input.agent,
      prompt: input.input.prompt,
      parentContext: input.context,
      parentMessages: input.fork ? input.context.messages : undefined,
      dependencies: buildRunAgentDependencies(input.runtime),
      ...task.executionOptions,
      onInitialMessages: (messages) => {
        if (ownsRun()) taskStore.reconcileMessages(task.taskId, messages);
      },
      onContextMessagesChanged: (messages) => {
        if (!ownsRun()) return;
        task.messages = [...messages];
        taskStore.confirmDelivery(task.taskId, messages.map((message) => message.id), runGeneration);
        taskStore.upsert(task);
      },
      takePendingMessages: () => ownsRun() ? taskStore.deliverPendingMessages(task.taskId, runGeneration) : [],
      abortSignal: wall?.signal ?? abortController.signal,
      fork: input.fork,
      workspaceCwd,
    });

    input.options.onProgress?.({ toolName: AGENT_TOOL_NAME, message: input.description, channel: "state", operation: "replace", phase: "running", data: { task_id: task.taskId, agent_id: input.agentId, agent_type: input.agent.agentType } });
    let completed = await stream.next();
    while (!completed.done) {
      if (!ownsRun()) return cancelled();
      activityStore.recordEvent(input.agentId, completed.value);
      emitSyncAgentEvent(input.options.onProgress, input.agentId, completed.value);
      if (!ownsRun()) return cancelled();
      if (completed.value.type === "message") {
        updateProgressFromMessage(task, completed.value.message);
      } else updateProgressFromEvent(task, completed.value);
      taskStore.updateProgress(task);
      completed = await stream.next();
    }
    if (!ownsRun()) return cancelled();
    if (completed.value.status === "aborted") {
      taskStore.kill(task.taskId, completed.value.terminalReason);
      activityStore.fail(input.agentId, completed.value.terminalReason, "killed");
      return { ok: false, output: { status: "cancelled", error: completed.value.terminalReason, description: input.description, ...completed.value.result, task_id: task.taskId } };
    }
    if (completed.value.status === "failed") {
      taskStore.fail(task.taskId, completed.value.terminalReason);
      activityStore.fail(input.agentId, completed.value.terminalReason);
      return { ok: false, output: { status: "failed", error: completed.value.terminalReason, description: input.description, ...completed.value.result, task_id: task.taskId } };
    }
    taskStore.complete(task.taskId, completed.value.result);
    if (taskStore.get(task.taskId)?.runGeneration !== runGeneration) return cancelled();
    activityStore.complete(input.agentId, completed.value.result);
    return {
      ok: true,
      output: { status: "completed", description: input.description, ...completed.value.result, task_id: task.taskId },
      newMessages: [createTextMessage("progress", `Subagent ${input.agentId} completed: ${input.description}`)],
    };
  } catch (error) {
    if (!ownsRun()) return cancelled();
    const message = error instanceof Error ? error.message : String(error);
    if (abortController.signal.aborted || wall?.signal.aborted) {
      taskStore.kill(task.taskId, message);
      activityStore.fail(input.agentId, message, "killed");
      return cancelled();
    }
    taskStore.fail(task.taskId, message);
    activityStore.fail(input.agentId, message);
    return {
      ok: false,
      output: { status: "failed", task_id: task.taskId, agent_id: input.agentId, error: message, description: input.description },
    };
  } finally {
    input.context.abortSignal?.removeEventListener("abort", onParentAbort);
    wall?.dispose();
    await stream?.return(undefined as never);
  }
}

function emitSyncAgentEvent(
  emit: ((event: ToolProgressEvent) => void) | undefined,
  agentId: string,
  event: import("../types/events.js").AgentEvent,
): void {
  if (!emit) return;
  const childKey = (key: string | undefined, toolUseId: string) => `${agentId}:${toolUseId}:${key ?? "state"}`;
  if (event.type === "tool.started") {
    emit({ toolName: AGENT_TOOL_NAME, message: childToolPurpose(event.toolUse), channel: "item", operation: "upsert", key: childKey("summary", event.toolUse.id), phase: "tool_running", data: { agent_id: agentId, child_event: event } });
    return;
  }
  if (event.type === "tool.progress") {
    const progress = event.progress;
    emit({
      ...progress,
      toolName: AGENT_TOOL_NAME,
      toolUseId: undefined,
      message: progress.message || childToolPurpose(event.toolUse),
      key: childKey(progress.key, event.toolUse.id),
      data: childProgressData(progress.data, agentId, event),
    });
    return;
  }
  if (event.type === "tool.result.available") {
    emit({ toolName: AGENT_TOOL_NAME, message: childToolPurpose(event.toolUse), channel: "item", operation: "upsert", key: childKey("summary", event.toolUse.id), phase: event.ok ? "tool_completed" : "tool_failed", data: { agent_id: agentId, child_event: event } });
    return;
  }
  if (event.type === "state" && event.phase !== "running_tools") {
    emit({ toolName: AGENT_TOOL_NAME, message: event.detail || event.phase, channel: "state", operation: "replace", key: `${agentId}:agent:state`, phase: event.phase, data: { agent_id: agentId } });
  }
}

function childProgressData(data: unknown, agentId: string, childEvent: import("../types/events.js").AgentEvent): unknown {
  if (data && typeof data === "object" && !Array.isArray(data)) return { ...data, agent_id: agentId, child_event: childEvent };
  return data ?? { agent_id: agentId, child_event: childEvent };
}

function childToolPurpose(toolUse: { name: string; input: unknown }): string {
  if (toolUse.input && typeof toolUse.input === "object" && !Array.isArray(toolUse.input)) {
    const input = toolUse.input as Record<string, unknown>;
    const description = typeof input.description === "string" ? input.description.trim() : "";
    if (description) return description;
    if (toolUse.name === "file_read" && typeof input.path === "string") return `读取 ${path.basename(input.path)}`;
    if (toolUse.name === "file_list" && typeof input.path === "string") return `查看 ${input.path}`;
    if (toolUse.name === "file_search" && typeof input.query === "string") return `搜索 ${input.query}`;
    if (toolUse.name === "terminal_run" && typeof input.cmd === "string") return input.cmd;
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
  task.executionOptions = effectiveExecutionOptions(input.input, input.agent, input.context);
  task.names = input.input.name ? [input.input.name] : [];
  taskStore.attachTask(task, input.context.session?.sessionDir);

  const runGeneration = task.runGeneration;
  void runAsyncAgentLifecycle({ ...input, taskId, taskStore, abortController, runGeneration }).catch((error) => {
    const current = taskStore.get(taskId);
    if (current?.runGeneration === runGeneration && !taskStore.isTerminal(current)) taskStore.fail(taskId, error instanceof Error ? error.message : String(error));
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
  runGeneration?: number;
}): Promise<void> {
  const runGeneration = input.runGeneration ?? input.taskStore.get(input.taskId)?.runGeneration ?? 1;
  const ownsRun = () => {
    const current = input.taskStore.get(input.taskId);
    return current?.runGeneration === runGeneration && !input.taskStore.isTerminal(current);
  };
  if (!ownsRun()) return;
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
  let stream: ReturnType<typeof runAgent> | undefined;
  try {
    stream = runAgent({
      agentId: input.agentId,
      agent: input.agent,
      prompt: input.input.prompt,
      parentContext: input.context,
      parentMessages: input.fork ? input.context.messages : undefined,
      dependencies: buildRunAgentDependencies(input.runtime),
      ...(task?.executionOptions ?? effectiveExecutionOptions(input.input, input.agent, input.context)),
      abortSignal: wall?.signal ?? input.abortController.signal,
      fork: input.fork,
      existingMessages: input.existingMessages,
      resumeDirective: input.isResume ? input.input.prompt : undefined,
      takePendingMessages: () => ownsRun() ? input.taskStore.deliverPendingMessages(input.taskId, runGeneration) : [],
      onInitialMessages: (messages) => {
        if (ownsRun()) input.taskStore.reconcileMessages(input.taskId, messages);
      },
      onContextMessagesChanged: (messages) => {
        if (!ownsRun()) return;
        const current = input.taskStore.get(input.taskId)!;
        current.messages = [...messages];
        input.taskStore.confirmDelivery(input.taskId, messages.map((message) => message.id), runGeneration);
        input.taskStore.upsert(current);
      },
      workspaceCwd,
    });

    let completed = await stream.next();
    while (!completed.done) {
      const event = completed.value;
      const current = input.taskStore.get(input.taskId);
      if (!ownsRun() || !current || current.status === "killed") {
        return;
      }
      activityStore.recordEvent(input.agentId, event);
      if (event.type !== "message") {
        updateProgressFromEvent(current, event);
        input.taskStore.updateProgress(current);
      }
      if (event.type === "message") {
        updateProgressFromMessage(current, event.message);
        input.taskStore.updateProgress(current);
      }

      if (event.type === "terminal" || completed.done) break;

      completed = await stream.next();
    }

    if (!completed.done) {
      let remaining = await stream.next();
      while (!remaining.done) {
        const event = remaining.value;
        const current = input.taskStore.get(input.taskId);
        if (!ownsRun() || !current || current.status === "killed") return;
        activityStore.recordEvent(input.agentId, event);
        if (event.type === "message") {
          updateProgressFromMessage(current, event.message);
          input.taskStore.updateProgress(current);
        }
        remaining = await stream.next();
      }
      completed = remaining;
    }

    if (!ownsRun()) return;
    if (completed.value.status === "aborted") {
      input.taskStore.kill(input.taskId, completed.value.terminalReason);
      activityStore.fail(input.agentId, completed.value.terminalReason, "killed");
      return;
    }
    if (completed.value.status === "failed") {
      input.taskStore.fail(input.taskId, completed.value.terminalReason);
      activityStore.fail(input.agentId, completed.value.terminalReason);
      return;
    }
    input.taskStore.complete(input.taskId, completed.value.result);
    if (input.taskStore.get(input.taskId)?.runGeneration !== runGeneration) return;
    activityStore.complete(input.agentId, completed.value.result);
  } catch (error) {
    if (!ownsRun()) return;
    const message = error instanceof Error ? error.message : String(error);
    input.taskStore.fail(input.taskId, message);
    activityStore.fail(input.agentId, message);
  } finally {
    await stream?.return(undefined as never);
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
  if (parentContext.isSubagent || isForkChildContext(parentContext)) return Promise.resolve({ ok: false, error: "Only the main agent may resume subagents." });
  const task = taskStore.getActive(taskId);
  if (!task) return Promise.resolve({ ok: false, error: `Unknown task: ${taskId}` });
  if (task.type !== "agent") return Promise.resolve({ ok: false, error: `Only agent tasks can be resumed` });
  if (task.ownerSessionDir && path.resolve(parentContext.session?.sessionDir ?? "") !== task.ownerSessionDir) return Promise.resolve({ ok: false, error: "Resume the owning main session before resuming this agent." });

  const catalog = runtime.agentCatalog ?? new StaticAgentCatalog([GENERAL_PURPOSE_AGENT, EXPLORE_AGENT]);
  const agent = catalog.resolve(task.agentType);
  const abortController = new AbortController();

  if (!taskStore.isTerminal(task)) return Promise.resolve({ ok: false, error: "Only terminal agent tasks can be resumed" });
  taskStore.prepareResume(taskId, abortController);
  const runGeneration = task.runGeneration;

  void runAsyncAgentLifecycle({
    input: { ...task.executionOptions, prompt: directive ?? "Continue where you left off." },
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
    runGeneration,
  }).catch((error) => {
    const current = taskStore.get(taskId);
    if (current?.runGeneration === runGeneration && !taskStore.isTerminal(current)) taskStore.fail(taskId, error instanceof Error ? error.message : String(error));
  });

  return Promise.resolve({ ok: true });
}

function effectiveExecutionOptions(input: AgentToolInput, agent: AgentDefinition, context: ToolUseContext): NonNullable<LocalAgentTask["executionOptions"]> {
  return {
    cwd: resolveAgentWorkspaceCwd(input.cwd, context) ?? context.appState.snapshot().cwd,
    model: input.model ?? (agent.model && agent.model !== "inherit" ? agent.model : context.options?.mainLoopModel),
    reasoning: context.options?.reasoning == null ? context.options?.reasoning : { effort: context.options.reasoning.effort, summary: context.options.reasoning.summary },
    contextWindowTokensOverride: context.options?.contextWindowTokensOverride,
    maxOutputTokensOverride: context.options?.maxOutputTokensOverride,
    serviceTier: context.options?.serviceTier,
  };
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
  if (parent?.aborted) onParentAbort();
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
