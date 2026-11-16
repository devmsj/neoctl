import { resolve } from "node:path";
import { isForkChildContext } from "../agents/agent-definition.js";
import type { Tool, ToolResult, ToolUseContext } from "../tools/tool.js";
import type { LocalAgentTask } from "../agents/local-agent-task.js";
import { advanceParentCursor, formatProgressDelta, progressDelta } from "../agents/progress-journal.js";
import { globalTaskStore, isTerminalStatus, type TaskStore } from "./task-store.js";

// Scope comes from the calling query, never from the foreground UI. Child session
// directories stay child-scoped; do not strip /subagents/<id> to grant parent access.
function callerSessionDir(context: ToolUseContext): string | undefined {
  return context.session?.sessionDir ? resolve(context.session.sessionDir) : undefined;
}

export type SubagentToolName = "subagent_output" | "subagent_list" | "subagent_get" | "subagent_stop" | "subagent_message" | "subagent_resume";

export interface SubagentOutputInput {
  task_id: string;
  block?: boolean;
  timeout_ms?: number;
}

export interface SubagentIdInput {
  task_id: string;
}

export interface SubagentGetInput extends SubagentIdInput {
  detail?: boolean;
  wait_ms?: number;
}

export interface SubagentMessageInput {
  target: string;
  message: string;
}

export interface SubagentResumeInput {
  task_id: string;
  directive?: string;
}

export type SubagentResumeHandler = (taskId: string, directive?: string) => Promise<{ ok: boolean; error?: string }>;

export function createSubagentTools(taskStore: TaskStore = globalTaskStore, resumeHandler?: SubagentResumeHandler): Tool<any>[] {
  return [
    createSubagentOutputTool(taskStore),
    createSubagentListTool(taskStore),
    createSubagentGetTool(taskStore),
    createSubagentStopTool(taskStore),
    createSubagentMessageTool(taskStore),
    createSubagentResumeTool(taskStore, resumeHandler),
  ];
}

export function createSubagentOutputTool(taskStore: TaskStore = globalTaskStore): Tool<SubagentOutputInput> {
  return {
    name: "subagent_output",
    description: "Read a background task output, optionally blocking until it reaches a terminal state.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string" },
        block: { type: "boolean" },
        timeout_ms: { type: "number" },
      },
      required: ["task_id"],
      additionalProperties: false,
    },
    metadata: { readOnly: true, concurrent: true, visible: true, searchHint: "read background task output" },
    validate(input) {
      return input as SubagentOutputInput;
    },
    async call(input, context, options) {
      const task = taskStore.getInSession(input.task_id, callerSessionDir(context));
      if (!task) return { ok: false, output: { error: `Unknown task: ${input.task_id}` } };

      if (input.block && !taskStore.isTerminal(task)) {
        options.onProgress?.({ toolName: "subagent_output", message: `Waiting for task ${input.task_id}`,channel:"state",phase:"running",data:{task_id:task.taskId,run_generation:task.runGeneration} });
        await taskStore.waitForTerminal(input.task_id, { timeoutMs: input.timeout_ms ?? 30000, signal: context.abortSignal });
      }

      const latest = taskStore.getInSession(input.task_id, callerSessionDir(context));
      if (!latest) return { ok: false, output: { error: `Unknown task: ${input.task_id}` } };
      if (!taskStore.isTerminal(latest)) {
        return { ok: true, output: formatSubagentOutput(latest, "not_ready", readProgress(taskStore, latest, context)) };
      }

      taskStore.markNotified(latest.taskId);
      return { ok: true, output: formatSubagentOutput(latest, "ready") };
    },
    mapResult(result) {
      return result.output;
    },
  };
}

export function createSubagentListTool(taskStore: TaskStore = globalTaskStore): Tool<Record<string, never>> {
  return {
    name: "subagent_list",
    description: "List known background tasks and their current status.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    metadata: { readOnly: true, concurrent: true, visible: true, searchHint: "list background tasks" },
    validate() {
      return {};
    },
    async call(_input, context) {
      // Overview only: flags pending updates without consuming them (subagent_get reads them).
      return { ok: true, output: { tasks: taskStore.listInSession(callerSessionDir(context)).map(task => {
        const delta = progressDelta(task);
        return { task_id: task.taskId, agent_id: task.agentId, status: task.status, description: task.description, run_generation: task.runGeneration ?? 1,
          has_updates: delta.changed, has_new_report: delta.milestones.length > 0, has_new_failure: !!delta.failure,
          total_tool_calls: task.progress.totalToolUseCount, requires_resume: isTerminalStatus(task.status) && task.pendingMessages.length > 0 };
      }) } };
    },
  };
}

