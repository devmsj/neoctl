<script setup>
import { onBeforeUnmount, ref, watch } from 'vue'

const props = defineProps({ text: { type: String, default: '' } })
const revision = ref(0)
const scattering = ref(false)
let settleTimer
// Fixed, bounded particle budget. No per-frame JS, random layout or text splitting.
const particles = Array.from({ length: 28 }, (_, index) => ({
  '--dust-x': `${3 + (index * 37 % 94)}%`,
  '--dust-y': `${30 + (index * 17 % 35)}%`,
  '--dust-dx': `${(index * 13 % 23) - 11}px`,
  '--dust-dy': `${index % 3 === 0 ? 7 : -7 - index % 7}px`,
  '--dust-size': `${1 + index % 3 * 0.5}px`,
  '--dust-delay': `${index * 19 % 150}ms`,
  '--dust-color': `var(--dust-${index % 3})`,
}))
watch(() => props.text, () => {
  clearTimeout(settleTimer)
  revision.value++
  scattering.value = true
  settleTimer = setTimeout(() => { scattering.value = false }, 750)
})
onBeforeUnmount(() => clearTimeout(settleTimer))
</script>

<template>
  <span class="dust-status-text" :aria-label="text">
    <span class="dust-status-label" aria-hidden="true">{{ text }}</span>
    <span v-if="scattering" :key="revision" class="dust-status-particles" aria-hidden="true">
      <i v-for="(style, index) in particles" :key="index" class="dust-status-particle" :style="style" />
    </span>
  </span>
</template>

<style scoped>
.dust-status-text {
  --dust-0: #c8498a;
  --dust-1: #1689b0;
  --dust-2: #899e30;
  display: inline-flex;
  position: relative;
  align-items: center;
  color: inherit;
  line-height: 1.5;
  vertical-align: middle;
  isolation: isolate;
}
.dust-status-label { white-space: pre; }
/* Confine all motion to a non-interactive paint layer: no scroll overflow,
   no moving glyph baselines and no hit target covering the adjacent clock. */
.dust-status-particles {
  position: absolute;
  inset: 0;
  overflow: hidden;
  contain: strict;
  pointer-events: none;
  user-select: none;
}
.dust-status-particle {
  position: absolute;
  left: var(--dust-x);
  top: var(--dust-y);
  width: var(--dust-size);
  height: var(--dust-size);
  background: var(--dust-color);
  clip-path: circle(50%);
  opacity: 0;
  animation: status-dust-scatter 580ms ease-out var(--dust-delay) both;
}
@keyframes status-dust-scatter {
  0% { opacity: 0; transform: translate(0, 2px) scale(.4); }
  16% { opacity: .85; }
  100% { opacity: 0; transform: translate(var(--dust-dx), var(--dust-dy)) scale(.15); }
}
:global(:root[data-theme='dark'] .dust-status-text) {
  --dust-0: #f2a8cf;
  --dust-1: #78c9e8;
  --dust-2: #bedc79;
}
@media (prefers-reduced-motion: reduce) {
  .dust-status-particles { display: none; }
  .dust-status-particle { animation: none; }
}
</style>
