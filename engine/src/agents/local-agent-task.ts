import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { getNeoctlHome } from "../paths.js";
import type { Message } from "../types/messages.js";

export type LocalAgentTaskStatus = "pending" | "running" | "completed" | "failed" | "killed";

export type LocalAgentTaskType = "agent" | "exec";

export interface AgentProgressSnapshot {
  totalEvents: number;
  totalToolUseCount: number;
  lastActivity?: string;
  lastText?: string;
}

export interface LocalAgentTask {
  id: string;
  taskId: string;
  agentId: string;
  agentType?: string;
  type: LocalAgentTaskType;
  status: LocalAgentTaskStatus;
  description: string;
  prompt: string;
  messages: Message[];
  progress: AgentProgressSnapshot;
  outputFile: string;
  result?: AgentToolResult;
  error?: string;
  notified: boolean;
  retain: boolean;
  abortController?: AbortController;
  pendingMessages: Message[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface AgentToolResult {
  agent_id: string;
  agent_type: string;
  content: string;
  status?: "completed" | "incomplete";
  total_duration_ms: number;
  total_tokens?: number;
  total_tool_use_count: number;
  usage?: unknown;
}

export function createLocalAgentTask(input: {
  taskId: string;
  agentId: string;
  agentType?: string;
  description: string;
  prompt: string;
  type?: LocalAgentTaskType;
  outputFile?: string;
  abortController?: AbortController;
  retain?: boolean;
}): LocalAgentTask {
  const now = new Date().toISOString();
  return {
    id: input.taskId,
    taskId: input.taskId,
    agentId: input.agentId,
    agentType: input.agentType,
    type: input.type ?? "agent",
    status: "pending",
    description: input.description,
    prompt: input.prompt,
    messages: [],
    progress: { totalEvents: 0, totalToolUseCount: 0 },
    outputFile: input.outputFile ?? defaultTaskOutputFile(input.taskId),
    notified: false,
    retain: input.retain ?? true,
    abortController: input.abortController,
    pendingMessages: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function updateProgressFromMessage(task: LocalAgentTask, message: Message): void {
  task.progress.totalEvents += 1;
  task.progress.lastActivity = new Date().toISOString();
  const text = message.blocks
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
  if (text) task.progress.lastText = text.slice(-1000);
  task.progress.totalToolUseCount += message.blocks.filter((block) => block.type === "tool_use").length;
  task.updatedAt = new Date().toISOString();
}

export function writeLocalAgentTaskOutput(task: LocalAgentTask): void {
  const content = renderLocalAgentTaskOutput(task);
  mkdirSync(resolve(task.outputFile, ".."), { recursive: true });
  writeFileSync(task.outputFile, content, "utf8");
}

export function renderLocalAgentTaskOutput(task: LocalAgentTask): string {
  return [
    `task_id: ${task.taskId}`,
    `agent_id: ${task.agentId}`,
    task.agentType ? `agent_type: ${task.agentType}` : undefined,
    `status: ${task.status}`,
    `description: ${task.description}`,
    `created_at: ${task.createdAt}`,
    `updated_at: ${task.updatedAt}`,
    task.completedAt ? `completed_at: ${task.completedAt}` : undefined,
    "",
    "prompt:",
    task.prompt,
    "",
    "result:",
    task.result?.content ?? "",
    task.error ? `\nerror:\n${task.error}` : undefined,
  ].filter((line) => line !== undefined).join("\n");
}

function defaultTaskOutputFile(taskId: string): string {
  return resolve(getNeoctlHome(), "agent-tasks", `${taskId}.txt`);
}
