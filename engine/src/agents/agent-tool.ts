import type { ContextManager } from "../context/context-manager.js";
import type { Compactor, ContextBudgetOptions } from "../context/compaction.js";
import type { ModelGateway } from "../model/model-gateway.js";
import { createTextMessage, type Message } from "../types/messages.js";
import type { Tool, ToolProgressEvent, ToolResult, ToolUseContext } from "../tools/tool.js";
import type { ToolRegistry } from "../tools/registry.js";
import { finalizeAgentTool, runAgent, type RunAgentDependencies } from "../core/run-agent.js";
import { createLocalAgentTask, updateProgressFromEvent, updateProgressFromMessage, type AgentToolResult, type LocalAgentTask } from "./local-agent-task.js";
import {
  GENERAL_PURPOSE_AGENT,
  type AgentDefinition,
} from "./agent-definition.js";
import { globalTaskStore, type TaskStore } from "../tasks/task-store.js";
import { globalAgentActivityStore, type AgentActivityStore } from "./agent-activity.js";
import path from "node:path";
import { AGENT_REPORT_TOOL_NAME } from "./agent-report-tool.js";

export const AGENT_TOOL_NAME = "subagent_run";

export const AGENT_TOOL_PROMPT_RULES = [
  "Subagents do not inherit your conversation; the prompt must state goal, relevant files, constraints, allowed edits and expected output.",
  "Tools: a subagent has your tools; block the ones it must not use with disallowed_tools (e.g. [\"file_edit\",\"file_write\"] for read-only work). Unknown names are rejected. subagent_report is always available; subagent_run/subagent_resume never are.",
  "Concurrency: parallel=true runs several sync calls of one turn concurrently; run_in_background (or mode=background) returns a task_id immediately. Otherwise calls run one after another. Each run has a wall-clock limit (AGENT_SUBAGENT_WALL_TIMEOUT_MS, default 10 min).",
  "Subagents cannot reach sibling agents; you relay every cross-agent question, decision and interface change. Give workers disjoint write scopes and settle shared contracts first.",
  "Workers report through subagent_report: draft for progress (does not pause), incomplete for a blocking question (ends the run; decide, then subagent_resume). Send additions with subagent_message; queued or delivered is not proof of implementation.",
  "Background workers' reports, tool failures and completions are added to your context as task notifications before your next model request (including ones that arrived while you were idle); you are not woken for them. Use subagent_get for a worker's current state and what changed since your last check (wait_ms waits for the next change); never fabricate results before completion.",
].join("\n");

export interface AgentToolInput {
  prompt: string;
  description?: string;
  model?: string;
  /** The main agent's only tool control: block these. By default a subagent has the main agent's tools. */
  disallowed_tools?: string[];
  run_in_background?: boolean;
  /** When true with sync mode, allow concurrent execution with other parallel-safe agent calls in the same turn (multiple model streams). */
  parallel?: boolean;
  name?: string;
  mode?: "sync" | "background";
  /** Working directory for this subagent's tools (resolved against parent cwd when relative). */
  cwd?: string;
}

export interface AgentToolRuntime {
  acquireTurnResources?: (sessionId?: string) => import("../core/query.js").TurnResources;
  modelGateway: ModelGateway;
  /** Optional runner adapter; defaults to the production runAgent lifecycle. */
  runAgent?: typeof runAgent;
  tools: ToolRegistry;
  contextManager?: ContextManager;
  compactor?: Compactor;
  contextBudget?: ContextBudgetOptions;
  taskStore?: TaskStore;
  /** Worker definition override (tests/embedders). There is one worker kind. */
  agent?: AgentDefinition;
  agentActivityStore?: AgentActivityStore;
}

