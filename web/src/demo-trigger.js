// Gesture only; the server independently enforces session identity, emptiness and idle state.
export function createDemoTrigger({ threshold = 5, maxGapMs = 600 } = {}) {
  let count = 0
  let last = -Infinity
  let owner = ''
  return {
    reset() { count = 0; last = -Infinity; owner = '' },
    click(sessionId, eligible, now = performance.now()) {
      if (!eligible || !sessionId) { this.reset(); return false }
      if (owner !== sessionId || now - last > maxGapMs || now < last) count = 0
      owner = sessionId
      last = now
      count += 1
      if (count !== threshold) return false
      this.reset()
      return true
    },
  }
}
