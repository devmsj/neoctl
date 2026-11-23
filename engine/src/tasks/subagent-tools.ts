import { resolve } from "node:path";
import { isForkChildContext } from "../agents/agent-definition.js";
import type { Tool, ToolResult, ToolUseContext } from "../tools/tool.js";
import { agentRunDurationMs, type LocalAgentTask } from "../agents/local-agent-task.js";
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
        return { ok: true, output: formatSubagentOutput(latest, "not_ready", readProgress(taskStore, latest, context).text) };
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
    description: "List this session's subagents: status, elapsed time, the tool each is running now, and whether a new report or failure is waiting (read it with subagent_get).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    metadata: { readOnly: true, concurrent: true, visible: true, searchHint: "list background tasks" },
    validate() {
      return {};
    },
    async call(_input, context) {
      // Overview only: flags pending updates without consuming them (subagent_get reads them).
      // Flags appear only when true; description identifies the task for the main agent and the UI list.
      return { ok: true, output: { tasks: taskStore.listInSession(callerSessionDir(context)).map(task => {
        const delta = progressDelta(task);
        return compact({ task_id: task.taskId, agent_id: task.agentId, status: task.status, description: task.description,
          run_generation: runGenerationIfResumed(task), elapsed: formatElapsed(agentRunDurationMs(task)),
          working_on: task.status === "running" ? workingOn(task) : undefined, has_new_report: delta.milestones.length > 0 || undefined,
          has_new_failure: !!delta.failure || undefined, requires_resume: requiresResume(task) || undefined });
      }) } };
    },
  };
}

export function createSubagentGetTool(taskStore: TaskStore = globalTaskStore): Tool<SubagentGetInput> {
  return {
    name: "subagent_get",
    description: "Check a subagent's current state: status, elapsed time, the tool it is running now, its latest report, and what changed since your last check (new reports, tool counts, failures; never repeated). wait_ms waits for the next report, failure or status change instead of polling. detail=true adds the prompt, all reports and results; subagent_output reads the final result. Delivered messages are not proof of implementation.",
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
      const latest = taskStore.getInSession(input.task_id, callerSessionDir(context)) ?? task;
      return { ok: true, output: compact({ task_id: latest.taskId, agent_id: latest.agentId, status: latest.status, description: latest.description, run_generation: latest.runGeneration }) };
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
      const terminal = isTerminalStatus(queued.task.status);
      return {
        ok: true,
        output: compact({
          status: terminal ? "queued_for_resume" : "queued",
          requires_resume: terminal || undefined,
          message_id: queued.receipt.id,
          task_id: queued.task.taskId,
          agent_id: queued.task.agentId,
          pending_messages: queued.task.pendingMessages.length,
        }),
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
          task_id: task.taskId,
          agent_id: task.agentId,
          run_generation: taskStore.getInSession(input.task_id, callerSessionDir(context))?.runGeneration,
        },
      };
    },
  };
}

/** Only the main agent's reads consume progress; a subagent inspecting tasks never hides updates from it. */
function readProgress(taskStore: TaskStore, task: LocalAgentTask, context: ToolUseContext): { text: string; newReports: boolean } {
  const delta = progressDelta(task);
  if (!context.isSubagent) {
    advanceParentCursor(task);
    taskStore.updateProgress(task);
  }
  return { text: formatProgressDelta(delta), newReports: delta.milestones.length > 0 };
}

function formatSubagentOutput(task: LocalAgentTask, retrievalStatus: "ready" | "not_ready", progress?: string): string {
  // Ready: only the authorized result (the report) or the error; never a raw tail of streamed text.
  // Not ready: what changed since the last check.
  const output = retrievalStatus === "ready" ? task.result?.content ?? task.error ?? "" : progress ?? "";
  // Header order is parsed by the UI (status-semantics subagentHeader); optional tags only when meaningful.
  return [
    `<retrieval_status>${retrievalStatus}</retrieval_status>`,
    `<task_id>${task.taskId}</task_id>`,
    `<status>${task.status}</status>`,
    `<run_generation>${task.runGeneration ?? 1}</run_generation>`,
    task.pendingMessages.length ? `<pending_messages>${task.pendingMessages.length}</pending_messages>` : undefined,
    requiresResume(task) ? "<requires_resume>true</requires_resume>" : undefined,
    `<agent_id>${task.agentId}</agent_id>`,
    `<output>${escapeXml(output)}</output>`,
    retrievalStatus === "ready" && task.result?.content && task.error ? `<error>${escapeXml(task.error)}</error>` : undefined,
  ].filter(Boolean).join("\n");
}