export function createAgentTool(runtime?: AgentToolRuntime): Tool<AgentToolInput> {
  return {
    name: AGENT_TOOL_NAME,
    searchHint: "delegate work to a subagent",
    description: [
      "Delegate a scoped task with a clear goal, file boundaries and acceptance checks. Subagents cannot delegate further; coordinate through the main agent.",
      AGENT_TOOL_PROMPT_RULES,
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Complete task instructions for the child agent." },
        description: { type: "string", description: "Short task label for progress and task lists." },
        model: { type: "string" },
        disallowed_tools: { type: "array", items: { type: "string" }, description: "Your tools this subagent must not use. Omit to give it all of your tools." },
        run_in_background: { type: "boolean" },
        name: { type: "string", description: "Optional stable name for later subagent_message routing." },
        mode: { type: "string", enum: ["sync", "background"], description: "sync (default) or background." },
        cwd: { type: "string", description: "Working directory for child tools (list/read/exec); resolved against parent cwd if relative." },
        parallel: { type: "boolean", description: "Set true when launching multiple independent agents in the same turn so they run concurrently." },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["completed", "incomplete", "async_launched"] },
        task_id: { type: "string" },
      },
    },
    metadata: { readOnly: false, concurrent: true, visible: true, requiresApproval: false, searchHint: "delegate subagent work" },
    validate(input: unknown): AgentToolInput {
      const value = input as AgentToolInput;
      if (!value.prompt?.trim()) throw new Error("agent.prompt is required");
      const blocked = value.disallowed_tools;
      if (blocked !== undefined && (!Array.isArray(blocked) || blocked.some((name) => typeof name !== "string"))) throw new Error("disallowed_tools must be an array of tool names");
      if (value.mode !== undefined && !["sync", "background"].includes(value.mode)) throw new Error("mode must be sync or background");
      return value;
    },
    isConcurrencySafe(input) {
      return Boolean(input.run_in_background || input.mode === "background" || input.parallel === true);
    },
    async call(input, context, options) {
      if (!runtime) {
        return { ok: false, output: { error: "AgentTool runtime is not configured" } };
      }
      if (context.isSubagent) {
        return { ok: false, output: { error: "Subagents cannot delegate additional agents; ask the main agent to coordinate." } };
      }
      const toolError = checkToolNames(input, context, runtime);
      if (toolError) return { ok: false, output: { error: toolError } };

      const agent = runtime.agent ?? GENERAL_PURPOSE_AGENT;
      const description = input.description ?? input.prompt.slice(0, 80);
      const background = Boolean(input.run_in_background || input.mode === "background" || agent.background);
      const agentId = makeAgentId(input.name ?? agent.agentType);

      if (background) {
        return launchAsyncAgent({ input, context, options, runtime, agent, agentId, description });
      }

      return runSyncAgent({ input, context, options, runtime, agent, agentId, description });
    },
  };
}

