<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
const props = defineProps({ connections: { type: Map, required: true }, host: Object })
const paths = ref([])
let frame = 0, observer
// One overlay owns each trunk and junction. Read current DOM geometry, not cached
// virtual-row estimates, so expanding/animated observations cannot split the line.
function measure() {
  const host = props.host
  if (!host || !props.connections.size) { paths.value = []; return }
  const bounds = host.getBoundingClientRect(), groups = new Map()
  for (const row of host.querySelectorAll(':scope > .virtual-message-row')) {
    const connection = props.connections.get(String(row.dataset.lineId))
      || props.connections.get(Number(row.dataset.lineId))
    if (!connection?.branch) continue
    const icon = row.querySelector('.tool-activity-row > .activity-icon')
    if (!icon) continue
    const rect = icon.getBoundingClientRect()
    const point = { x: rect.left - bounds.left - 3, y: rect.top - bounds.top + rect.height / 2 }
    const key = connection.groupKey
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(point)
  }
  const next = [...groups].flatMap(([key, points]) => {
    if (points.length < 2) return []
    points.sort((a, b) => a.y - b.y)
    const x = 3, first = points[0], last = points.at(-1)
    // Vertical trunk occurs exactly once; each horizontal branch occurs once.
    const d = [`M${x} ${first.y}V${last.y}`, ...points.map(p => `M${x} ${p.y}H${p.x}`)].join(' ')
    return [{ key, d }]
  })
  if (JSON.stringify(next) !== JSON.stringify(paths.value)) paths.value = next
}
function tick() { measure(); if (props.connections.size) frame = requestAnimationFrame(tick) }
watch(() => [props.host, props.connections], () => {
  cancelAnimationFrame(frame); observer?.disconnect()
  if (props.host) { observer = new ResizeObserver(measure); observer.observe(props.host) }
  measure()
  if (props.connections.size) frame = requestAnimationFrame(tick)
}, { flush: 'post', immediate: true })
onBeforeUnmount(() => { cancelAnimationFrame(frame); observer?.disconnect() })
const height = computed(() => Math.max(1, props.host?.scrollHeight || 1))
</script>
<template>
  <svg class="tool-turn-overlay" :height="height" aria-hidden="true">
    <path v-for="path in paths" :key="path.key" class="tool-turn-route" :d="path.d" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="butt" stroke-linejoin="miter" />
  </svg>
</template>
<style>
.tool-turn-overlay{position:absolute;inset:0 auto auto 0;width:100%;height:100%;overflow:visible;pointer-events:none;color:var(--history-icon,var(--purple));z-index:1}
.tool-turn-route{opacity:.52;animation:tool-turn-extend .48s cubic-bezier(.2,.7,.2,1) both;transform-box:fill-box;transform-origin:top left}
@keyframes tool-turn-extend{from{clip-path:inset(0 0 100% 0);opacity:0}to{clip-path:inset(0);opacity:.52}}
@media(prefers-reduced-motion:reduce){.tool-turn-route{animation:none}}
</style>
