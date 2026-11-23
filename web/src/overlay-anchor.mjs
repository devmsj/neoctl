// Floating overlays (menus, popovers) close on scroll only when that scroll
// actually moves their anchor. Sidebar, transcript and right panel scroll
// independently: transcript auto-follow while a run streams must not dismiss
// an overlay anchored in another column.
export function composedContains(container, node) {
  for (let current = node; current; current = current.parentNode || current.host) {
    if (current === container) return true
  }
  return false
}

export function scrollMovesAnchor(event, anchor) {
  if (!anchor?.isConnected) return true
  const source = event.target
  if (!source || source === document || source === document.documentElement || source === document.body) return true
  return composedContains(source, anchor)
}
