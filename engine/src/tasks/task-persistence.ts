import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { renderLocalAgentTaskOutput, type LocalAgentTask } from "../agents/local-agent-task.js";
import type { Message } from "../types/messages.js";

export type RecoverableTask = LocalAgentTask & {
  deliveryRecoveryMessages?: { message: Message; runGeneration: number }[];
};

export interface TaskLoadSummary { loaded: number; interrupted: number; errors: string[] }
export const MAX_TASK_RECORD_BYTES = 64 * 1024 * 1024;
const statuses = ["pending", "running", "completed", "failed", "killed"];
export function validTaskId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$/.test(value);
}
function object(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function directory(path: string, create: boolean): void {
  if (create && !existsSync(path)) mkdirSync(path);
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe task directory");
}
function taskDirectory(sessionDir: string, agentId: string, create: boolean): string {
  if (!validTaskId(agentId)) throw new Error("Invalid agent identifier");
  // The parent is trusted input; every descendant is checked to reject symlink/junction escape.
  const parent = realpathSync(resolve(sessionDir));
  const root = join(parent, "subagents");
  directory(root, create);
  const child = join(root, agentId);
  directory(child, create);
  return child;
}
function checkedFile(path: string): void {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) throw new Error("Unsafe task file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
function messages(value: unknown): Message[] {
  if (!Array.isArray(value)) throw new Error("Invalid messages");
  return value.map((m) => {
    if (!object(m) || typeof m.id !== "string" || typeof m.createdAt !== "string" || !["system", "user", "assistant", "tool_result", "progress", "attachment", "tombstone"].includes(m.role) || !Array.isArray(m.blocks) || !m.blocks.every((b: unknown) => object(b) && typeof b.type === "string" && (b.type !== "text" || typeof b.text === "string"))) throw new Error("Invalid message");
    // Metadata can hold runtime objects; transcript is authoritative for provider metadata.
    const blocks = m.blocks.map((b: any) => {
      switch (b.type) {
        case "text": return { type: b.type, text: b.text };
        case "thinking": return { type: b.type, text: b.text, signature: b.signature };
        case "image": return { type: b.type, mimeType: b.mimeType, data: b.data, imageId: b.imageId, label: b.label,
          storage: object(b.storage) ? { path: b.storage.path, format: b.storage.format, contentHash: b.storage.contentHash, storedBytes: b.storage.storedBytes } : undefined };
        case "tool_use": return { type: b.type, id: b.id, name: b.name, input: b.input };
        case "tool_result": return { type: b.type, toolUseId: b.toolUseId, name: b.name, ok: b.ok, output: b.output };
        default: throw new Error("Invalid message block");
      }
    });
    return { id: m.id, role: m.role, createdAt: m.createdAt, blocks } as Message;
  });
}
function result(value: any): any {
  if (!object(value)) return undefined;
  return { agent_id: value.agent_id, agent_type: value.agent_type, content: value.content, status: value.status, total_duration_ms: value.total_duration_ms, total_tokens: value.total_tokens, total_tool_use_count: value.total_tool_use_count };
}
function progress(value: any): any {
  if (!object(value) || typeof value.totalEvents !== "number" || typeof value.totalToolUseCount !== "number") throw new Error("Invalid progress");
  return { totalEvents: value.totalEvents, totalToolUseCount: value.totalToolUseCount, lastActivity: value.lastActivity, lastText: value.lastText, currentAction: value.currentAction,
    steps: Array.isArray(value.steps) ? value.steps.map((s: any) => ({ id: s.id, title: s.title, status: s.status, detail: s.detail, updatedAt: s.updatedAt })) : undefined };
}
function execution(value: any): LocalAgentTask["executionOptions"] {
  if (!object(value)) return undefined;
  const numeric = (v: any) => Object.fromEntries(["maxTurns", "maxTokens", "temperature"].filter((k) => typeof v[k] === "number" && Number.isFinite(v[k])).map((k) => [k, v[k]]));
  const reasoning = value.reasoning === null ? null : object(value.reasoning) ? {
    effort: ["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value.reasoning.effort) ? value.reasoning.effort : undefined,
    summary: ["auto", "concise", "detailed"].includes(value.reasoning.summary) ? value.reasoning.summary : undefined,
  } : undefined;
  return { cwd: typeof value.cwd === "string" ? value.cwd : undefined, model: typeof value.model === "string" ? value.model : undefined,
    reasoning, serviceTier: ["auto", "default", "flex", "priority", "fast"].includes(value.serviceTier) ? value.serviceTier : undefined,
    contextWindowTokensOverride: Number.isFinite(value.contextWindowTokensOverride) ? value.contextWindowTokensOverride : undefined,
    maxOutputTokensOverride: Number.isFinite(value.maxOutputTokensOverride) ? value.maxOutputTokensOverride : undefined,
    ...numeric(value), query: object(value.query) ? numeric(value.query) : undefined };
}
/** Explicit DTO: never spread a live task/runtime into the on-disk record. */
export function serializeTask(task: RecoverableTask): object {
  if (!validTaskId(task.id) || task.taskId !== task.id || !validTaskId(task.agentId)) throw new Error("Invalid task identifier");
  return { version: 1, id: task.id, taskId: task.taskId, agentId: task.agentId, agentType: task.agentType,
    type: task.type, status: task.status, description: task.description, prompt: task.prompt,
    messages: messages(task.messages), pendingMessages: messages(task.pendingMessages), progress: progress(task.progress),
    deliveryRecoveryMessages: task.deliveryRecoveryMessages?.map((entry) => {
      if (!Number.isSafeInteger(entry.runGeneration) || entry.runGeneration < 1) throw new Error("Invalid delivery generation");
      return { message: messages([entry.message])[0], runGeneration: entry.runGeneration };
    }),
    result: result(task.result), error: task.error, notified: task.notified === true, retain: task.retain, runGeneration: task.runGeneration,
    executionOptions: execution(task.executionOptions), names: task.names?.filter((n) => typeof n === "string"),
    messageReceipts: task.messageReceipts?.map((r) => ({ id: r.id, messageId: r.messageId, status: r.status, queuedAt: r.queuedAt, deliveredAt: r.deliveredAt, runGeneration: r.runGeneration })),
    runHistory: task.runHistory?.slice(-8).map((r) => ({ runGeneration: r.runGeneration, status: r.status, result: result(r.result), error: r.error, progress: progress(r.progress), completedAt: r.completedAt, archivedAt: r.archivedAt })),
    createdAt: task.createdAt, updatedAt: task.updatedAt, completedAt: task.completedAt };
}
export function persistTask(task: LocalAgentTask): void {
  if (!task.ownerSessionDir) return;
  const data = JSON.stringify(serializeTask(task));
  // Check UTF-8 bytes before creating directories, temp files or replacing snapshots.
  if (Buffer.byteLength(data, "utf8") > MAX_TASK_RECORD_BYTES) throw new Error("Oversized task record");
  const dir = taskDirectory(task.ownerSessionDir, task.agentId, true);
  const target = join(dir, "task.json");
  checkedFile(target);
  const temporary = join(dir, `.task-${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, data, "utf8");
    fsyncSync(fd);
    closeSync(fd); fd = undefined;
    renameSync(temporary, target);
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
export function loadTasks(sessionDir: string): { tasks: LocalAgentTask[]; summary: TaskLoadSummary } {
  const tasks: LocalAgentTask[] = [];
  const summary: TaskLoadSummary = { loaded: 0, interrupted: 0, errors: [] };
  const owner = resolve(sessionDir);
  const root = join(owner, "subagents");
  if (!existsSync(root)) return { tasks, summary };
  let entries: string[];
  try { directory(root, false); entries = readdirSync(root); }
  catch { summary.errors.push("Unable to read task directory"); return { tasks, summary }; }
  for (const agentId of entries) {
    try {
      if (!validTaskId(agentId)) throw new Error("Invalid identifier");
      const dir = taskDirectory(owner, agentId, false);
      const file = join(dir, "task.json");
      if (!existsSync(file)) continue; // Child transcript may exist before the first task snapshot.
      checkedFile(file);
      if (lstatSync(file).size > MAX_TASK_RECORD_BYTES) throw new Error("Oversized task record");
      const raw = JSON.parse(readFileSync(file, "utf8"));
      if (!object(raw) || raw.version !== 1 || raw.agentId !== agentId || !validTaskId(raw.id) || raw.taskId !== raw.id || !statuses.includes(raw.status) || !["agent", "exec", "image"].includes(raw.type) || ![raw.prompt, raw.description, raw.createdAt, raw.updatedAt].every((v) => typeof v === "string") || !Number.isSafeInteger(raw.runGeneration) || raw.runGeneration < 1) throw new Error("Invalid task record");
      if (raw.messageReceipts !== undefined && (!Array.isArray(raw.messageReceipts) || !raw.messageReceipts.every((r: any) => object(r) && typeof r.id === "string" && typeof r.messageId === "string" && ["queued", "delivered"].includes(r.status) && typeof r.queuedAt === "string" && Number.isSafeInteger(r.runGeneration)))) throw new Error("Invalid receipts");
      if (raw.runHistory !== undefined && !Array.isArray(raw.runHistory)) throw new Error("Invalid history");
      const task = { ...serializeTask(raw as LocalAgentTask), ownerSessionDir: owner, outputFile: join(dir, "output.txt"), notified: raw.notified === true, retain: raw.retain !== false } as LocalAgentTask;
      if (task.status === "pending" || task.status === "running") {
        task.notified = false;
        task.status = "killed"; task.error = "Interrupted: previous process ended before task completion";
        task.completedAt = new Date().toISOString(); summary.interrupted++;
      }
      if (tasks.some((other) => other.id === task.id)) throw new Error("Duplicate identifier");
      // Output is derived, never trust a persisted arbitrary filesystem path.
      checkedFile(task.outputFile);
      try {
        writeFileSync(task.outputFile, renderLocalAgentTaskOutput(task), { encoding: "utf8", mode: 0o600 });
      } catch { summary.errors.push("Unable to regenerate task output"); }
      tasks.push(task); summary.loaded++;
    } catch { summary.errors.push("Skipped invalid or unreadable task record"); }
  }
  return { tasks, summary };
}
