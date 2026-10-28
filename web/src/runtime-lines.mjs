import { markRaw, shallowReactive } from 'vue'

// The array owns membership/order; each row owns its fields. Streaming a field
// must not invalidate every consumer of the array or proxy large tool results.
export function createRuntimeLines() {
  const lines = shallowReactive([])
  const byId = new Map()
  const key = id => String(id)
  function append(value) {
    if (!value || byId.has(key(value.id))) return false
    const row = shallowReactive({ ...value })
    byId.set(key(row.id), row)
    lines.push(row)
    return true
  }
  function patch(id, fields) {
    const row = byId.get(key(id))
    if (!row) return false
    Object.assign(row, fields)
    return true
  }
  function replace(values) {
    const next = [], ids = new Set()
    for (const value of values) {
      const id = key(value.id)
      if (ids.has(id)) continue
      ids.add(id)
      let row = byId.get(id)
      if (row) {
        for (const field of Object.keys(row)) if (!(field in value)) delete row[field]
        Object.assign(row, value)
      } else row = shallowReactive({ ...value })
      next.push(row)
    }
    byId.clear()
    for (const row of next) byId.set(key(row.id), row)
    if (next.length !== lines.length || next.some((row, index) => row !== lines[index])) lines.splice(0, lines.length, ...next)
  }
  // Preserve explicit shallow reactivity when embedded in the application's
  // reactive state. markRaw does not turn the shallow row/array proxies off.
  return { lines: markRaw(lines), get: id => byId.get(key(id)), append, patch, replace }
}

// Preserve the original first-match order, including reused IDs/generations.
export function indexRuntimeTasks(tasks) {
  const terminal = new Map(), agent = new Map()
  for (const task of tasks) {
    if (task.kind === 'terminal') for (const id of new Set([task.sessionId, task.runId])) {
      if (!terminal.has(id)) terminal.set(id, [])
      terminal.get(id).push(task)
    }
    if (!agent.has(task.taskId)) agent.set(task.taskId, [])
    agent.get(task.taskId).push(task)
  }
  return { forLine(line) {
    const p = line?.activity?.input || {}, r = line?.observation || {}
    if (['terminal_run', 'terminal_control'].includes(line?.toolName)) return terminal.get(r.session_id || p.session_id) || []
    if (line?.toolName?.startsWith('subagent_')) return agent.get(r.task_id || r.taskId || p.task_id) || []
    return []
  } }
}
