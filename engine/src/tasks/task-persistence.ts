import { isReasoningEffort } from "../model/model-gateway.js";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { agentRunDurationMs, renderLocalAgentTaskOutput, type LocalAgentTask } from "../agents/local-agent-task.js";
import type { Message } from "../types/messages.js";

export type RecoverableTask = LocalAgentTask & {
  deliveryRecoveryMessages?: { message: Message; runGeneration: number }[];
};

export interface TaskLoadSummary { loaded: number; interrupted: number; errors: string[] }
export const INTERRUPTED_TASK_ERROR = "Interrupted: previous process ended before task completion";
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
    // Source of a subagent input (parent agent or runtime notice) is part of what the model sees.
    const source = object(m.metadata) && (m.metadata.agentMessageSource === "parent" || m.metadata.agentMessageSource === "system") && typeof m.metadata.agentMessageKind === "string"
      ? { metadata: { agentMessageSource: m.metadata.agentMessageSource, agentMessageKind: m.metadata.agentMessageKind } } : {};
    return { id: m.id, role: m.role, createdAt: m.createdAt, blocks, ...(m.isMeta === true ? { isMeta: true } : {}), ...source } as Message;
  });
}
function result(value: any): any {
  if (!object(value)) return undefined;
  return { agent_id: value.agent_id, agent_type: value.agent_type, content: value.content,
    displaySource: value.displaySource === "agent_report" || value.displaySource === "visible_text" ? value.displaySource : undefined, status: value.status, total_duration_ms: value.total_duration_ms, total_tokens: value.total_tokens, total_tool_use_count: value.total_tool_use_count };
}
function visibleText(value: unknown, runGeneration: number): LocalAgentTask["progress"]["visibleText"] {
  // Legacy tails may start inside a credential: whole-value re-redaction cannot
  // reconstruct the removed prefix. Only retain previews from the safe pipeline.
  if (!object(value) || value.redactionVersion !== 1 || value.channel !== "visible" || !Number.isSafeInteger(runGeneration) || runGeneration < 1
      || value.runGeneration !== runGeneration || typeof value.text !== "string" || typeof value.truncated !== "boolean") return undefined;
  return { channel: "visible", runGeneration, text: value.text.slice(-4000), truncated: value.truncated || value.text.length > 4000, redactionVersion: 1 };
}
function timestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value ? value : undefined;
}
function timing(value: Pick<LocalAgentTask, "status" | "startedAt" | "completedAt" | "durationMs">) {
  return { startedAt: timestamp(value.startedAt), completedAt: timestamp(value.completedAt),
    durationMs: value.status === "pending" || value.status === "running" ? undefined : agentRunDurationMs(value) };
}
function progress(value: any, runGeneration: number): any {
  if (!object(value) || typeof value.totalEvents !== "number" || typeof value.totalToolUseCount !== "number") throw new Error("Invalid progress");
  return { visibleText: visibleText(value.visibleText, runGeneration), totalEvents: value.totalEvents, totalToolUseCount: value.totalToolUseCount, lastActivity: value.lastActivity, lastText: value.lastText, currentAction: value.currentAction,
    steps: Array.isArray(value.steps) ? value.steps.map((s: any) => ({ id: s.id, title: s.title, status: s.status, detail: s.detail, updatedAt: s.updatedAt })) : undefined,
    journal: journal(value.journal) };
}
function tallies(value: any): Record<string, { calls: number; failed: number }> {
  if (!object(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([, t]: [string, any]) => object(t) && Number.isSafeInteger(t.calls) && Number.isSafeInteger(t.failed))
    .map(([name, t]: [string, any]) => [name, { calls: t.calls, failed: t.failed }]));
}
function journal(value: any) {
  if (!object(value) || !Number.isSafeInteger(value.seq)) return undefined;
  const failure = value.lastFailure;
  return { seq: value.seq, tools: tallies(value.tools),
    milestones: Array.isArray(value.milestones) ? value.milestones.filter((m: any) => object(m) && Number.isSafeInteger(m.seq) && typeof m.report === "string")
      .map((m: any) => ({ seq: m.seq, at: m.at, status: m.status === "completed" || m.status === "incomplete" ? m.status : "draft", report: m.report })) : [],
    lastFailure: object(failure) && Number.isSafeInteger(failure.seq) && typeof failure.tool === "string"
      ? { seq: failure.seq, at: failure.at, tool: failure.tool, ...(typeof failure.purpose === "string" ? { purpose: failure.purpose } : {}) } : undefined };
}
function cursor(value: any): LocalAgentTask["parentCursor"] {
  if (!object(value) || !Number.isSafeInteger(value.seq) || !Number.isSafeInteger(value.runGeneration)) return undefined;
  return { runGeneration: value.runGeneration, seq: value.seq, tools: tallies(value.tools), ...(typeof value.status === "string" ? { status: value.status } : {}) };
}
function execution(value: any): LocalAgentTask["executionOptions"] {
  if (!object(value)) return undefined;
  const numeric = (v: any) => Object.fromEntries(["maxTurns", "maxTokens", "temperature"].filter((k) => typeof v[k] === "number" && Number.isFinite(v[k])).map((k) => [k, v[k]]));
  const reasoning = value.reasoning === null ? null : object(value.reasoning) ? {
    effort: isReasoningEffort(value.reasoning.effort) ? value.reasoning.effort : undefined,
    summary: ["auto", "concise", "detailed"].includes(value.reasoning.summary) ? value.reasoning.summary : undefined,
  } : undefined;
  return { cwd: typeof value.cwd === "string" ? value.cwd : undefined, model: typeof value.model === "string" ? value.model : undefined,
    fastMode: typeof value.fastMode === "boolean" ? value.fastMode : undefined,
    disallowedTools: Array.isArray(value.disallowedTools) ? value.disallowedTools.filter((name: unknown) => typeof name === "string") : undefined,
    reasoning, serviceTier: ["auto", "default", "flex", "priority", "fast"].includes(value.serviceTier) ? value.serviceTier : undefined,
    contextWindowTokensOverride: Number.isFinite(value.contextWindowTokensOverride) ? value.contextWindowTokensOverride : undefined,
    maxOutputTokensOverride: Number.isFinite(value.maxOutputTokensOverride) ? value.maxOutputTokensOverride : undefined,
    ...numeric(value), query: object(value.query) ? numeric(value.query) : undefined };
}
/**
 * Explicit DTO: never spread a live task/runtime into the on-disk record.
 * includeMessages=false leaves the context out: the child session transcript is its durable record.
 */
