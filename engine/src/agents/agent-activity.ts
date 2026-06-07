import type { ModelUsage } from "../model/model-gateway.js";
import type { AgentEvent } from "../types/events.js";
import type { Message, MessageBlock, ToolUseRequest } from "../types/messages.js";
import type { AgentToolResult } from "./local-agent-task.js";

export type AgentActivityMode = "sync" | "background" | "fork" | "explore";
export type AgentActivityStatus = "pending" | "running" | "completed" | "failed" | "killed";
export type AgentTimelineEntryKind = "text" | "thinking" | "tool_start" | "tool_result" | "status" | "error";

export interface AgentTimelineEntry {
  id: string;
  at: string;
  kind: AgentTimelineEntryKind;
  title: string;
  detail?: string;
  status?: "running" | "ok" | "failed";
}

export interface AgentToolActivity {
  id?: string;
  name: string;
  inputPreview?: string;
  startedAt: string;
}

export interface AgentActivity {
  activityId: string;
  agentId: string;
  taskId?: string;
  agentType: string;
  description: string;
  prompt: string;
  mode: AgentActivityMode;
  status: AgentActivityStatus;
  cwd?: string;
  model?: string;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  totalEvents: number;
  totalToolUseCount: number;
  totalTokens?: number;
  currentTool?: AgentToolActivity;
  timeline: AgentTimelineEntry[];
  lastText?: string;
  resultPreview?: string;
  error?: string;
}

export interface StartAgentActivityInput {
  agentId: string;
  taskId?: string;
  agentType: string;
  description: string;
  prompt: string;
  mode: AgentActivityMode;
  cwd?: string;
  model?: string;
}

const MAX_TIMELINE_ENTRIES = 80;
const PREVIEW_LIMIT = 260;

export class AgentActivityStore {
  private readonly activities = new Map<string, AgentActivity>();
  private readonly subscribers = new Set<() => void>();

