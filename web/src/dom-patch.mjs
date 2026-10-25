// Preserve matching DOM nodes (including highlighted tokens and selection anchors).
export function patchChildren(target, source) {
  let old = target.firstChild
  for (const fresh of [...source.childNodes]) {
    if (!old) { target.append(fresh); continue }
    const next = old.nextSibling
    if (old.nodeType !== fresh.nodeType || old.nodeName !== fresh.nodeName) {
      old.replaceWith(fresh)
    } else if (old.nodeType === 3) {
      if (old.data !== fresh.data) old.data = fresh.data
    } else if (old.nodeType === 1) {
      for (const attr of [...old.attributes]) if (!fresh.hasAttribute(attr.name)) old.removeAttribute(attr.name)
      for (const attr of [...fresh.attributes]) if (old.getAttribute(attr.name) !== attr.value) old.setAttribute(attr.name, attr.value)
      patchChildren(old, fresh)
    }
    old = next
  }
  while (old) { const next = old.nextSibling; old.remove(); old = next }
}
