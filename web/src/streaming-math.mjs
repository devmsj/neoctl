import { mathHtml } from './math-markdown.mjs'
import { patchChildren } from './dom-patch.mjs'

// Only dirty equations are rendered, never the surrounding reply. Preserve the
// last valid preview while braces/commands are incomplete instead of flashing raw TeX.
export function createStreamingMath() {
  const equations = new Map()
  let timer, disposed = false
  function render(node, state, final = false) {
    state.dirty = false
    try {
      const template = node.ownerDocument.createElement('template')
      template.innerHTML = mathHtml(state.source, state.display)
      patchChildren(node, template.content)
      state.valid = true
      node.classList.remove('math-fallback')
    } catch {
      if (!state.valid || final) {
        node.textContent = state.source
        node.classList.add('math-fallback')
      }
    }
  }
  function schedule() {
    if (timer || disposed) return
    timer = setTimeout(() => {
      timer = undefined
      // Bound a single frame's work; continue remaining equations next tick.
      let count = 0
      for (const [node, state] of equations) {
        if (!state.dirty) continue
        render(node, state, state.closed)
        if (++count === 4) break
      }
      if ([...equations.values()].some(s => s.dirty)) schedule()
    }, 120)
  }
  return {
    track(node, display) {
      node.className = display ? 'math-expression math-display' : 'math-expression'
      if (display) { node.tabIndex = 0; node.setAttribute('role', 'region'); node.setAttribute('aria-label', '数学公式') }
      equations.set(node, { source: '', display, dirty: false, valid: false, closed: false })
    },
    has(node) { return equations.has(node) },
    append(node, text) {
      const state = equations.get(node)
      state.source += text; state.dirty = true
      if (!state.valid) node.textContent = state.source
      schedule()
    },
    close(node) {
      const state = equations.get(node)
      if (!state) return
      state.closed = true; state.dirty = true
      schedule()
    },
    dispose() { disposed = true; clearTimeout(timer); equations.clear() },
  }
}
