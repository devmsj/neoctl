import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { INTERRUPTED_TASK_ERROR, loadTasks, persistTask, type TaskLoadSummary, type RecoverableTask } from "./task-persistence.js";
import { createTextMessage, type Message } from "../types/messages.js";
import { writeLocalAgentTaskOutput, type AgentMessageReceipt, type AgentToolResult, type LocalAgentTask, type LocalAgentTaskStatus } from "../agents/local-agent-task.js";

export class TaskStore {
  private readonly tasks = new Map<string, LocalAgentTask>();
  private readonly agentNames = new Map<string, string>();
  private readonly waiters = new Set<() => void>();
  private readonly subscribers = new Set<() => void>();

  private sessionDir?: string;
  private readonly loadedSessions = new Set<string>();

  /** Activate a view; background tasks in other sessions retain their lifecycle. */
  bindSession(sessionDir?: string): TaskLoadSummary {
    this.sessionDir = sessionDir ? resolve(sessionDir) : undefined;
    const summary: TaskLoadSummary = { loaded: 0, interrupted: 0, errors: [] };
    if (this.sessionDir && !this.loadedSessions.has(this.sessionDir)) {
      const loaded = loadTasks(this.sessionDir);
      Object.assign(summary, loaded.summary);
      for (const task of loaded.tasks) {
        if (this.tasks.has(task.id)) {
          summary.loaded--; summary.errors.push("Skipped conflicting task identifier");
          continue;
        }
        this.tasks.set(task.id, task);
        try { persistTask(task); } catch { summary.errors.push("Unable to persist recovered task state"); }
      }
      this.loadedSessions.add(this.sessionDir);
    }
    this.notify();
    return summary;
  }

  loadSession(sessionDir: string): TaskLoadSummary { return this.bindSession(sessionDir); }
  get activeSessionDir(): string | undefined { return this.sessionDir; }
  getActive(id: string): LocalAgentTask | undefined {
    const task = this.get(id);
    return task && this.isActive(task) ? task : undefined;
  }
  private isActive(task: LocalAgentTask): boolean { return task.ownerSessionDir === this.sessionDir; }

  private readonly persistenceTimers = new Map<string, NodeJS.Timeout>();

  activateSession(sessionDir?: string): TaskLoadSummary { return this.bindSession(sessionDir); }
  getInSession(id: string, sessionDir?: string): LocalAgentTask | undefined {
    const task = this.get(id);
    return task?.ownerSessionDir === (sessionDir ? resolve(sessionDir) : undefined) ? task : undefined;
  }
  private readonly explicitlyOwnedTasks = new WeakSet<LocalAgentTask>();
  attachTask(task: LocalAgentTask, sessionDir?: string): void {
    this.explicitlyOwnedTasks.add(task);
    task.ownerSessionDir = sessionDir ? resolve(sessionDir) : undefined;
    this.upsert(task);
  }
  /** Progress only: coalesce token deltas; message and lifecycle methods remain durable. */
  updateProgress(task: LocalAgentTask): void { this.upsert(task, { persist: false }); }
  flush(): void {
    for (const [id, timer] of this.persistenceTimers) {
      clearTimeout(timer);
      const task = this.get(id);
      if (task) persistTask(task);
      this.persistenceTimers.delete(id);
    }
  }

  upsert(task: LocalAgentTask, options: { persist?: boolean } = {}): void {
    const existing = this.tasks.get(task.id);
    if (existing && existing !== task && existing.ownerSessionDir !== task.ownerSessionDir) throw new Error("Conflicting task owner");
    if (!existing && task.ownerSessionDir === undefined && !this.explicitlyOwnedTasks.has(task)) task.ownerSessionDir = this.sessionDir;
    if (task.ownerSessionDir) task.ownerSessionDir = resolve(task.ownerSessionDir);
    if ([...this.tasks.values()].some((other) => other.id !== task.id && other.ownerSessionDir === task.ownerSessionDir && other.agentId === task.agentId)) throw new Error("Conflicting agent identifier");
    task.updatedAt = new Date().toISOString();
    if (options.persist === false && existing && task.ownerSessionDir) {
      if (!this.persistenceTimers.has(task.id)) {
        const timer = setTimeout(() => {
          this.persistenceTimers.delete(task.id);
          const current = this.get(task.id);
          try { if (current) persistTask(current); }
          catch { /* Progress is best effort; the next durable boundary retries. */ }
        }, 500);
        timer.unref();
        this.persistenceTimers.set(task.id, timer);
      }
    } else {
      const timer = this.persistenceTimers.get(task.id);
      if (timer) clearTimeout(timer);
      this.persistenceTimers.delete(task.id);
      persistTask(task);
    }
    this.tasks.set(task.id, task);
    this.notify();
  }