export function serializeTask(task: RecoverableTask, options: { includeMessages?: boolean } = {}): object {
  if (!validTaskId(task.id) || task.taskId !== task.id || !validTaskId(task.agentId)) throw new Error("Invalid task identifier");
  return { version: 1, id: task.id, taskId: task.taskId, agentId: task.agentId, agentType: task.agentType,
    type: task.type, status: task.status, description: task.description, prompt: task.prompt,
    messages: options.includeMessages === false ? undefined : messages(task.messages ?? []), pendingMessages: messages(task.pendingMessages), progress: progress(task.progress, task.runGeneration),
    deliveryRecoveryMessages: task.deliveryRecoveryMessages?.map((entry) => {
      if (!Number.isSafeInteger(entry.runGeneration) || entry.runGeneration < 1) throw new Error("Invalid delivery generation");
      return { message: messages([entry.message])[0], runGeneration: entry.runGeneration };
    }),
    result: result(task.result), error: task.error, notified: task.notified === true, retain: task.retain, runGeneration: task.runGeneration,
    parentCursor: cursor(task.parentCursor),
    executionOptions: execution(task.executionOptions), names: task.names?.filter((n) => typeof n === "string"),
    messageReceipts: task.messageReceipts?.map((r) => ({ id: r.id, messageId: r.messageId, status: r.status, queuedAt: r.queuedAt, deliveredAt: r.deliveredAt, runGeneration: r.runGeneration })),
    runHistory: task.runHistory?.slice(-8).map((r) => ({ runGeneration: r.runGeneration, status: r.status, result: result(r.result), error: r.error, progress: progress(r.progress, r.runGeneration), ...timing(r), archivedAt: r.archivedAt })),
    createdAt: task.createdAt, updatedAt: task.updatedAt, ...timing(task) };
}
function childTranscriptExists(sessionDir: string, agentId: string): boolean {
  return validTaskId(agentId) && existsSync(join(resolve(sessionDir), "subagents", agentId, "transcript.jsonl"));
}
export function persistTask(task: LocalAgentTask): void {
  if (!task.ownerSessionDir) return;
  // The child transcript holds the context; the task record copies it only until that exists (legacy tasks).
  const data = JSON.stringify(serializeTask(task, { includeMessages: !childTranscriptExists(task.ownerSessionDir, task.agentId) }));
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
      // A context copy from older records is kept only when the child transcript does not exist.
      const legacyContext = Array.isArray(raw.messages) && !existsSync(join(dir, "transcript.jsonl")) ? raw.messages : [];
      const task = { ...serializeTask({ ...raw, messages: legacyContext } as LocalAgentTask), ownerSessionDir: owner, outputFile: join(dir, "output.txt"), notified: raw.notified === true, retain: raw.retain !== false } as LocalAgentTask;
      if (task.status === "pending" || task.status === "running") {
        task.notified = false;
        task.status = "killed"; task.error = INTERRUPTED_TASK_ERROR;
        // Recovery observes an interruption, not its actual time. Never freeze at reload time.
        task.completedAt = undefined; task.durationMs = undefined; summary.interrupted++;
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