/** The subagent's current state for the main agent: status, elapsed, what it is doing now, its latest
 * own report, and what changed since the last check. Empty/default fields are omitted, not sent. */
function taskSummary(task: LocalAgentTask, sinceLastCheck?: { text: string; newReports: boolean }): Record<string, unknown> {
  const terminal = isTerminalStatus(task.status);
  const receipts = task.messageReceipts ?? [];
  const latest = task.progress.journal?.milestones.at(-1);
  return compact({
    task_id: task.taskId,
    agent_id: task.agentId,
    status: task.status,
    run_generation: task.runGeneration ?? 1, // the UI matches observations to this generation
    elapsed: formatElapsed(agentRunDurationMs(task)),
    working_on: task.status === "running" ? workingOn(task) : undefined,
    // The latest report is current state; when it is new it already appears in since_last_check.
    latest_report: latest && !sinceLastCheck?.newReports
      ? { displaySource: "agent_report", status: latest.status, content: latest.report, reported: formatAgo(latest.at) } : undefined,
    since_last_check: sinceLastCheck?.text,
    result_status: terminal ? task.result?.status ?? (task.result ? "completed" : undefined) : undefined,
    error: terminal ? task.error?.slice(0, 500) : undefined,
    pending_messages: task.pendingMessages.length || undefined,
    requires_resume: requiresResume(task) || undefined,
    messages: receipts.length ? receipts.slice(-5).map((receipt) => ({ message_id: receipt.id, status: receipt.status })) : undefined,
  });
}

/** Explicit detail: the task's own record (prompt, reports, results), never raw streaming state. */
function taskDetail(task: LocalAgentTask): Record<string, unknown> {
  const terminal = isTerminalStatus(task.status);
  return compact({
    ...taskSummary(task),
    latest_report: undefined, // all reports follow
    description: task.description,
    prompt: task.prompt,
    reports: task.progress.journal?.milestones.map((milestone) => ({ status: milestone.status, report: milestone.report })),
    result: terminal && task.result ? { status: task.result.status, content: task.result.content } : undefined,
    previous_runs: task.runHistory?.length ? task.runHistory.map((run) => compact({
      run_generation: run.runGeneration, status: run.status,
      result: run.result ? { status: run.result.status, content: run.result.content } : undefined, error: run.error,
    })) : undefined,
  });
}

/** Tools executing right now, as "tool: purpose" (the purpose the subagent itself stated). */
function workingOn(task: LocalAgentTask): string | undefined {
  const active = Object.values(task.progress.activeTools ?? {});
  return active.length ? active.map((tool) => tool.purpose ? `${tool.name}: ${tool.purpose}` : tool.name).join("; ") : undefined;
}

function formatElapsed(ms: number | undefined): string | undefined {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return undefined;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

function formatAgo(at: string | undefined): string | undefined {
  const time = at ? Date.parse(at) : NaN;
  const elapsed = Number.isFinite(time) ? formatElapsed(Math.max(0, Date.now() - time)) : undefined;
  return elapsed ? `${elapsed} ago` : undefined;
}

function runGenerationIfResumed(task: LocalAgentTask): number | undefined {
  return (task.runGeneration ?? 1) > 1 ? task.runGeneration : undefined;
}

function requiresResume(task: LocalAgentTask): boolean {
  return isTerminalStatus(task.status) && task.pendingMessages.length > 0;
}

function compact<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>;
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function asToolResult(output: unknown): ToolResult {
  return { ok: true, output };
}
