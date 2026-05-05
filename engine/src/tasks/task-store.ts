import { createTextMessage, type Message } from "../types/messages.js";
import { writeLocalAgentTaskOutput, type AgentToolResult, type LocalAgentTask, type LocalAgentTaskStatus } from "../agents/local-agent-task.js";

export class TaskStore {
  private readonly tasks = new Map<string, LocalAgentTask>();
  private readonly agentNames = new Map<string, string>();
  private readonly waiters = new Set<() => void>();

  upsert(task: LocalAgentTask): void {
    task.updatedAt = new Date().toISOString();
    this.tasks.set(task.id, task);
    this.notify();
  }

  get(id: string): LocalAgentTask | undefined {
    return this.tasks.get(id);
  }

  getByAgentId(agentId: string): LocalAgentTask | undefined {
    return [...this.tasks.values()].find((task) => task.agentId === agentId);
  }

  list(): LocalAgentTask[] {
    return [...this.tasks.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  registerName(name: string, agentId: string): void {
    this.agentNames.set(name, agentId);
  }

  resolveAgentName(nameOrId: string): string | undefined {
    return this.agentNames.get(nameOrId) ?? (this.getByAgentId(nameOrId) ? nameOrId : undefined);
  }

  appendMessage(taskId: string, message: Message): void {
    const task = this.require(taskId);
    task.messages.push(message);
    this.upsert(task);
  }

  queueMessage(agentNameOrId: string, text: string): { ok: true; task: LocalAgentTask } | { ok: false; error: string } {
    const agentId = this.resolveAgentName(agentNameOrId);
    if (!agentId) return { ok: false, error: `Unknown agent: ${agentNameOrId}` };
    const task = this.getByAgentId(agentId);
    if (!task) return { ok: false, error: `No task found for agent: ${agentNameOrId}` };
    task.pendingMessages.push(createTextMessage("user", text));
    this.upsert(task);
    return { ok: true, task };
  }

  markRunning(taskId: string): void {
    this.patch(taskId, { status: "running" });
  }

  complete(taskId: string, result: AgentToolResult): void {
    this.patchTerminal(taskId, { status: "completed", result, completedAt: new Date().toISOString() });
  }

  fail(taskId: string, error: string): void {
    this.patchTerminal(taskId, { status: "failed", error, completedAt: new Date().toISOString() });
  }

  kill(taskId: string, reason = "Task stopped"): void {
    const task = this.require(taskId);
    task.abortController?.abort(reason);
    task.status = "killed";
    task.error = reason;
    task.completedAt = new Date().toISOString();
    this.persistTerminalOutput(task);
    this.upsert(task);
  }

  markNotified(taskId: string): void {
    this.patch(taskId, { notified: true });
  }

  isTerminal(task: LocalAgentTask): boolean {
    return isTerminalStatus(task.status);
  }

  waitForTerminal(taskId: string, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<LocalAgentTask | undefined> {
    const existing = this.get(taskId);
    if (!existing) return Promise.resolve(undefined);
    if (this.isTerminal(existing)) return Promise.resolve(existing);

    return new Promise((resolve) => {
      const deadline = options.timeoutMs ? Date.now() + options.timeoutMs : undefined;
      let timeout: NodeJS.Timeout | undefined;
      const done = (task: LocalAgentTask | undefined) => {
        if (timeout) clearTimeout(timeout);
        this.waiters.delete(listener);
        options.signal?.removeEventListener("abort", abort);
        resolve(task);
      };
      const listener = () => {
        const task = this.get(taskId);
        if (!task || this.isTerminal(task)) done(task);
      };
      const abort = () => done(this.get(taskId));
      if (deadline) timeout = setTimeout(() => done(this.get(taskId)), Math.max(0, deadline - Date.now()));
      options.signal?.addEventListener("abort", abort, { once: true });
      this.waiters.add(listener);
    });
  }

  private patch(taskId: string, fields: Partial<LocalAgentTask>): void {
    const task = this.require(taskId);
    Object.assign(task, fields);
    this.upsert(task);
  }

  private patchTerminal(taskId: string, fields: Partial<LocalAgentTask>): void {
    const task = this.require(taskId);
    Object.assign(task, fields);
    this.persistTerminalOutput(task);
    this.upsert(task);
  }

  private persistTerminalOutput(task: LocalAgentTask): void {
    try {
      writeLocalAgentTaskOutput(task);
    } catch (error) {
      task.error = task.error ?? `Failed to write output file: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  private require(taskId: string): LocalAgentTask {
    const task = this.get(taskId);
    if (!task) throw new Error(`Unknown task: ${taskId}`);
    return task;
  }

  private notify(): void {
    for (const waiter of [...this.waiters]) waiter();
  }
}

export function isTerminalStatus(status: LocalAgentTaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "killed";
}

export const globalTaskStore = new TaskStore();
