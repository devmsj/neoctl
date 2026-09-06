import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { getNeoctlHome } from "../paths.js";
import type { AgentEvent } from "../types/events.js";
import type { Message } from "../types/messages.js";

export type LocalAgentTaskStatus = "pending" | "running" | "completed" | "failed" | "killed";

export type LocalAgentTaskType = "agent" | "exec" | "image";

export interface AgentProgressStep {
  id: string;
  title: string;
  status: "running" | "completed" | "failed";
  detail?: string;
  updatedAt: string;
}

export interface AgentProgressSnapshot {
  totalEvents: number;
  totalToolUseCount: number;
  lastActivity?: string;
  lastText?: string;
  currentAction?: string;
  steps?: AgentProgressStep[];
}

/** Delivered means included in a model request, not understood or completed. */
export interface AgentMessageReceipt {
  id: string;
  messageId: string;
  status: "queued" | "delivered";
  queuedAt: string;
  deliveredAt?: string;
  runGeneration: number;
}
export interface AgentRunArchive {
  runGeneration: number;
  status: LocalAgentTaskStatus;
  result?: AgentToolResult;
  error?: string;
  progress: AgentProgressSnapshot;
  completedAt?: string;
  archivedAt: string;
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
  runGeneration: number;
  /** Internal launch settings only; no credentials or parent runtime state. */
  executionOptions?: {
    cwd?: string; model?: string;
    reasoning?: import("../model/model-gateway.js").ReasoningConfig | null;
    contextWindowTokensOverride?: number;
    maxOutputTokensOverride?: number;
    serviceTier?: "auto" | "default" | "flex" | "priority" | "fast";
    maxTurns?: number; maxTokens?: number; temperature?: number;
    query?: { maxTurns?: number; maxTokens?: number; temperature?: number };
  };
  /** Owning parent session. Never inferred again after initial insertion. */
  ownerSessionDir?: string;
  /** Session-scoped aliases, persisted with the task. */
  names?: string[];
  messageReceipts?: AgentMessageReceipt[];
  runHistory?: AgentRunArchive[];
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
    runGeneration: 1,
    messageReceipts: [],
    runHistory: [],
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
  task.updatedAt = new Date().toISOString();
}

export function updateProgressFromEvent(task: LocalAgentTask, event: AgentEvent): void {
  const now = new Date().toISOString();
  task.progress.totalEvents += 1;
  task.progress.lastActivity = now;
  const steps = [...(task.progress.steps ?? [])];
  const upsert = (id: string, title: string, status: AgentProgressStep["status"], detail?: string) => {
    const index = steps.findIndex((step) => step.id === id);
    const existing = index >= 0 ? steps[index] : undefined;
    const terminal = existing?.status === "completed" || existing?.status === "failed";
    if (terminal && status === "running") return;
    const step = { id, title, status, detail, updatedAt: now };
    if (index >= 0) steps[index] = step;
    else steps.push(step);
    task.progress.steps = steps.slice(-24);
    task.progress.currentAction = title;
  };
  if (event.type === "tool.started") {
    task.progress.totalToolUseCount += 1;
    upsert(event.toolUse.id, event.toolUse.name, "running");
  } else if (event.type === "tool.progress") {
    upsert(event.toolUse.id, event.progress.message || event.toolUse.name, "running");
  } else if (event.type === "tool.result.available") {
    upsert(event.toolUse.id, event.toolUse.name, event.ok ? "completed" : "failed");
  } else if (event.type === "state" && event.phase !== "running_tools") {
    task.progress.currentAction = event.detail || event.phase;
  } else if (event.type === "assistant.delta" && event.text.trim()) {
    task.progress.lastText = `${task.progress.lastText ?? ""}${event.text}`.slice(-1000);
  }
  task.updatedAt = now;
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
    `run_generation: ${task.runGeneration}`,
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
