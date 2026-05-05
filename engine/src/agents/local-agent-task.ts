import type { Message } from "../types/messages";

export type LocalAgentTaskStatus = "pending" | "running" | "completed" | "failed" | "killed";

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
  type: "agent";
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
  total_duration_ms: number;
  total_tokens?: number;
  total_tool_use_count: number;
  usage?: unknown;
}

export function createLocalAgentTask(input: {
  taskId: string;
  agentId: string;
  description: string;
  prompt: string;
  outputFile?: string;
  abortController?: AbortController;
  retain?: boolean;
}): LocalAgentTask {
  const now = new Date().toISOString();
  return {
    id: input.taskId,
    taskId: input.taskId,
    agentId: input.agentId,
    type: "agent",
    status: "pending",
    description: input.description,
    prompt: input.prompt,
    messages: [],
    progress: { totalEvents: 0, totalToolUseCount: 0 },
    outputFile: input.outputFile ?? `agent-output://${input.taskId}`,
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
