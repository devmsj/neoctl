import type { Tool, ToolResult } from "../tools/tool.js";
import type { LocalAgentTask } from "../agents/local-agent-task.js";
import { globalTaskStore, isTerminalStatus, type TaskStore } from "./task-store.js";

export type TaskToolName = "TaskOutput" | "TaskList" | "TaskGet" | "TaskStop" | "SendMessage" | "TaskResume";

export interface TaskOutputInput {
  task_id: string;
  block?: boolean;
  timeout_ms?: number;
}

export interface TaskIdInput {
  task_id: string;
}

export interface SendMessageInput {
  target: string;
  message: string;
}

export interface TaskResumeInput {
  task_id: string;
  directive?: string;
}

export type TaskResumeHandler = (taskId: string, directive?: string) => Promise<{ ok: boolean; error?: string }>;

export function createTaskTools(taskStore: TaskStore = globalTaskStore, resumeHandler?: TaskResumeHandler): Tool<any>[] {
  return [
    createTaskOutputTool(taskStore),
    createTaskListTool(taskStore),
    createTaskGetTool(taskStore),
    createTaskStopTool(taskStore),
    createSendMessageTool(taskStore),
    createTaskResumeTool(taskStore, resumeHandler),
  ];
}

export function createTaskOutputTool(taskStore: TaskStore = globalTaskStore): Tool<TaskOutputInput> {
  return {
    name: "TaskOutput",
    aliases: ["task_output"],
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
      return input as TaskOutputInput;
    },
    async call(input, context, options) {
      const task = taskStore.get(input.task_id);
      if (!task) return { ok: false, output: { error: `Unknown task: ${input.task_id}` } };

      if (input.block && !taskStore.isTerminal(task)) {
        options.onProgress?.({ toolName: "TaskOutput", message: `Waiting for task ${input.task_id}` });
        await taskStore.waitForTerminal(input.task_id, { timeoutMs: input.timeout_ms ?? 30000, signal: context.abortSignal });
      }

      const latest = taskStore.get(input.task_id);
      if (!latest) return { ok: false, output: { error: `Unknown task: ${input.task_id}` } };
      if (!taskStore.isTerminal(latest)) {
        return { ok: true, output: formatTaskOutput(latest, "not_ready") };
      }

      taskStore.markNotified(latest.taskId);
      return { ok: true, output: formatTaskOutput(latest, "ready") };
    },
    mapResult(result) {
      return result.output;
    },
  };
}

export function createTaskListTool(taskStore: TaskStore = globalTaskStore): Tool<Record<string, never>> {
  return {
    name: "TaskList",
    aliases: ["task_list"],
    description: "List known background tasks and their current status.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    metadata: { readOnly: true, concurrent: true, visible: true, searchHint: "list background tasks" },
    validate() {
      return {};
    },
    async call() {
      return { ok: true, output: { tasks: taskStore.list().map(taskSummary) } };
    },
  };
}

export function createTaskGetTool(taskStore: TaskStore = globalTaskStore): Tool<TaskIdInput> {
  return {
    name: "TaskGet",
    aliases: ["task_get"],
    description: "Get a background task detail by task id.",
    inputSchema: {
      type: "object",
      properties: { task_id: { type: "string" } },
      required: ["task_id"],
      additionalProperties: false,
    },
    metadata: { readOnly: true, concurrent: true, visible: true, searchHint: "get background task detail" },
    validate(input) {
      return input as TaskIdInput;
    },
    async call(input) {
      const task = taskStore.get(input.task_id);
      return task ? { ok: true, output: taskDetail(task) } : { ok: false, output: { error: `Unknown task: ${input.task_id}` } };
    },
  };
}