async function runSyncAgent(input: {
  input: AgentToolInput;
  context: ToolUseContext;
  options: { onProgress?: (event: ToolProgressEvent) => void };
  runtime: AgentToolRuntime;
  agent: AgentDefinition;
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
    return { ok: false, output: { status: "cancelled", task_id: task.taskId, agent_id: input.agentId, error: "Task stopped or superseded" } };
  };
  const onParentAbort = () => abortController.abort(input.context.abortSignal?.reason);
  input.context.abortSignal?.addEventListener("abort", onParentAbort, { once: true });
  if (input.context.abortSignal?.aborted) onParentAbort();
  taskStore.markRunning(task.taskId, runGeneration);
  const workspaceCwd = task.executionOptions.cwd;
  const activityStore = input.runtime.agentActivityStore ?? globalAgentActivityStore;
  activityStore.start({
    agentId: input.agentId,
    taskId: task.taskId,
    agentType: input.agent.agentType,
    description: input.description,
    prompt: input.input.prompt,
    mode: "sync",
    cwd: workspaceCwd,
    model: input.input.model,
  });
  const wall = mergeAbortWithWallClock(abortController.signal, resolveSubagentWallTimeoutMs());
  let stream: ReturnType<typeof runAgent> | undefined;
  try {
    stream = (input.runtime.runAgent ?? runAgent)({
      agentId: input.agentId,
      agent: input.agent,
      prompt: input.input.prompt,
      parentContext: input.context,
      dependencies: buildRunAgentDependencies(input.runtime, input.context.session?.sessionId, input.context.options?.modelGateway),
      ...task.executionOptions,
      runGeneration,
      onInitialMessages: (messages) => {
        if (ownsRun()) taskStore.reconcileMessages(task.taskId, messages);
      },
      onContextMessagesChanged: (messages) => {
        if (!ownsRun()) return;
        // The child transcript already holds these messages durably: keep the live copy, coalesce the record write.
        task.messages = [...messages];
        taskStore.confirmDelivery(task.taskId, messages.map((message) => message.id), runGeneration);
        taskStore.upsert(task, { persist: false });
      },
      takePendingMessages: () => ownsRun() ? taskStore.deliverPendingMessages(task.taskId, runGeneration) : [],
      abortSignal: wall?.signal ?? abortController.signal,
      workspaceCwd,
    });

    input.options.onProgress?.({ toolName: AGENT_TOOL_NAME, message: input.description, channel: "state", operation: "replace", phase: "running", data: { task_id: task.taskId, run_generation: task.runGeneration, agent_id: input.agentId, agent_type: input.agent.agentType } });
    let completed = await stream.next();
    while (!completed.done) {
      if (!ownsRun()) {
        if (taskStore.get(task.taskId)?.runGeneration !== runGeneration || taskStore.get(task.taskId)?.status !== "killed") return cancelled();
        completed = await stream.next();
        continue;
      }
      activityStore.recordEvent(input.agentId, completed.value);
      emitSyncAgentEvent(input.options.onProgress, input.agentId, completed.value);
      if (!ownsRun()) {
        if (taskStore.get(task.taskId)?.runGeneration !== runGeneration || taskStore.get(task.taskId)?.status !== "killed") return cancelled();
        completed = await stream.next();
        continue;
      }
      if (completed.value.type === "message") {
        updateProgressFromMessage(task, completed.value.message);
      } else updateProgressFromEvent(task, completed.value, runGeneration, input.context.secretRedactions);
      taskStore.updateProgress(task);
      completed = await stream.next();
    }
    // Public reports are rebuilt from this run's authorized messages, including
    // when an injected runner supplies a broader legacy fallback result.
    const result = finalizeAgentTool({ agentId: input.agentId, agentType: input.agent.agentType, agent: input.agent,
      messages: completed.value.messages, durationMs: completed.value.result.total_duration_ms,
      totalToolUseCount: completed.value.result.total_tool_use_count });
    result.total_tokens = completed.value.result.total_tokens;
    result.usage = completed.value.result.usage;
    const partial = allowedPartialResult(result, completed.value.messages, input.agent);
    if (!ownsRun()) {
      if (taskStore.get(task.taskId)?.runGeneration === runGeneration && taskStore.get(task.taskId)?.status === "killed") {
        taskStore.kill(task.taskId, taskStore.get(task.taskId)?.error, partial, runGeneration);
      }
      return cancelled();
    }
    if (completed.value.status === "aborted") {
      taskStore.kill(task.taskId, completed.value.terminalReason, partial, runGeneration);
      if (taskStore.get(task.taskId)?.runGeneration !== runGeneration) return cancelled();
      activityStore.fail(input.agentId, completed.value.terminalReason, "killed");
      return { ok: false, output: agentRunOutput("cancelled", task, partial, completed.value.terminalReason) };
    }
    if (completed.value.status === "failed") {
      taskStore.fail(task.taskId, completed.value.terminalReason, partial, runGeneration);
      if (taskStore.get(task.taskId)?.runGeneration !== runGeneration) return cancelled();
      activityStore.fail(input.agentId, completed.value.terminalReason);
      return { ok: false, output: agentRunOutput("failed", task, partial, completed.value.terminalReason) };
    }
    taskStore.complete(task.taskId, result, runGeneration);
    if (taskStore.get(task.taskId)?.runGeneration !== runGeneration) return cancelled();
    activityStore.complete(input.agentId, result);
    return { ok: true, output: agentRunOutput(result.status ?? "completed", task, result) };
  } catch (error) {
    if (!ownsRun()) return cancelled();
    const message = error instanceof Error ? error.message : String(error);
    if (abortController.signal.aborted || wall?.signal.aborted) {
      taskStore.kill(task.taskId, message, undefined, runGeneration);
      if (taskStore.get(task.taskId)?.runGeneration !== runGeneration) return cancelled();
      activityStore.fail(input.agentId, message, "killed");
      return cancelled();
    }
    taskStore.fail(task.taskId, message, undefined, runGeneration);
    if (taskStore.get(task.taskId)?.runGeneration !== runGeneration) return cancelled();
    activityStore.fail(input.agentId, message);
    return { ok: false, output: agentRunOutput("failed", task, undefined, message) };
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
  }
  // Child loop states ("model stream opened", "turn N started", ...) are internal: not forwarded.
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
    if (current?.runGeneration === runGeneration && !taskStore.isTerminal(current)) taskStore.fail(taskId, error instanceof Error ? error.message : String(error), undefined, runGeneration);
  });

  // The main agent just wrote the prompt: echo only what it needs to follow the task.
  return { ok: true, output: { status: "async_launched", task_id: taskId, agent_id: input.agentId, run_generation: task.runGeneration } };
}

