import { isActivityLine } from './tool-activity.mjs'
import { onBeforeUnmount, ref, watch } from 'vue'

export const TOOL_CONNECTION_DURATION = 2000

// Source flags only describe membership. Replies, tool completion and new
// model calls do not control the frontend animation's lifetime.
export function toolConnectionGroups(lines = []) {
  const groups = []
  let members = []
  const finish = () => {
    if (members.length < 2) return
    const first = members[0], last = members.at(-1), branches = new Set(members)
    const connections = new Map()
    for (let i = first; i <= last; i++) connections.set(lines[i].id, {
      groupKey: lines[first].id, first: i === first, last: i === last, branch: branches.has(i), moving: true,
    })
    groups.push({ key: lines[first].id, connections })
  }
  for (let i = 0; i < lines.length; i++) {
    if (!isActivityLine(lines[i])) continue
    if (!lines[i].connectPreviousTool) { finish(); members = [] }
    members.push(i)
  }
  finish()
  return groups
}

export function createToolConnectionPlayback(publish, schedule = setTimeout, cancel = clearTimeout) {
  const seen = new Set(), active = new Map(), timers = new Map()
  const emit = () => publish(new Map([...active.values()].flatMap(group => [...group])))
  return {
    update(groups, baseline = false) {
      for (const group of groups) {
        if (!seen.has(group.key)) {
          seen.add(group.key)
          if (baseline) continue
          active.set(group.key, group.connections)
          timers.set(group.key, schedule(() => {
            active.delete(group.key); timers.delete(group.key); emit()
          }, TOOL_CONNECTION_DURATION))
        } else if (active.has(group.key)) active.set(group.key, group.connections)
      }
      emit()
    },
    reset() {
      for (const timer of timers.values()) cancel(timer)
      timers.clear(); seen.clear(); active.clear(); emit()
    },
  }
}

export function useToolConnections(lines, session) {
  const connections = ref(new Map())
  const playback = createToolConnectionPlayback(value => { connections.value = value })
  let initialized = false, owner
  watch(() => [session(), toolConnectionGroups(lines.value)], ([nextOwner, groups]) => {
    if (!initialized || owner !== nextOwner) {
      playback.reset(); owner = nextOwner; initialized = true
      playback.update(groups, true)
    } else playback.update(groups)
  }, { immediate: true })
  onBeforeUnmount(() => playback.reset())
  return connections
}