export function createTaskStopTool(taskStore: TaskStore = globalTaskStore): Tool<TaskIdInput> {
  return {
    name: "TaskStop",
    aliases: ["task_stop"],
    description: "Stop a background task and mark it killed.",
    inputSchema: {
      type: "object",
      properties: { task_id: { type: "string" } },
      required: ["task_id"],
      additionalProperties: false,
    },
    metadata: { readOnly: false, concurrent: false, visible: true, searchHint: "stop background task" },
    validate(input) {
      return input as TaskIdInput;
    },
    async call(input) {
      const task = taskStore.get(input.task_id);
      if (!task) return { ok: false, output: { error: `Unknown task: ${input.task_id}` } };
      if (!isTerminalStatus(task.status)) taskStore.kill(input.task_id, "Stopped by TaskStop");
      return { ok: true, output: taskDetail(taskStore.get(input.task_id) ?? task) };
    },
  };
}

export function createSendMessageTool(taskStore: TaskStore = globalTaskStore): Tool<SendMessageInput> {
  return {
    name: "SendMessage",
    aliases: ["send_message"],
    description: "Queue a message for a named or identified background agent. Stopped-agent resume is represented as queued state in this scaffold.",
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
      return input as SendMessageInput;
    },
    async call(input) {
      const queued = taskStore.queueMessage(input.target, input.message);
      if (!queued.ok) return { ok: false, output: { status: "failed", error: queued.error } };
      return {
        ok: true,
        output: {
          status: queued.task.status === "running" ? "queued" : "queued_for_resume",
          agent_id: queued.task.agentId,
          task_id: queued.task.taskId,
          pending_messages: queued.task.pendingMessages.length,
        },
      };
    },
  };
}

export function createTaskResumeTool(taskStore: TaskStore = globalTaskStore, resumeHandler?: TaskResumeHandler): Tool<TaskResumeInput> {
  return {
    name: "TaskResume",
    aliases: ["task_resume"],
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
      return input as TaskResumeInput;
    },
    async call(input) {
      const task = taskStore.get(input.task_id);
      if (!task) return { ok: false, output: { error: `Unknown task: ${input.task_id}` } };
      if (task.type !== "agent") return { ok: false, output: { error: `Only agent tasks can be resumed, got type: ${task.type}` } };
      if (!isTerminalStatus(task.status)) {
        return { ok: false, output: { error: `Task ${input.task_id} is still ${task.status}; stop it first or wait for completion.` } };
      }
      if (!resumeHandler) {
        return { ok: false, output: { error: "TaskResume handler is not configured in this runtime." } };
      }

      const result = await resumeHandler(input.task_id, input.directive);
      if (!result.ok) return { ok: false, output: { error: result.error ?? "Resume failed" } };

      return {
        ok: true,
        output: {
          status: "resumed",
          task_id: task.taskId,
          agent_id: task.agentId,
          directive: input.directive ?? "(continue)",
        },
      };
    },
  };
}

function formatTaskOutput(task: LocalAgentTask, retrievalStatus: "ready" | "not_ready"): string {
  const output = task.result?.content ?? task.error ?? task.progress.lastText ?? "";
  return [
    `<retrieval_status>${retrievalStatus}</retrieval_status>`,
    `<task_id>${task.taskId}</task_id>`,
    `<task_type>${task.type}</task_type>`,
    `<status>${task.status}</status>`,
    `<agent_id>${task.agentId}</agent_id>`,
    `<output>${escapeXml(output)}</output>`,
    task.error ? `<error>${escapeXml(task.error)}</error>` : undefined,
  ].filter(Boolean).join("\n");
}

function taskSummary(task: LocalAgentTask): Record<string, unknown> {
  return {
    task_id: task.taskId,
    agent_id: task.agentId,
    status: task.status,
    description: task.description,
    output_file: task.outputFile,
    updated_at: task.updatedAt,
  };
}

function taskDetail(task: LocalAgentTask): Record<string, unknown> {
  return {
    ...taskSummary(task),
    prompt: task.prompt,
    progress: task.progress,
    result: task.result,
    error: task.error,
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