  subscribe(listener: () => void): () => void {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  list(): AgentActivity[] {
    return [...this.activities.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  get(agentId: string): AgentActivity | undefined {
    return this.activities.get(agentId);
  }

  start(input: StartAgentActivityInput): AgentActivity {
    const now = new Date().toISOString();
    const existing = this.activities.get(input.agentId);
    const activity: AgentActivity = {
      activityId: existing?.activityId ?? `activity_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      agentId: input.agentId,
      taskId: input.taskId,
      agentType: input.agentType,
      description: input.description,
      prompt: input.prompt,
      mode: input.mode,
      status: "running",
      cwd: input.cwd,
      model: input.model,
      startedAt: existing?.startedAt ?? now,
      updatedAt: now,
      totalEvents: existing?.totalEvents ?? 0,
      totalToolUseCount: existing?.totalToolUseCount ?? 0,
      totalTokens: existing?.totalTokens,
      timeline: existing?.timeline ?? [],
      lastText: existing?.lastText,
      resultPreview: undefined,
      error: undefined,
    };
    this.activities.set(input.agentId, activity);
    this.push(activity, { kind: "status", title: "started", detail: input.description, status: "running" });
    this.notify();
    return activity;
  }

  recordEvent(agentId: string, event: AgentEvent): void {
    const activity = this.activities.get(agentId);
    if (!activity) return;
    activity.totalEvents += 1;
    activity.updatedAt = new Date().toISOString();

    if (event.type === "state") {
      this.push(activity, { kind: "status", title: event.phase, detail: event.detail, status: "running" }, false);
    } else if (event.type === "message") {
      this.recordMessageBlocks(activity, event.message);
    } else if (event.type === "tool.started") {
      this.recordToolStarted(activity, event.toolUse);
    } else if (event.type === "tool.finished") {
      this.recordToolFinished(activity, event.toolUse, event.ok);
    } else if (event.type === "usage") {
      this.recordUsage(activity, event.usage);
    } else if (event.type === "retrying") {
      this.push(activity, { kind: "status", title: `retrying #${event.attempt}`, detail: event.error.message, status: "running" });
    } else if (event.type === "terminal") {
      this.push(activity, { kind: "status", title: "terminal", detail: event.detail ?? event.reason, status: "ok" });
    } else if (event.type === "error") {
      activity.error = event.error.message;
      this.push(activity, { kind: "error", title: "error", detail: event.error.message, status: "failed" });
    }

    this.activities.set(agentId, activity);
    this.notify();
  }

  complete(agentId: string, result: AgentToolResult): void {
    const activity = this.activities.get(agentId);
    if (!activity) return;
    activity.status = "completed";
    activity.completedAt = new Date().toISOString();
    activity.updatedAt = activity.completedAt;
    activity.totalTokens = result.total_tokens ?? activity.totalTokens;
    activity.totalToolUseCount = result.total_tool_use_count || activity.totalToolUseCount;
    activity.resultPreview = previewText(result.content);
    activity.currentTool = undefined;
    this.push(activity, { kind: "status", title: "completed", detail: activity.resultPreview, status: "ok" });
    this.activities.set(agentId, activity);
    this.notify();
  }

  fail(agentId: string, error: string, status: AgentActivityStatus = "failed"): void {
    const activity = this.activities.get(agentId);
    if (!activity) return;
    activity.status = status;
    activity.error = error;
    activity.completedAt = new Date().toISOString();
    activity.updatedAt = activity.completedAt;
    activity.currentTool = undefined;
    this.push(activity, { kind: "error", title: status, detail: error, status: "failed" });
    this.activities.set(agentId, activity);
    this.notify();
  }

  private recordMessageBlocks(activity: AgentActivity, message: Message): void {
    for (const block of message.blocks) {
      if (block.type === "text") {
        const text = previewText(block.text);
        if (!text) continue;
        activity.lastText = text;
        const label = message.role === "assistant" ? "assistant" : message.role;
        this.push(activity, { kind: "text", title: label, detail: text, status: "running" });
      } else if (block.type === "thinking") {
        const text = previewText(block.text);
        if (!text) continue;
        activity.lastText = text;
        this.push(activity, { kind: "thinking", title: "thinking", detail: text, status: "running" });
      } else if (block.type === "tool_use") {
        // Some providers surface tool_use only as a message block. Avoid double-counting if tool.started already ran.
        if (activity.currentTool?.id !== block.id) this.recordToolStarted(activity, block);
      } else if (block.type === "tool_result") {
        this.push(activity, {
          kind: "tool_result",
          title: `${block.name} ${block.ok ? "ok" : "failed"}`,
          detail: summarizeToolResult(block),
          status: block.ok ? "ok" : "failed",
        });
      }
    }
  }

  private recordToolStarted(activity: AgentActivity, toolUse: ToolUseRequest): void {
    activity.totalToolUseCount += 1;
    activity.currentTool = {
      id: toolUse.id,
      name: toolUse.name,
      inputPreview: previewValue(toolUse.input),
      startedAt: new Date().toISOString(),
    };
    this.push(activity, {
      kind: "tool_start",
      title: toolUse.name,
      detail: activity.currentTool.inputPreview,
      status: "running",
    });
  }

  private recordToolFinished(activity: AgentActivity, toolUse: ToolUseRequest, ok: boolean): void {
    if (activity.currentTool?.id === toolUse.id) activity.currentTool = undefined;
    this.push(activity, {
      kind: "tool_result",
      title: `${toolUse.name} ${ok ? "finished" : "failed"}`,
      detail: previewValue(toolUse.input),
      status: ok ? "ok" : "failed",
    });
  }

  private recordUsage(activity: AgentActivity, usage: ModelUsage): void {
    activity.totalTokens = usage.totalTokens ?? activity.totalTokens;
  }

  private push(activity: AgentActivity, entry: Omit<AgentTimelineEntry, "id" | "at">, notify = true): void {
    const next: AgentTimelineEntry = {
      id: `entry_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      at: new Date().toISOString(),
      ...entry,
    };
    activity.timeline.push(next);
    if (activity.timeline.length > MAX_TIMELINE_ENTRIES) activity.timeline.splice(0, activity.timeline.length - MAX_TIMELINE_ENTRIES);
    activity.updatedAt = next.at;
    if (notify) this.notify();
  }

  private notify(): void {
    for (const subscriber of [...this.subscribers]) subscriber();
  }
}

export const globalAgentActivityStore = new AgentActivityStore();

function summarizeToolResult(block: Extract<MessageBlock, { type: "tool_result" }>): string {
  return previewValue(block.output);
}

function previewText(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, PREVIEW_LIMIT);
}

function previewValue(value: unknown): string {
  return previewText(formatPreviewValue(value));
}

function formatPreviewValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return String(value);
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const items = value.slice(0, 3).map(formatPreviewValue).filter(Boolean);
    return `[${items.join(", ")}${value.length > 3 ? `, +${value.length - 3} more` : ""}]`;
  }
  if (typeof value === "object") return formatObjectPreview(value as Record<string, unknown>);
  return String(value);
}

function formatObjectPreview(value: Record<string, unknown>): string {
  const preferredKeys = [
    "status",
    "description",
    "agent_type",
    "agent_id",
    "task_id",
    "name",
    "path",
    "query",
    "command",
    "cwd",
    "error",
    "content",
    "output",
    "total_tool_use_count",
  ];
  const keys = [...preferredKeys.filter((key) => key in value), ...Object.keys(value).filter((key) => !preferredKeys.includes(key))];
  const parts: string[] = [];
  for (const key of keys.slice(0, 6)) {
    const formatted = formatPreviewField(value[key]);
    if (!formatted) continue;
    parts.push(`${humanizePreviewKey(key)}=${formatted}`);
  }
  const extra = keys.length > 6 ? `, +${keys.length - 6} fields` : "";
  return parts.length ? parts.join(" · ") + extra : "{}";
}

function formatPreviewField(value: unknown): string {
  if (typeof value === "string") return quoteIfNeeded(value.replace(/\s+/g, " ").trim());
  if (value === null || value === undefined) return String(value);
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? "" : "s"}`;
  if (typeof value === "object") return `${Object.keys(value as Record<string, unknown>).length} fields`;
  return String(value);
}

function humanizePreviewKey(key: string): string {
  return key.replace(/_/g, "-");
}

function quoteIfNeeded(value: string): string {
  if (!value) return "\"\"";
  return /[\s,=]/.test(value) ? `"${value}"` : value;
}