/** What the main agent receives from a sync run: the report and the ids to follow up, nothing else.
 * displaySource/run_generation are kept for the UI's report provenance and generation matching. */
function agentRunOutput(status: string, task: LocalAgentTask, result?: AgentToolResult, error?: string): Record<string, unknown> {
  return {
    status,
    task_id: task.taskId,
    agent_id: task.agentId,
    run_generation: task.runGeneration,
    ...(result?.content ? { displaySource: result.displaySource, content: result.content } : {}),
    ...(error ? { error } : {}),
  };
}

async function runAsyncAgentLifecycle(input: {
  input: AgentToolInput;
  context: ToolUseContext;
  runtime: AgentToolRuntime;
  agent: AgentDefinition;
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
  input.taskStore.markRunning(input.taskId, runGeneration);
  const task = input.taskStore.get(input.taskId);
  // Pin the launch-time cwd like sync agents; never follow later parent cwd changes.
  const workspaceCwd = resolveAgentWorkspaceCwd(input.input.cwd, input.context) ?? task?.executionOptions?.cwd;
  const activityStore = input.runtime.agentActivityStore ?? globalAgentActivityStore;
  activityStore.start({
    agentId: input.agentId,
    taskId: input.taskId,
    agentType: input.agent.agentType,
    description: input.description,
    prompt: input.input.prompt,
    mode: "background",
    cwd: workspaceCwd,
    model: input.input.model,
  });
  const wall = mergeAbortWithWallClock(input.abortController.signal, resolveSubagentWallTimeoutMs());
  let stream: ReturnType<typeof runAgent> | undefined;
  try {
    stream = (input.runtime.runAgent ?? runAgent)({
      agentId: input.agentId,
      agent: input.agent,
      prompt: input.input.prompt,
      parentContext: input.context,
      dependencies: buildRunAgentDependencies(input.runtime, input.context.session?.sessionId, input.context.options?.modelGateway),
      ...(task?.executionOptions ?? effectiveExecutionOptions(input.input, input.agent, input.context)),
      runGeneration,
      abortSignal: wall?.signal ?? input.abortController.signal,
      existingMessages: input.existingMessages,
      resumeDirective: input.isResume ? input.input.prompt : undefined,
      takePendingMessages: () => ownsRun() ? input.taskStore.deliverPendingMessages(input.taskId, runGeneration) : [],
      onInitialMessages: (messages) => {
        if (ownsRun()) input.taskStore.reconcileMessages(input.taskId, messages);
      },
      onContextMessagesChanged: (messages) => {
        if (!ownsRun()) return;
        const current = input.taskStore.get(input.taskId)!;
        // The child transcript already holds these messages durably: keep the live copy, coalesce the record write.
        current.messages = [...messages];
        input.taskStore.confirmDelivery(input.taskId, messages.map((message) => message.id), runGeneration);
        input.taskStore.upsert(current, { persist: false });
      },
      workspaceCwd,
    });

    let completed = await stream.next();
    while (!completed.done) {
      const event = completed.value;
      const current = input.taskStore.get(input.taskId);
      if (!ownsRun() || !current) {
        if (current?.runGeneration !== runGeneration || current.status !== "killed") return;
        completed = await stream.next();
        continue;
      }
      activityStore.recordEvent(input.agentId, event);
      if (event.type !== "message") {
        updateProgressFromEvent(current, event, runGeneration, input.context.secretRedactions);
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
        if (!ownsRun() || !current) {
          if (current?.runGeneration !== runGeneration || current.status !== "killed") return;
          remaining = await stream.next();
          continue;
        }
        activityStore.recordEvent(input.agentId, event);
        if (event.type === "message") {
          updateProgressFromMessage(current, event.message);
          input.taskStore.updateProgress(current);
        }
        remaining = await stream.next();
      }
      completed = remaining;
    }

    // Public reports are rebuilt from this run's authorized messages, including
    // when an injected runner supplies a broader legacy fallback result.
    const result = finalizeAgentTool({ agentId: input.agentId, agentType: input.agent.agentType, agent: input.agent,
      messages: completed.value.messages, durationMs: completed.value.result.total_duration_ms,
      totalToolUseCount: completed.value.result.total_tool_use_count });
    result.total_tokens = completed.value.result.total_tokens;
    result.usage = completed.value.result.usage;
    const partial = allowedPartialResult(result, completed.value.messages, input.agent);
    if (!ownsRun()) {
      const current = input.taskStore.get(input.taskId);
      if (current?.runGeneration === runGeneration && current.status === "killed") {
        input.taskStore.kill(input.taskId, current.error, partial, runGeneration);
      }
      return;
    }
    if (completed.value.status === "aborted") {
      input.taskStore.kill(input.taskId, completed.value.terminalReason, partial, runGeneration);
      if (input.taskStore.get(input.taskId)?.runGeneration !== runGeneration) return;
      activityStore.fail(input.agentId, completed.value.terminalReason, "killed");
      return;
    }
    if (completed.value.status === "failed") {
      input.taskStore.fail(input.taskId, completed.value.terminalReason, partial, runGeneration);
      if (input.taskStore.get(input.taskId)?.runGeneration !== runGeneration) return;
      activityStore.fail(input.agentId, completed.value.terminalReason);
      return;
    }
    input.taskStore.complete(input.taskId, result, runGeneration);
    if (input.taskStore.get(input.taskId)?.runGeneration !== runGeneration) return;
    activityStore.complete(input.agentId, result);
  } catch (error) {
    if (!ownsRun()) return;
    const message = error instanceof Error ? error.message : String(error);
    const stopped = input.abortController.signal.aborted || wall?.signal.aborted;
    if (stopped) input.taskStore.kill(input.taskId, message, undefined, runGeneration);
    else input.taskStore.fail(input.taskId, message, undefined, runGeneration);
    if (input.taskStore.get(input.taskId)?.runGeneration !== runGeneration) return;
    activityStore.fail(input.agentId, message, stopped ? "killed" : "failed");
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
  if (parentContext.isSubagent) return Promise.resolve({ ok: false, error: "Only the main agent may resume subagents." });
  const task = taskStore.getActive(taskId);
  if (!task) return Promise.resolve({ ok: false, error: `Unknown task: ${taskId}` });
  if (task.type !== "agent") return Promise.resolve({ ok: false, error: `Only agent tasks can be resumed` });
  if (task.ownerSessionDir && path.resolve(parentContext.session?.sessionDir ?? "") !== task.ownerSessionDir) return Promise.resolve({ ok: false, error: "Resume the owning main session before resuming this agent." });

  // One worker kind: tasks recorded under former kinds (explore, fork) resume as the worker.
  const agent = runtime.agent ?? GENERAL_PURPOSE_AGENT;
  const abortController = new AbortController();

  if (!taskStore.isTerminal(task)) return Promise.resolve({ ok: false, error: "Only terminal agent tasks can be resumed" });
  // Tasks persisted by the former read-only "explore" kind keep their restriction as explicit blocking.
  if (task.agentType === "explore" && !task.executionOptions?.disallowedTools) {
    task.executionOptions = { ...task.executionOptions, disallowedTools: ["file_edit", "file_write"] };
  }
  taskStore.prepareResume(taskId, abortController);
  const runGeneration = task.runGeneration;

  void runAsyncAgentLifecycle({
    input: { ...task.executionOptions, prompt: directive ?? "Continue where you left off." },
    context: parentContext,
    runtime,
    agent,
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
    if (current?.runGeneration === runGeneration && !taskStore.isTerminal(current)) taskStore.fail(taskId, error instanceof Error ? error.message : String(error), undefined, runGeneration);
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
    fastMode: context.options?.fastMode,
    disallowedTools: normalizeToolNames(input.disallowed_tools ?? (input as { disallowedTools?: string[] }).disallowedTools),
  };
}

function normalizeToolNames(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const names = [...new Set(value.filter((name): name is string => typeof name === "string").map(name => name.trim()).filter(Boolean))];
  return names.length ? names : undefined;
}

/** Blocking is the main agent's tool control: reject unknown names instead of silently blocking nothing. */
function checkToolNames(input: AgentToolInput, context: ToolUseContext, runtime: AgentToolRuntime): string | undefined {
  const known = (name: string) => Boolean(context.tools?.get(name) ?? runtime.tools.get(name));
  const unknown = (normalizeToolNames(input.disallowed_tools) ?? []).filter((name) => !known(name));
  return unknown.length ? `Unknown tool name(s) in disallowed_tools: ${unknown.join(", ")}. Use names from your own tool list.` : undefined;
}

function buildRunAgentDependencies(runtime: AgentToolRuntime, sessionId?: string, gateway?: ModelGateway): RunAgentDependencies {
  return {
    modelGateway: gateway ?? runtime.modelGateway,
    tools: runtime.tools,
    acquireTurnResources: runtime.acquireTurnResources ? () => runtime.acquireTurnResources!(sessionId) : undefined,
    contextManager: runtime.contextManager,
    compactor: runtime.compactor,
    contextBudget: runtime.contextBudget,
  };
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

/** Only explicit report outputs or OBS04-visible assistant text can become a partial report.
 * The runner's fallback content may contain unmarked text: never publish it wholesale.
 * messages is the runner's newly produced messages, not resumed/parent context.
 */
function allowedPartialResult(result: AgentToolResult, messages: readonly Message[], agent: AgentDefinition): AgentToolResult | undefined {
  let draft: string | undefined;
  for (const message of [...messages].reverse()) {
    if (message.role !== "tool_result" || message.isMeta === true) continue;
    for (const block of message.blocks) {
      if (block.type !== "tool_result" || !block.ok || block.name !== (agent.reportToolName ?? AGENT_REPORT_TOOL_NAME)) continue;
      const output = block.output as { report?: unknown; status?: unknown; final?: unknown } | undefined;
      if (typeof output?.report !== "string" || !output.report.trim()) continue;
      if (output.final === true || output.status === "completed" || output.status === "incomplete") {
        return { ...result, content: output.report.trim(), displaySource: "agent_report", status: "incomplete" };
      }
      draft ??= output.report.trim();
    }
  }
  if (draft !== undefined) return { ...result, content: draft, displaySource: "agent_report", status: "incomplete" };
  for (const message of [...messages].reverse()) {
    if (message.role !== "assistant" || message.isMeta === true) continue;
    const content = message.blocks.flatMap((block) => block.type === "text" && block.displayChannel === "visible" ? [block.text] : []).join("\n").trim();
    if (content) return { ...result, content, displaySource: "visible_text", status: "incomplete" };
  }
  return undefined;
}
