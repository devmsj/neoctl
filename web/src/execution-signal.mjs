// The observation selector owns activity selection. Never independently cycle
// historical tools here: that can show a different icon than the visible preview.
export function executionSignal(status = {}, runState = '', loading = false, observed) {
  if (loading) return { mode: 'loading', tools: [] }
  if (['paused', 'interrupted', 'resuming'].includes(runState)) return { mode: 'paused', tools: [] }
  if (status.phase === 'compacting') return { mode: 'compacting', tools: [] }
  if (status.phase === 'calling_model' && !status.modelOutput) return { mode: 'waiting', tools: [] }
  const name = observed?.kind === 'thinking' ? 'thinking' : observed?.toolName
  // Without a preview, use only the current operation, never past turn tools.
  const current = name || (status.modelOutput?.kind === 'tool_call' && status.modelOutput.name) || status.currentTool?.name
  if (current) return { mode: 'tools', tools: [current] }
  if (status.modelOutput?.kind === 'thinking') return { mode: 'tools', tools: ['thinking'] }
  return { mode: 'working', tools: [] }
}

export function waitDotStyle(index, elapsedMs) {
  const order = [0, 1, 2, 5, 8, 7, 6, 3, 4]
  const rank = order.indexOf(index)
  const retained = Math.max(0, Math.min(1, (Math.max(0, elapsedMs) / 1000 - rank * 20) / 24))
  return { '--rest': .12 + .46 * retained, '--delay': `${-3.2 + rank * .15}s` }
}
