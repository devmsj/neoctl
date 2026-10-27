import { computed } from 'vue'

const EMPTY = Object.freeze([])

// Index metadata once per transcript change, not once per rendered row. Keep
// reactive line references: edits to images/files/text must still update the UI.
export function createTranscriptLookup(getLines) {
  const groups = computed(() => {
    const users = new Map(), toolImages = new Map()
    for (const line of getLines() || []) {
      if (line?.kind === 'user') {
        const id = String(line.messageId || '')
        if (id) {
          if (!users.has(id)) users.set(id, [])
          users.get(id).push(line)
        }
      }
      if (line?.image) {
        const id = line.parentToolUseId
        if (!toolImages.has(id)) toolImages.set(id, [])
        toolImages.get(id).push(line)
      }
    }
    return { users, toolImages }
  })

  const resourceIndex = computed(() => {
    const offsets = new Map(), resources = [], seen = new Set()
    for (const line of getLines() || []) {
      const id = String(line?.id)
      // Match the original findIndex semantics if a malformed snapshot repeats an id.
      if (!offsets.has(id)) offsets.set(id, resources.length)
      if (line?.live || !Array.isArray(line?.resources)) continue
      for (const resource of line.resources) {
        if (!resource || typeof resource !== 'object' || typeof resource.url !== 'string' || !resource.url || seen.has(resource.url)) continue
        seen.add(resource.url)
        resources.push(resource)
      }
    }
    return { offsets, resources, prefixes: new Map([[0, EMPTY]]) }
  })

  return {
    userGroup(line) {
      if (line?.kind !== 'user' || !String(line.messageId || '')) return [line]
      return groups.value.users.get(String(line.messageId)) || EMPTY
    },
    toolImages(line) {
      return groups.value.toolImages.get(line?.toolUseId) || EMPTY
    },
    resourcesBefore(line) {
      if (line?.kind !== 'assistant') return EMPTY
      const { offsets, resources, prefixes } = resourceIndex.value
      const end = offsets.get(String(line.id)) ?? resources.length
      if (!prefixes.has(end)) prefixes.set(end, resources.slice(0, end))
      return prefixes.get(end)
    },
  }
}
