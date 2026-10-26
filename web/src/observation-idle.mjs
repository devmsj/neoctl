// Only real content updates restart the idle clock; identical snapshots do not.
export function createObservationIdle({ atBottom, onHidden, delay = 5000, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let timer, hidden = false, disposed = false
  function cancel() { if (timer !== undefined) clearTimer(timer); timer = undefined }
  function check() {
    if (disposed || hidden) return
    if (!atBottom()) { cancel(); return }
    if (timer !== undefined) return
    timer = setTimer(() => {
      timer = undefined
      if (!disposed && atBottom()) { hidden = true; onHidden(true) }
    }, delay)
  }
  function changed() {
    if (disposed) return
    cancel()
    if (hidden) { hidden = false; onHidden(false) }
    check()
  }
  return { check, changed, dispose() { disposed = true; cancel() } }
}
