<script setup>
import { computed } from 'vue'
import { formatDuration } from '../core-timing.mjs'

const props = defineProps({ elapsedMs: { type: Number, default: undefined } })
const duration = computed(() => formatDuration(props.elapsedMs))
// Keep the angle unwrapped: 59s -> 60s is 354deg -> 360deg, never a reverse sweep.
const angle = computed(() => Math.floor(Math.max(0, props.elapsedMs || 0) / 1000) * 6)
</script>

<template>
  <span v-if="duration" class="elapsed-clock" :aria-label="`用时 ${duration}`">
    <svg class="elapsed-clock-face" viewBox="0 0 40 40" aria-hidden="true">
      <circle class="clock-rim" cx="20" cy="20" r="18" />
      <circle class="clock-well" cx="20" cy="20" r="15.5" />
      <g class="clock-ticks">
        <line v-for="tick in 60" :key="tick" x1="20" :y1="(tick - 1) % 5 === 0 ? 6 : 7" x2="20" y2="8"
          :class="{ major: (tick - 1) % 5 === 0 }" :transform="`rotate(${(tick - 1) * 6} 20 20)`" />
      </g>
      <g class="clock-hand" :style="{ transform: `rotate(${angle}deg)` }">
        <line x1="20" y1="23" x2="20" y2="10" />
      </g>
      <circle class="clock-pin" cx="20" cy="20" r="1.6" />
    </svg>
    <span class="elapsed-clock-value" aria-hidden="true">{{ duration }}</span>
  </span>
</template>

<style scoped>
.elapsed-clock {
  --clock-rim-edge: #9daab64d;
  --clock-well-edge: #bec9d57a;
  --clock-tick: #637384;
  --clock-major: #344556;
  --clock-hand: #be477e;
  --clock-pin: #d66a9a;
  --clock-pin-edge: #fff0f7;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  vertical-align: middle;
  color: inherit;
  background: transparent;
}
.elapsed-clock-face {
  width: 34px;
  height: 34px;
  flex: none;
  overflow: visible;
  background: transparent;
  box-shadow: none;
}
.clock-rim { fill: none; stroke: var(--clock-rim-edge); stroke-width: .7; }
.clock-well { fill: none; stroke: var(--clock-well-edge); stroke-width: 1; }
.clock-ticks line { stroke: var(--clock-tick); stroke-width: .55; opacity: .55; }
.clock-ticks .major { stroke: var(--clock-major); stroke-width: 1; opacity: .9; }
.clock-hand { transform-origin: 20px 20px; }
.clock-hand line { stroke: var(--clock-hand); stroke-width: 1.5; stroke-linecap: round; }
.clock-pin { fill: var(--clock-pin); stroke: var(--clock-pin-edge); stroke-width: .6; }
.elapsed-clock-value {
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  white-space: nowrap;
  opacity: .85;
}
/* Use the existing application theme, not a separate clock preference. */
:global(:root[data-theme='dark'] .elapsed-clock) {
  --clock-rim-edge: #aeb9c529;
  --clock-well-edge: #10182066;
  --clock-tick: #8996a4;
  --clock-major: #c6d2dd;
  --clock-hand: #e28ab7;
  --clock-pin: #f5d1e4;
  --clock-pin-edge: #342c36;
}
</style>
