export function executionSignal(status = {}, lines = [], runState = '', loading = false) {
  if (loading) return { mode: 'loading', tools: [] }
  if (['paused', 'interrupted', 'resuming'].includes(runState)) return { mode: 'paused', tools: [] }
  if (status.phase === 'compacting') return { mode: 'compacting', tools: [] }
  if (status.phase === 'calling_model' && !status.modelOutput) return { mode: 'waiting', tools: [] }
  let start = lines.length - 1
  while (start >= 0 && lines[start].kind !== 'user') start--
  const current = lines.slice(start + 1).flatMap(line => line.kind === 'tool-group' ? line.lines || [] : [line])
  const names = current.filter(line => line.toolName && (line.kind === 'tool' || line.activity)).map(line => line.toolName)
  if (status.currentTool?.name) names.unshift(status.currentTool.name)
  if (status.modelOutput?.kind === 'tool_call' && status.modelOutput.name) names.unshift(status.modelOutput.name)
  const tools = [...new Set(names)]
  return { mode: tools.length ? 'tools' : 'working', tools }
}

export function waitDotStyle(index, elapsedMs) {
  const order = [0, 1, 2, 5, 8, 7, 6, 3, 4]
  const rank = order.indexOf(index)
  const retained = Math.max(0, Math.min(1, (Math.max(0, elapsedMs) / 1000 - rank * 20) / 24))
  return { '--rest': .12 + .46 * retained, '--delay': `${-3.2 + rank * .15}s` }
}
