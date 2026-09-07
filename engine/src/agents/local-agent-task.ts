import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { getNeoctlHome } from "../paths.js";
import type { AgentEvent } from "../types/events.js";
import type { Message } from "../types/messages.js";
import type { SecretRedactionRegistry } from "../secrets/secret-types.js";

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
  /** Bounded live delta preview only; transcript is authoritative for full text. */
  visibleText?: { channel: "visible"; runGeneration: number; text: string; truncated: boolean; redactionVersion?: 1 };
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
  /** Actual start of this generation (UTC ISO), never task creation time. */
  startedAt?: string;
  /** Frozen terminal elapsed milliseconds; absent when timestamps are unknown/invalid. */
  durationMs?: number;
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
  /** Actual start of this generation (UTC ISO), never task creation time. */
  startedAt?: string;
  /** Frozen terminal elapsed milliseconds; absent when timestamps are unknown/invalid. */
  durationMs?: number;
  completedAt?: string;
}

export interface AgentToolResult {
  agent_id: string;
  agent_type: string;
  content: string;
  /** Explicit report/visible-text provenance; absent on legacy unproven results. */
  displaySource?: "agent_report" | "visible_text";
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

type PreviewStream = { push(chunk: string): string };
interface PreviewRedactionState {
  runGeneration: number;
  registry?: SecretRedactionRegistry;
  visible?: PreviewStream;
  legacy?: PreviewStream;
  closed: boolean;
}
// Task identity (not an id string) and generation isolate concurrent tasks/resumes.
// Unpublished carry lives only inside these streams, never in progress or task JSON.
const previewRedactions = new WeakMap<LocalAgentTask, PreviewRedactionState>();
function previewStream(registry?: SecretRedactionRegistry): PreviewStream {
  if (!registry) return { push: (chunk) => chunk };
  // A whole-value-only registry cannot prove a delta prefix safe. Fail closed.
  return registry.createStreamingRedactor?.({ incompleteSecret: "redact" }) ?? { push: () => "" };
}

export function updateProgressFromMessage(task: LocalAgentTask, message: Message): void {
  task.progress.totalEvents += 1;
  task.progress.lastActivity = new Date().toISOString();
  const text = message.blocks
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
  if (text) {
    const registry = previewRedactions.get(task)?.registry;
    // A final message is not a visible-delta fallback. Keep the legacy preview
    // safe too, including a terminal message ending in an incomplete secret.
    task.progress.lastText = previewStream(registry).push(text).slice(-1000);
  }
  task.updatedAt = new Date().toISOString();
}

export function updateProgressFromEvent(
  task: LocalAgentTask, event: AgentEvent, runGeneration?: number, secretRedactions?: SecretRedactionRegistry,
): void {
  if (runGeneration !== undefined && task.runGeneration !== runGeneration) return;
  const capturedRun = runGeneration === task.runGeneration && Number.isSafeInteger(runGeneration) && runGeneration! > 0;
  let state = previewRedactions.get(task);
  // Once a registry is attached, an omitted optional argument must not downgrade
  // this task to plaintext. A newly supplied registry takes effect immediately.
  const registry = secretRedactions ?? state?.registry;
  if (!state || state.runGeneration !== task.runGeneration || state.registry !== registry) {
    if (registry) {
      // Existing bounded text cannot be proven safe (a cut may have removed the
      // start of a credential). Do not seed the new stream with a persisted tail.
      task.progress.visibleText = undefined;
      task.progress.lastText = undefined;
    }
    state = { runGeneration: task.runGeneration, registry, closed: state?.runGeneration === task.runGeneration && state.closed === true };
    previewRedactions.set(task, state);
  }
  if (event.type === "terminal" || task.status === "completed" || task.status === "failed" || task.status === "killed") {
    // Discard, NEVER flush an ambiguous prefix on completion/failure/kill.
    state.visible = undefined;
    state.legacy = undefined;
    state.closed = true;
  }
  const acceptsDelta = task.status === "running" && !state.closed && (!registry || capturedRun);
  let safeLegacyDelta = "";
  if (event.type === "assistant.delta" && acceptsDelta) {
    safeLegacyDelta = (state.legacy ??= previewStream(registry)).push(event.text);
    if (event.displayChannel === "visible" && capturedRun) {
      const previous = task.progress.visibleText?.runGeneration === runGeneration && task.progress.visibleText.redactionVersion === 1
        ? task.progress.visibleText : undefined;
      const safeDelta = (state.visible ??= previewStream(registry)).push(event.text);
      const text = `${previous?.text ?? ""}${safeDelta}`;
      task.progress.visibleText = { channel: "visible", runGeneration: runGeneration!, text: text.slice(-4000), truncated: previous?.truncated === true || text.length > 4000, redactionVersion: 1 };
    }
  }
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
  } else if (event.type === "assistant.delta" && safeLegacyDelta) {
    task.progress.lastText = `${task.progress.lastText ?? ""}${safeLegacyDelta}`.slice(-1000);
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

/** Running clocks are derived from the persisted start; terminal clocks never tick. */
export function agentRunDurationMs(run: {
  status: LocalAgentTaskStatus; startedAt?: string; completedAt?: string; durationMs?: number;
}, nowMs = Date.now()): number | undefined {
  const start = agentRunTimestampMs(run.startedAt);
  if (!Number.isFinite(start)) return undefined;
  if (run.status === "running") {
    const elapsed = nowMs - start;
    return Number.isSafeInteger(elapsed) && elapsed >= 0 ? elapsed : undefined;
  }
  if (run.status === "pending") return undefined;
  const end = agentRunTimestampMs(run.completedAt);
  const elapsed = end - start;
  return Number.isSafeInteger(elapsed) && elapsed >= 0 && run.durationMs === elapsed ? elapsed : undefined;
}

/** Accept only the UTC ISO timestamps emitted by the lifecycle, not Date.parse guesses. */
function agentRunTimestampMs(value: unknown): number {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return NaN;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value ? ms : NaN;
}
