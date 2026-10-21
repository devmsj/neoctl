// Display completed whole seconds without changing the underlying millisecond facts.
export function formatDuration(ms) {
  const value = Number(ms)
  const totalSeconds = Number.isFinite(value) ? Math.floor(Math.max(0, value) / 1000) : 0
  if (totalSeconds === 0) return ''
  if (totalSeconds < 60) return `${totalSeconds}s`
  return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`
}

// Presentation interpolation only. Starts and final durations always come from core.
export function receiveTimings(records, now = performance.now()) {
  return (records || []).filter(record => record?.version === 1 && typeof record.id === 'string')
    .map(record => ({ ...record, receivedAt: now }))
}

export function timingElapsedMs(record, now = performance.now(), connected = true) {
  if (!record) return undefined
  const valid = value => Number.isSafeInteger(value) && value >= 0
  if (record.status === 'finished') return valid(record.durationMs) ? record.durationMs : undefined
  if (record.status !== 'running' || !valid(record.elapsedMs)) return undefined
  return record.elapsedMs + (connected && Number.isFinite(record.receivedAt) ? Math.max(0, now - record.receivedAt) : 0)
}

// This is the task clock, distinct from individual query/tool timing records.
export function executionElapsedMs(control, now = performance.now(), connected = true) {
  const timer = control?.timer
  if (!timer || !Number.isSafeInteger(timer.elapsedMs) || timer.elapsedMs < 0) return undefined
  const advancing = timer.running && !['paused', 'interrupted', 'resuming'].includes(control.state)
  return timer.elapsedMs + (advancing && connected && Number.isFinite(control.receivedAt)
    ? Math.max(0, now - control.receivedAt) : 0)
}
