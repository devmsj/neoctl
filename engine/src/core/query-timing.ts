import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

/** Local observability only. Never attach these records to model messages or requests. */
export interface TimingRecord {
  version: 1;
  id: string;
  runId: string;
  kind: "query" | "tool";
  status: "queued" | "running" | "finished" | "interrupted";
  startedAt?: string;
  queuedAt?: string;
  finishedAt?: string;
  elapsedMs?: number;
  durationMs?: number;
  queueMs?: number;
  outcome?: string;
  toolUseId?: string;
  userMessageId?: string;
  firstOutputMs?: number;
}

/** Wall time is for dates; monotonic time is the sole duration authority. */
export interface TimingClock {
  wallNow(): number;
  monotonicNow(): number;
}
const systemClock: TimingClock = { wallNow: Date.now, monotonicNow: () => performance.now() };
const milliseconds = (value: number): number => Math.max(0, Math.floor(value));

export class QueryTimingState {
  private readonly started: number;
  private readonly record: TimingRecord;
  private readonly tools = new Map<string, { record: TimingRecord; queued: number; started?: number }>();
  private readonly currentTools = new Map<string, string>();
  private closed = false;

  constructor(private readonly clock: TimingClock = systemClock, userMessageId?: string) {
    this.started = clock.monotonicNow();
    const runId = randomUUID();
    this.record = { version: 1, id: runId, runId, kind: "query", status: "running",
      startedAt: new Date(clock.wallNow()).toISOString(), ...(userMessageId ? { userMessageId } : {}) };
  }

  snapshot(): TimingRecord {
    return this.closed ? { ...this.record } : { ...this.record, elapsedMs: milliseconds(this.clock.monotonicNow() - this.started) };
  }

  toolSnapshots(): TimingRecord[] {
    const now = this.clock.monotonicNow();
    return [...this.tools.values()].map(({ record, queued, started }) => record.status === "running"
      ? { ...record, elapsedMs: milliseconds(now - started!) }
      : record.status === "queued" ? { ...record, queueMs: milliseconds(now - queued) } : { ...record });
  }

  firstOutput(): void {
    if (!this.closed && this.record.firstOutputMs === undefined) {
      this.record.firstOutputMs = milliseconds(this.clock.monotonicNow() - this.started);
    }
  }

  queueTool(toolUseId: string): TimingRecord {
    const existing = this.tools.get(this.currentTools.get(toolUseId) ?? "");
    if (existing && (existing.record.status === "queued" || existing.record.status === "running")) return { ...existing.record };
    if (this.closed) throw new Error("Cannot queue tools on a finished query");
    const record: TimingRecord = { version: 1, id: randomUUID(), runId: this.record.runId,
      kind: "tool", toolUseId, status: "queued", queuedAt: new Date(this.clock.wallNow()).toISOString() };
    this.tools.set(record.id, { record, queued: this.clock.monotonicNow() });
    this.currentTools.set(toolUseId, record.id);
    return { ...record };
  }

  startTool(toolUseId: string): TimingRecord | undefined {
    const tool = this.tools.get(this.currentTools.get(toolUseId) ?? "");
    if (this.closed || !tool || tool.record.status !== "queued") return undefined;
    tool.started = this.clock.monotonicNow();
    Object.assign(tool.record, { status: "running", startedAt: new Date(this.clock.wallNow()).toISOString(),
      queueMs: milliseconds(tool.started - tool.queued) });
    return { ...tool.record, elapsedMs: 0 };
  }

  finishTool(toolUseId: string, ok: boolean): TimingRecord | undefined {
    const tool = this.tools.get(this.currentTools.get(toolUseId) ?? "");
    if (this.closed || !tool || tool.record.status !== "running") return undefined;
    Object.assign(tool.record, { status: "finished", outcome: ok ? "completed" : "failed",
      finishedAt: new Date(this.clock.wallNow()).toISOString(),
      durationMs: milliseconds(this.clock.monotonicNow() - tool.started!) });
    return { ...tool.record };
  }

  /** Idempotent, synchronous closure also works when a generator consumer stops early. */
  finish(outcome: string): TimingRecord[] {
    if (this.closed) return [];
    this.closed = true;
    const now = this.clock.monotonicNow();
    const finishedAt = new Date(this.clock.wallNow()).toISOString();
    const interrupted: TimingRecord[] = [];
    for (const tool of this.tools.values()) {
      if (tool.record.status !== "running" && tool.record.status !== "queued") continue;
      // Query cancellation does not prove an uncooperative tool/process actually stopped.
      // Preserve only an observed lower bound, never fabricate its final execution duration.
      Object.assign(tool.record, { status: "interrupted", outcome,
        ...(tool.started === undefined ? { queueMs: milliseconds(now - tool.queued) }
          : { elapsedMs: milliseconds(now - tool.started) }) });
      interrupted.push({ ...tool.record });
    }
    Object.assign(this.record, { status: "finished", outcome, finishedAt, durationMs: milliseconds(now - this.started) });
    return [...interrupted, { ...this.record }];
  }
}

/** Reject malformed observations; unknown legacy records must not become invented timings. */
export function isTimingRecord(value: unknown): value is TimingRecord {
  if (!value || typeof value !== "object") return false;
  const r = value as TimingRecord;
  if (r.version !== 1 || typeof r.id !== "string" || !r.id || typeof r.runId !== "string" || !r.runId
    || !["query", "tool"].includes(r.kind) || !["queued", "running", "finished", "interrupted"].includes(r.status)) return false;
  for (const key of ["elapsedMs", "durationMs", "queueMs", "firstOutputMs"] as const) {
    if (r[key] !== undefined && (!Number.isSafeInteger(r[key]) || r[key]! < 0)) return false;
  }
  for (const key of ["startedAt", "queuedAt", "finishedAt"] as const) {
    const date = r[key];
    if (date !== undefined && (typeof date !== "string" || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString() !== date)) return false;
  }
  for (const key of ["toolUseId", "userMessageId", "outcome"] as const) {
    if (r[key] !== undefined && typeof r[key] !== "string") return false;
  }
  if (r.kind === "tool" && !r.toolUseId) return false;
  if (r.kind === "query" && (r.id !== r.runId || !r.startedAt || r.status === "queued")) return false;
  if (r.status === "running" && !r.startedAt) return false;
  if (r.status === "queued" && !r.queuedAt) return false;
  if (r.status === "finished" && (!r.startedAt || !r.finishedAt || r.durationMs === undefined)) return false;
  return true;
}

export function restoredTiming(record: TimingRecord): TimingRecord {
  if (record.status !== "running" && record.status !== "queued") return { ...record };
  const { elapsedMs: _elapsed, durationMs: _duration, finishedAt: _finished, ...rest } = record;
  return { ...rest, status: "interrupted", outcome: "process_interrupted" };
}