export function createSubagentGetTool(taskStore: TaskStore = globalTaskStore): Tool<SubagentGetInput> {
  return {
    name: "subagent_get",
    description: "Get what changed in a subagent since your last check: its own progress reports, tool activity counts (with failures) and status. Repeated checks never repeat old content. wait_ms waits for the next milestone, failure or status change instead of polling. Use detail=true for full prompt, progress and result; use subagent_output to read the final result. Delivered messages are not proof of implementation.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string" },
        detail: { type: "boolean", description: "Include full task details; defaults to false." },
        wait_ms: { type: "number", description: "Wait up to this long for the next meaningful change (report, failure, status) before answering." },
      },
      required: ["task_id"],
      additionalProperties: false,
    },
    metadata: { readOnly: true, concurrent: true, visible: true, searchHint: "get background task detail" },
    validate(input) {
      const value = input as SubagentGetInput;
      if (value.detail !== undefined && typeof value.detail !== "boolean") throw new Error("detail must be boolean");
      return value;
    },
    async call(input, context) {
      let task = taskStore.getInSession(input.task_id, callerSessionDir(context));
      if (!task) return { ok: false, output: { error: `Unknown task: ${input.task_id}` } };
      if (!input.detail && Number.isFinite(input.wait_ms) && input.wait_ms! > 0) {
        await taskStore.waitForProgress(task.taskId, { timeoutMs: Math.min(input.wait_ms!, 600_000), signal: context.abortSignal });
        task = taskStore.getInSession(input.task_id, callerSessionDir(context)) ?? task;
      }
      if (input.detail) return { ok: true, output: taskDetail(task) };
      return { ok: true, output: taskSummary(task, readProgress(taskStore, task, context)) };
    },
  };
}

export function createSubagentStopTool(taskStore: TaskStore = globalTaskStore): Tool<SubagentIdInput> {
  return {
    name: "subagent_stop",
    description: "Stop a background task and mark it killed.",
    inputSchema: {
      type: "object",
      properties: { task_id: { type: "string" } },
      required: ["task_id"],
      additionalProperties: false,
    },
    metadata: { readOnly: false, concurrent: false, visible: true, searchHint: "stop background task" },
    validate(input) {
      return input as SubagentIdInput;
    },
    async call(input, context) {
      const task = taskStore.getInSession(input.task_id, callerSessionDir(context));
      if (!task) return { ok: false, output: { error: `Unknown task: ${input.task_id}` } };
      if (!isTerminalStatus(task.status)) taskStore.kill(input.task_id, "Stopped by subagent_stop");
      return { ok: true, output: taskDetail(taskStore.getInSession(input.task_id, callerSessionDir(context)) ?? task) };
    },
  };
}

export function createSubagentMessageTool(taskStore: TaskStore = globalTaskStore): Tool<SubagentMessageInput> {
  return {
    name: "subagent_message",
    description: "Queue a message for a named or identified background agent. Queued does not mean delivered or implemented. Terminal tasks require explicit subagent_resume; inspect subagent_get for delivery receipts.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string" },
        message: { type: "string" },
      },
      required: ["target", "message"],
      additionalProperties: false,
    },
    metadata: { readOnly: false, concurrent: false, visible: true, searchHint: "send message to agent" },
    validate(input) {
      return input as SubagentMessageInput;
    },
    async call(input, context) {
      const queued = taskStore.queueMessageInSession(input.target, input.message, callerSessionDir(context));
      if (!queued.ok) return { ok: false, output: { status: "failed", error: queued.error } };
      return {
        ok: true,
        output: {
          status: isTerminalStatus(queued.task.status) ? "queued_for_resume" : "queued",
          requires_resume: isTerminalStatus(queued.task.status),
          delivery_status: "queued",
          message_id: queued.receipt.id,
          queued_at: queued.receipt.queuedAt,
          run_generation: queued.task.runGeneration,
          note: "Queued only; delivery to model context is not proof of implementation.",
          agent_id: queued.task.agentId,
          task_id: queued.task.taskId,
          pending_messages: queued.task.pendingMessages.length,
        },
      };
    },
  };
}

export function createSubagentResumeTool(taskStore: TaskStore = globalTaskStore, resumeHandler?: SubagentResumeHandler): Tool<SubagentResumeInput> {
  return {
    name: "subagent_resume",
    description: "Resume a completed, failed, or killed background agent task with an optional new directive. The agent re-launches with its prior conversation context intact.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "Task ID to resume." },
        directive: { type: "string", description: "Optional new instructions for the resumed agent." },
      },
      required: ["task_id"],
      additionalProperties: false,
    },
    metadata: { readOnly: false, concurrent: false, visible: true, searchHint: "resume stopped agent task" },
    validate(input) {
      return input as SubagentResumeInput;
    },
    async call(input, context) {
      if (context.isSubagent || isForkChildContext(context)) return { ok: false, output: { error: "Only the main agent may resume subagents." } };
      const task = taskStore.getInSession(input.task_id, callerSessionDir(context));
      if (!task) return { ok: false, output: { error: `Unknown task: ${input.task_id}` } };
      if (task.type !== "agent") return { ok: false, output: { error: `Only agent tasks can be resumed, got type: ${task.type}` } };
      if (!isTerminalStatus(task.status)) {
        return { ok: false, output: { error: `Task ${input.task_id} is still ${task.status}; stop it first or wait for completion.` } };
      }
      if (!resumeHandler) {
        return { ok: false, output: { error: "subagent_resume handler is not configured in this runtime." } };
      }

      // Legacy handlers synthesize parent context from the foreground runtime. Do
      // not invoke one for a detached parent: it would launch using another owner.
      if (taskStore.activeSessionDir !== callerSessionDir(context)) {
        return { ok: false, output: { error: "Resume requires this task's parent session to be foreground; switch back and retry." } };
      }
      const result = await resumeHandler(input.task_id, input.directive);
      if (!result.ok) return { ok: false, output: { error: result.error ?? "Resume failed" } };

      return {
        ok: true,
        output: {
          status: "resumed",
          run_generation: taskStore.getInSession(input.task_id, callerSessionDir(context))?.runGeneration,
          task_id: task.taskId,
          agent_id: task.agentId,
          directive: input.directive ?? "(continue)",
        },
      };
    },
  };
}

