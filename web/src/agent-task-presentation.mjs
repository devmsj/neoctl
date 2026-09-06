export const isTerminalAgentTask = (task) => ['completed', 'failed', 'killed'].includes(task?.status)

export function agentTaskResult(task) {
  if (!isTerminalAgentTask(task)) return ''
  const text = String(task?.result?.content || task?.error || '')
  return text + (task?.result?.truncated || task?.errorTruncated ? '\n…（预览已截断，完整结果请用 subagent_output；历史详情用 subagent_get detail=true）' : '')
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
    .slice(-3).reverse()
}

export function agentToolStatus(line) {
  if (!String(line?.toolName || '').startsWith('subagent_')) return undefined
  if (line?.live) return { key: 'running', label: '调用中' }
  if (line?.titleStatus === 'failure' || line?.kind === 'error') return { key: 'failed', label: '调用失败' }
  const status = (line?.toolDisplay?.facts || []).find((fact) => fact.label === '任务状态')?.value
  const labels = { pending: '排队中', running: '运行中', completed: '已完成', failed: '失败', killed: '已停止', queued: '已入队', queued_for_resume: '待续跑', resumed: '已启动续跑', incomplete: '未完成' }
  if (!labels[status]) return { key: 'unknown', label: '调用完成 / 状态未知' }
  return { key: ['failed', 'incomplete'].includes(status) ? 'failed' : ['running', 'pending', 'queued', 'queued_for_resume', 'resumed'].includes(status) ? 'running' : status === 'killed' ? 'stopped' : 'completed', label: labels[status] }
}
