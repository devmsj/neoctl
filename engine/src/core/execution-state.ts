/** Durable outcome of the most recent user query (not inferred from answer text). */
export interface ExecutionState {
  status: "running" | "paused" | "interrupted" | "completed";
  reason?: string;
  /** Uncommitted compaction: history remains at the pre-compaction checkpoint. */
  resumeCompaction?: boolean;
  /** Active execution time across continuations, excluding paused intervals. */
  elapsedMs?: number;
}

export function isExecutionState(value: unknown): value is ExecutionState {
  if (!value || typeof value !== "object") return false;
  const state = value as ExecutionState;
  return ["running", "paused", "interrupted", "completed"].includes(state.status)
    && (state.resumeCompaction === undefined || typeof state.resumeCompaction === "boolean")
    && (state.reason === undefined || typeof state.reason === "string")
    && (state.elapsedMs === undefined || (Number.isSafeInteger(state.elapsedMs) && state.elapsedMs >= 0));
}

export function isResumableExecution(state?: ExecutionState): boolean {
  return state?.status === "paused" || state?.status === "interrupted";
}

export function executionRecoveryHint(state: ExecutionState): string {
  const cause = state.status === "paused"
    ? "The user paused the previous run."
    : `The previous run ended unexpectedly (${state.reason || "unknown"}); completion is unconfirmed.`;
  return `${cause}${state.resumeCompaction ? " Interrupted compaction was not committed; the original context was retained and recompacted before this request." : ""} This is a new request from saved context, not a replay. Tools may have completed, still be running, or partially executed despite missing results. Check actual state before repeating side effects. Follow the latest user message: apply new constraints, honor replacement or cancellation, and answer independent questions without resuming the old task. Clarify ambiguity before side effects. Resume the unfinished task only when asked to continue.`;
}