/** Only the main agent's reads consume progress; a subagent inspecting tasks never hides updates from it. */
function readProgress(taskStore: TaskStore, task: LocalAgentTask, context: ToolUseContext): string {
  const delta = progressDelta(task);
  if (!context.isSubagent) {
    advanceParentCursor(task);
    taskStore.updateProgress(task);
  }
  return formatProgressDelta(delta);
}

function formatSubagentOutput(task: LocalAgentTask, retrievalStatus: "ready" | "not_ready", progress?: string): string {
  // A resumed task can carry legacy state; never surface an old result as current progress.
  // Not ready: what changed since the last check, never a raw tail of streamed text.
  const output = retrievalStatus === "ready"
    ? task.result?.content ?? task.error ?? task.progress.lastText ?? ""
    : progress ?? "";
  return [
    `<retrieval_status>${retrievalStatus}</retrieval_status>`,
    `<task_id>${task.taskId}</task_id>`,
    `<task_type>${task.type}</task_type>`,
    `<status>${task.status}</status>`,
    `<run_generation>${task.runGeneration ?? 1}</run_generation>`,
    `<pending_messages>${task.pendingMessages.length}</pending_messages>`,
    `<requires_resume>${isTerminalStatus(task.status) && task.pendingMessages.length > 0}</requires_resume>`,
    `<agent_id>${task.agentId}</agent_id>`,
    `<output>${escapeXml(output)}</output>`,
    retrievalStatus === "ready" && task.error ? `<error>${escapeXml(task.error)}</error>` : undefined,
  ].filter(Boolean).join("\n");
}

function taskSummary(task: LocalAgentTask, sinceLastCheck?: string): Record<string, unknown> {
  return {
    task_id: task.taskId,
    agent_id: task.agentId,
    status: task.status,
    description: task.description.slice(0, 300),
    output_file: task.outputFile,
    updated_at: task.updatedAt,
    run_generation: task.runGeneration ?? 1,
    pending_messages: task.pendingMessages.length,
    requires_resume: isTerminalStatus(task.status) && task.pendingMessages.length > 0,
    result_available: isTerminalStatus(task.status) && !!task.result,
    result_status: isTerminalStatus(task.status) ? task.result?.status : undefined,
    message_delivery: {
      queued: task.pendingMessages.length,
      delivered_this_run_retained: (task.messageReceipts ?? []).filter((receipt) => receipt.status === "delivered" && receipt.runGeneration === task.runGeneration).length,
      recent: (task.messageReceipts ?? []).slice(-5).map((receipt) => ({
        message_id: receipt.id, status: receipt.status, queued_at: receipt.queuedAt,
        delivered_at: receipt.deliveredAt, run_generation: receipt.runGeneration,
      })),
      meaning: "Delivered to model context, not proof of implementation.",
    },
    previous_runs: (task.runHistory ?? []).slice(-5).map((run) => ({
      run_generation: run.runGeneration, status: run.status, completed_at: run.completedAt,
      result_available: !!run.result,
    })),
    progress: {
      last_activity: task.progress.lastActivity,
      since_last_check: sinceLastCheck,
      total_tool_use_count: task.progress.totalToolUseCount,
    },
    error: isTerminalStatus(task.status) ? task.error?.slice(0, 500) : undefined,
  };
}

function taskDetail(task: LocalAgentTask): Record<string, unknown> {
  return {
    ...taskSummary(task),
    prompt: task.prompt,
    message_receipts: task.messageReceipts ?? [],
    run_history: (task.runHistory ?? []).map((run) => ({
      run_generation: run.runGeneration, status: run.status, completed_at: run.completedAt,
      archived_at: run.archivedAt, result: run.result ? { content: run.result.content, status: run.result.status } : undefined,
      error: run.error,
    })),
    progress: task.progress,
    result: isTerminalStatus(task.status) ? task.result : undefined,
    error: isTerminalStatus(task.status) ? task.error : undefined,
    notified: task.notified,
    pending_messages: task.pendingMessages.length,
  };
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function asToolResult(output: unknown): ToolResult {
  return { ok: true, output };
}
