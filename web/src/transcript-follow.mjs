// Presentation-only scroll ownership. Never feeds back into session/model state.
export function createTranscriptFollow({
  getElement,
  requestFrame = (fn) => requestAnimationFrame(fn),
  cancelFrame = (id) => cancelAnimationFrame(id),
  now = () => performance.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
  reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
} = {}) {
  let following = true
  let frame = 0
  let timer = 0
  let lastFrame = 0
  let lastTop = 0
  let instant = true
  let disposed = false
  let held = false
  let restoreAfterTap = false
  let direction = 0
  let resumeAllowed = false
  let quietUntil = 0
  let detach = () => {}

  const bottom = (el) => Math.max(0, el.scrollHeight - el.clientHeight)
  function cancel() {
    if (frame) cancelFrame(frame)
    frame = 0
    lastFrame = 0
  }
  function pause() {
    restoreAfterTap = false
    following = false
    instant = false
    resumeAllowed = false
    direction = 0
    cancel()
    clearTimer(timer)
    timer = 0
  }
  function schedule() {
    if (disposed || !following || frame || !getElement()) return
    frame = requestFrame(tick)
  }
  function tick(time) {
    frame = 0
    const el = getElement()
    if (disposed || !following || !el || !el.clientHeight) return
    const target = bottom(el)
    const gap = target - el.scrollTop
    const dt = lastFrame ? Math.min(32, Math.max(1, time - lastFrame)) : 16
    lastFrame = time
    // Exponential approach, capped speed: no repeated native smooth-scroll jobs,
    // no overshoot, and a moving stream target does not restart an animation.
    const step = Math.min(gap * (1 - Math.exp(-dt / 115)), dt * 1.8)
    const next = instant || reducedMotion() || gap <= 1
      ? target : el.scrollTop + Math.max(1, step)
    instant = false
    el.scrollTop = next
    lastTop = el.scrollTop
    if (target - el.scrollTop > 1) schedule()
    else lastFrame = 0
  }
  function settle() {
    clearTimer(timer)
    timer = 0
    if (disposed || held || !resumeAllowed) return
    const delay = quietUntil - now()
    if (delay > 0) {
      timer = setTimer(settle, delay)
      return
    }
    const el = getElement()
    if (el && bottom(el) - el.scrollTop <= 48) {
      following = true
      resumeAllowed = false
      schedule()
    }
  }
  function input(delta) {
    pause()
    direction = Math.sign(delta)
    resumeAllowed = direction > 0
    quietUntil = now() + 180
    settle()
  }
  function onScroll() {
    const el = getElement()
    if (!el) return
    const delta = el.scrollTop - lastTop
    lastTop = el.scrollTop
    // Layout shrink / virtual remeasurement can also emit backward scroll events.
    // Only explicit user intent relinquishes follow ownership, not those events.
    if (!following && Math.abs(delta) > 0.5) {
      if (delta < 0) resumeAllowed = false
      else if (direction > 0 || (held && direction === 0)) resumeAllowed = true
      quietUntil = now() + 180
      settle()
    }
  }
  function reset() {
    pause()
    following = true
    instant = true
    direction = 0
    held = false
    lastTop = getElement()?.scrollTop || 0
    schedule()
  }
  function attach(el) {
    detach()
    cancel()
    lastTop = el?.scrollTop || 0
    if (!el) return
    let touchX, touchY
    let touchActive = false
    const wheel = (event) => { if (!event.ctrlKey && event.deltaY) input(event.deltaY) }
    const touchStart = (event) => {
      const wasFollowing = !touchActive && following
      touchActive = true
      held = true
      touchX = event.touches[0]?.clientX
      touchY = event.touches[0]?.clientY
      input(0)
      // Suspend while held, but a stationary single-finger tap is not scroll intent.
      restoreAfterTap = wasFollowing && event.touches.length === 1
    }
    const touchMove = (event) => {
      const x = event.touches[0]?.clientX
      const y = event.touches[0]?.clientY
      if (y !== undefined && touchY !== undefined && y !== touchY) input(touchY - y)
      if (event.touches.length !== 1 || x !== touchX) restoreAfterTap = false
      touchX = x
      touchY = y
    }
    const release = () => { held = false; quietUntil = now() + 180; settle() }
    const touchEnd = (event) => {
      if (event.type === 'touchcancel') restoreAfterTap = false
      if (event.touches?.length) return
      const restore = touchActive && restoreAfterTap
      touchActive = false
      restoreAfterTap = false
      release()
      if (restore && !disposed) {
        // Content may have grown beyond the reattach threshold during the tap.
        following = true
        resumeAllowed = false
        schedule()
      }
    }
    const pointerRelease = (event) => {
      // Browsers emit pointerup/cancel as well as touchend; touch owns its lifecycle.
      if (touchActive || event.pointerType === 'touch') return
      release()
    }
    const pointer = (event) => {
      // Scrollbar drag / middle-button autoscroll, not ordinary links or selection.
      const rect = el.getBoundingClientRect()
      if (event.button === 1 || (event.target === el && event.clientX >= rect.left + el.clientLeft + el.clientWidth)) {
        held = true
        input(0)
      }
    }
    const key = (event) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.target.closest('input, textarea, select, button, [contenteditable="true"]')) return
      if (['ArrowUp', 'PageUp', 'Home'].includes(event.key) || (event.key === ' ' && event.shiftKey)) input(-1)
      else if (['ArrowDown', 'PageDown', 'End', ' '].includes(event.key)) input(1)
    }
    const listeners = [['scroll', onScroll], ['wheel', wheel], ['touchstart', touchStart], ['touchmove', touchMove], ['touchend', touchEnd], ['touchcancel', touchEnd], ['pointerdown', pointer], ['keydown', key]]
    for (const [name, fn] of listeners) el.addEventListener(name, fn, { passive: true })
    const doc = el.ownerDocument
    doc.addEventListener('pointerup', pointerRelease, { passive: true })
    doc.addEventListener('pointercancel', pointerRelease, { passive: true })
    detach = () => {
      touchActive = false
      restoreAfterTap = false
      held = false
      for (const [name, fn] of listeners) el.removeEventListener(name, fn)
      doc.removeEventListener('pointerup', pointerRelease)
      doc.removeEventListener('pointercancel', pointerRelease)
      detach = () => {}
    }
    schedule()
  }
  return {
    schedule, pause, reset, attach,
    get following() { return following },
    get interacting() { return held || now() < quietUntil },
    dispose() { disposed = true; pause(); detach() },
  }
}