  get(id: string): LocalAgentTask | undefined {
    return this.tasks.get(id);
  }

  getByAgentId(agentId: string): LocalAgentTask | undefined {
    return this.list().find((task) => task.agentId === agentId);
  }

  list(): LocalAgentTask[] { return this.listInSession(this.sessionDir); }

  recoverableInterruptedTasks(sessionDir?: string): LocalAgentTask[] {
    return this.listInSession(sessionDir ?? this.sessionDir).filter((task) => !task.notified && isRecoverableInterruptedTask(task));
  }

  /** Explicit query scope; undefined means unowned, never the foreground view. */
  listInSession(sessionDir?: string): LocalAgentTask[] {
    const owner = sessionDir ? resolve(sessionDir) : undefined;
    return [...this.tasks.values()].filter((task) => task.ownerSessionDir === owner).sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  activeCount(): number {
    return this.list().filter((task) => !this.isTerminal(task)).length;
  }

  subscribe(listener: () => void): () => void {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  registerName(name: string, agentId: string): void {
    this.agentNames.set(`${this.sessionDir ?? ""}\0${name}`, agentId);
    const task = this.getByAgentId(agentId);
    if (task) { task.names = [...new Set([...(task.names ?? []), name])]; this.upsert(task); }
  }

  resolveAgentName(nameOrId: string): string | undefined {
    return this.list().find((task) => task.names?.includes(nameOrId))?.agentId ?? this.agentNames.get(`${this.sessionDir ?? ""}\0${nameOrId}`) ?? (this.getByAgentId(nameOrId) ? nameOrId : undefined);
  }

  appendMessage(taskId: string, message: Message): void {
    const task = this.require(taskId);
    task.messages.push(message);
    this.upsert(task);
  }

  queueMessage(agentNameOrId: string, text: string): { ok: true; task: LocalAgentTask; receipt: AgentMessageReceipt } | { ok: false; error: string } {
    return this.queueMessageInSession(agentNameOrId, text, this.sessionDir);
  }

  queueMessageInSession(agentNameOrId: string, text: string, sessionDir?: string): { ok: true; task: LocalAgentTask; receipt: AgentMessageReceipt } | { ok: false; error: string } {
    const owner = sessionDir ? resolve(sessionDir) : undefined;
    const tasks = this.listInSession(owner);
    const agentId = tasks.find((task) => task.names?.includes(agentNameOrId))?.agentId
      ?? this.agentNames.get(`${owner ?? ""}\0${agentNameOrId}`)
      ?? tasks.find((task) => task.agentId === agentNameOrId)?.agentId;
    if (!agentId) return { ok: false, error: `Unknown agent: ${agentNameOrId}` };
    const task = tasks.find((task) => task.agentId === agentId);
    if (!task) return { ok: false, error: `No task found for agent: ${agentNameOrId}` };
    if (task.pendingMessages.length >= 256) return { ok: false, error: "Agent inbox is full (256 pending messages); retry after delivery or resume" };
    if (text.length > 16 * 1024) return { ok: false, error: "Agent message exceeds 16384 characters; split it into smaller messages" };
    const message = createTextMessage("user", text);
    const receipt: AgentMessageReceipt = { id: randomUUID(), messageId: message.id, status: "queued", queuedAt: new Date().toISOString(), runGeneration: task.runGeneration };
    task.pendingMessages.push(message);
    (task.messageReceipts ??= []).push(receipt);
    try { this.upsert(task); }
    catch {
      task.pendingMessages = task.pendingMessages.filter((entry) => entry.id !== message.id);
      task.messageReceipts = task.messageReceipts?.filter((entry) => entry.id !== receipt.id);
      return { ok: false, error: "Unable to persist queued agent message" };
    }
    return { ok: true, task, receipt };
  }

  drainPendingMessages(taskId: string): Message[] {
    const task = this.get(taskId);
    if (!task || task.pendingMessages.length === 0) return [];
    const drained = task.pendingMessages.splice(0);
    try { this.upsert(task); }
    catch { task.pendingMessages = drained; throw new Error("Unable to persist inbox drain"); }
    return drained;
  }

  /** Synchronous handoff at the next model-request boundary, never during tool execution. */
  deliverPendingMessages(taskId: string, runGeneration: number): Message[] {
    const task = this.get(taskId);
    if (!task || task.runGeneration !== runGeneration || task.status !== "running" || task.abortController?.signal.aborted) return [];
    let count = 0;
    let characters = 0;
    for (const message of task.pendingMessages) {
      const size = message.blocks.reduce((total, block) => total + (block.type === "text" ? block.text.length : JSON.stringify(block).length), 0);
      if (characters + size > 32 * 1024) break;
      characters += size;
      count += 1;
    }
    const recoveryTask = task as RecoverableTask;
    const previousRecovery = recoveryTask.deliveryRecoveryMessages;
    const previousPending = [...task.pendingMessages];
    const previousMessages = [...task.messages];
    const previousReceipts = structuredClone(task.messageReceipts);
    const messages = task.pendingMessages.splice(0, count);
    if (!messages.length) return messages;
    recoveryTask.deliveryRecoveryMessages = [...(previousRecovery ?? []), ...messages.map((message) => ({ message, runGeneration }))];
    const now = new Date().toISOString();
    const receipts = task.messageReceipts ??= [];
    for (const message of messages) {
      let receipt = receipts.find((entry) => entry.messageId === message.id);
      if (!receipt) {
        receipt = { id: randomUUID(), messageId: message.id, status: "queued", queuedAt: now, runGeneration };
        receipts.push(receipt);
      }
      Object.assign(receipt, { status: "delivered", deliveredAt: now, runGeneration });
      task.messages.push(message);
    }
    const delivered = receipts.filter((entry) => entry.status === "delivered").slice(-128);
    task.messageReceipts = receipts.filter((entry) => entry.status === "queued" || delivered.includes(entry));
    try { this.upsert(task); }
    catch {
      recoveryTask.deliveryRecoveryMessages = previousRecovery;
      task.pendingMessages = previousPending;
      task.messages = previousMessages;
      task.messageReceipts = previousReceipts;
      throw new Error("Unable to persist inbox delivery");
    }
    return messages;
  }

  /** Call after durable transcript append and BEFORE compaction/model execution.
   * A stale generation cannot acknowledge a newer handoff. Failure must stop the run.
   */
  confirmDelivery(taskId: string, messageIds: readonly string[], runGeneration: number): void {
    const task = this.require(taskId) as RecoverableTask;
    if (task.runGeneration !== runGeneration) return;
    const previous = task.deliveryRecoveryMessages;
    if (!previous?.length) return;
    const ids = new Set(messageIds);
    task.deliveryRecoveryMessages = previous.filter((entry) => entry.runGeneration !== runGeneration || !ids.has(entry.message.id));
    if (task.deliveryRecoveryMessages.length === previous.length) return;
    try { this.upsert(task); }
    catch { task.deliveryRecoveryMessages = previous; throw new Error("Unable to persist delivery confirmation"); }
  }

  /** Only unconfirmed outbox entries may be retried. Missing historical receipt IDs
   * may simply have been compacted, so they NEVER imply an undelivered message.
   * persistedMessageIds can include IDs from the complete append-only transcript log.
   */
  reconcileMessages(taskId: string, transcript: readonly Message[], persistedMessageIds: Iterable<string> = transcript.map((message) => message.id)): void {
    const task = this.require(taskId) as RecoverableTask;
    const present = new Set(persistedMessageIds);
    const previousRecovery = task.deliveryRecoveryMessages;
    const previousPending = task.pendingMessages;
    const previousMessages = task.messages;
    const previousReceipts = structuredClone(task.messageReceipts);
    task.pendingMessages = task.pendingMessages.filter((message) => !present.has(message.id));
    for (const entry of previousRecovery ?? []) {
      const receipt = task.messageReceipts?.find((receipt) => receipt.messageId === entry.message.id);
      if (present.has(entry.message.id)) {
        if (receipt) receipt.status = "delivered";
      } else {
        if (!task.pendingMessages.some((message) => message.id === entry.message.id)) task.pendingMessages.push(entry.message);
        if (receipt) { receipt.status = "queued"; receipt.deliveredAt = undefined; }
      }
    }
    for (const receipt of task.messageReceipts ?? []) {
      if (present.has(receipt.messageId)) receipt.status = "delivered";
    }
    task.deliveryRecoveryMessages = [];
    task.messages = [...transcript];
    try { this.upsert(task); }
    catch {
      task.deliveryRecoveryMessages = previousRecovery;
      task.pendingMessages = previousPending;
      task.messages = previousMessages;
      task.messageReceipts = previousReceipts;
      throw new Error("Unable to persist delivery reconciliation");
    }
  }

  prepareResume(taskId: string, abortController: AbortController): LocalAgentTask {
    const task = this.require(taskId);
    if (task.type !== "agent" || !this.isTerminal(task)) throw new Error("Only terminal agent tasks can be resumed");
    task.abortController?.abort("Superseded by resumed generation");
    task.runHistory = [...(task.runHistory ?? []), {
      runGeneration: task.runGeneration, status: task.status, result: task.result,
      error: task.error, progress: structuredClone(task.progress), completedAt: task.completedAt,
      archivedAt: new Date().toISOString(),
    }].slice(-8);
    task.runGeneration += 1;
    task.status = "pending";
    task.abortController = abortController;
    task.result = undefined;
    task.error = undefined;
    task.progress = { totalEvents: 0, totalToolUseCount: 0 };
    task.completedAt = undefined;
    task.notified = false;
    // Replace the stable output file so it cannot masquerade as the new generation's result.
    this.persistTerminalOutput(task);
    this.upsert(task);
    return task;
  }

  collectUnnotifiedCompletions(...scope: [sessionDir?: string]): LocalAgentTask[] {
    const owner = scope.length ? (scope[0] ? resolve(scope[0]) : undefined) : this.sessionDir;
    return [...this.tasks.values()].filter(
      (task) => task.ownerSessionDir === owner && this.isTerminal(task) && !task.notified && !isRecoverableInterruptedTask(task),
    );
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
    const task = this.require(taskId);
    if (task.notified || !this.isTerminal(task)) return;
    // Collection is read-only. Commit the acknowledgement before exposing it in
    // memory; a failed atomic write must leave the completion retryable.
    const acknowledged = { ...task, notified: true, updatedAt: new Date().toISOString() };
    persistTask(acknowledged);
    task.notified = true;
    task.updatedAt = acknowledged.updatedAt;
    this.notify();
  }

  isTerminal(task: LocalAgentTask): boolean {
    return isTerminalStatus(task.status);
  }

  waitForTerminal(taskId: string, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<LocalAgentTask | undefined> {
    const existing = this.get(taskId);
    if (!existing) return Promise.resolve(undefined);
    if (this.isTerminal(existing) || options.signal?.aborted) return Promise.resolve(existing);

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
    if (this.isTerminal(task)) return;
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
    for (const subscriber of [...this.subscribers]) subscriber();
  }
}

export function isTerminalStatus(status: LocalAgentTaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "killed";
}

export function isRecoverableInterruptedTask(task: LocalAgentTask): boolean {
  return task.type === "agent" && task.status === "killed" && task.error === INTERRUPTED_TASK_ERROR;
}

export const globalTaskStore = new TaskStore();
