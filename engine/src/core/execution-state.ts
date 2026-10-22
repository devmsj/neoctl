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
    ? "上一轮会话被用户主动暂停/打断。"
    : `上一轮会话意外终止，未确认完成（原因：${state.reason || "unknown"}）。`;
  return `${cause}${state.resumeCompaction ? "上次上下文压缩被打断，未提交其摘要；运行时已保留压缩前上下文，并在本次模型调用前重新压缩。" : ""}这次是基于已保存上下文的新一轮续接，不是从底层请求断点重放。部分命令、工具或外部请求可能已执行、仍在运行或只完成了一部分，未收到结果不代表未执行。请先核实文件、进程和外部操作的实际状态，避免重复执行有副作用的操作。以用户本次新消息为最新指令：补充或调整则按新约束续做；替换或取消则不再执行旧目标；独立问题先回答，不擅自恢复旧任务；有歧义且涉及副作用时先澄清。用户仅要求继续时，继续尚未完成的原任务。`;
}
