export type LocalAgentTaskStatus = "queued" | "running" | "completed" | "failed" | "stopped";

export interface LocalAgentTask {
  id: string;
  agentId: string;
  status: LocalAgentTaskStatus;
  prompt: string;
  progress: string[];
  outputFile?: string;
  result?: unknown;
  error?: string;
  createdAt: string;
  updatedAt: string;
}
