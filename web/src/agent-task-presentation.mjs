export const isTerminalAgentTask = (task) => ['completed', 'failed', 'killed'].includes(task?.status)

export function agentTaskResult(task) {
  if (!isTerminalAgentTask(task)) return ''
  const text = String(task?.result?.content ?? task?.error ?? '')
  return text + (task?.result?.truncated || task?.errorTruncated ? '\n…（预览已截断；可在报告阅读区加载指定轮次全文）' : '')
}

// Browser counterpart of the persisted per-run clock; never derives a run start from task creation.
export function agentRunElapsedMs(run, nowMs = Date.now()) {
  const start = typeof run?.startedAt === 'string' ? Date.parse(run.startedAt) : NaN
  if (!Number.isSafeInteger(start) || start < 0) return undefined
  if (run.status === 'running') {
    const value = nowMs - start
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined
  }
  if (!['completed', 'failed', 'killed'].includes(run.status)) return undefined
  const end = typeof run.completedAt === 'string' ? Date.parse(run.completedAt) : NaN
  return Number.isSafeInteger(end) && end >= start && Number.isSafeInteger(run.durationMs) && run.durationMs >= 0 && run.durationMs === end - start ? run.durationMs : undefined
}

export function agentTaskDelivery(task) {
  return {
    queued: Number.isFinite(task?.pendingMessageCount) ? task.pendingMessageCount : '未提供',
    delivered: Number.isFinite(task?.deliveredRetainedThisRun) ? task.deliveredRetainedThisRun : '未提供',
  }
}

export function agentTaskNeedsResume(task) {
  return isTerminalAgentTask(task) && Number(task?.pendingMessageCount) > 0
}

export function agentTaskArchives(task) {
  return (Array.isArray(task?.runHistory) ? task.runHistory : [])
    .filter((run) => Number(run.runGeneration) < Number(task?.runGeneration || 1))
    .slice(-8).reverse()
}

export function agentToolStatus(line) {
  if (!String(line?.toolName || '').startsWith('subagent_')) return undefined
  return callStatus(line)
}

// Call identity is local UI state; downstream facts are already labelled by the service.
export function callStatus(line) {
  if (line?.live) return { key: 'running', label: '执行中' }
  if (line?.titleStatus === 'failure' || line?.titleStatus === 'failed' || line?.kind === 'error' || !!line?.toolError) return { key: 'failed', label: '失败' }
  return line?.titleStatus === 'success' ? { key: 'completed', label: '完成' } : { key: 'unknown', label: '未提供' }
}
