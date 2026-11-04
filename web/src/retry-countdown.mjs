/** Never show a stale countdown after pause, disconnect, completion or expiry. */
export function retrySecondsRemaining(deadline, now, { connected = true, paused = false, busy = true } = {}) {
  if (!connected || paused || !busy || !Number.isFinite(deadline) || !Number.isFinite(now) || deadline <= now) return undefined
  return Math.min(60, Math.ceil((deadline - now) / 1000))
}
