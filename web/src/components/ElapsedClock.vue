<script setup>
import { computed } from 'vue'
import { formatDuration } from '../core-timing.mjs'

const props = defineProps({ elapsedMs: { type: Number, default: undefined }, showZero: Boolean, completed: Boolean })
const duration = computed(() => formatDuration(props.elapsedMs) || (props.showZero && Number.isFinite(props.elapsedMs) ? '0s' : ''))
// Keep the angle unwrapped: 59s -> 60s is 354deg -> 360deg, never a reverse sweep.
const angle = computed(() => Math.floor(Math.max(0, props.elapsedMs || 0) / 1000) * 6)
</script>

<template>
  <span v-if="duration" class="elapsed-clock" :class="{ 'is-completed': completed }" :aria-label="`用时 ${duration}`">
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
  --clock-accent: var(--appearance-accent, var(--chrome-accent, #8c456e));
  --clock-neutral: var(--chrome-muted, #737983);
  --clock-rim-edge: color-mix(in srgb, var(--clock-neutral) 30%, transparent);
  --clock-well-edge: color-mix(in srgb, var(--clock-neutral) 45%, transparent);
  --clock-tick: var(--clock-neutral);
  --clock-major: var(--clock-neutral);
  --clock-hand: var(--clock-accent);
  --clock-pin: var(--clock-accent);
  --clock-pin-edge: var(--chrome-bg, var(--bg));
  display: inline-flex;
  align-items: center;
  gap: 2px;
  vertical-align: middle;
  color: var(--clock-neutral);
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
  font-family: var(--appearance-code-font, ui-monospace, SFMono-Regular, Consolas, monospace);
  white-space: nowrap;
  opacity: .85;
}
/* Only the face and duration signal success; the hand retains the chosen accent. */
.elapsed-clock.is-completed { --clock-complete: #20b76a; }
:global(:root[data-theme='dark'] .elapsed-clock.is-completed) { --clock-complete: #4ddd8b; }
.elapsed-clock.is-completed .clock-rim,
.elapsed-clock.is-completed .clock-well,
.elapsed-clock.is-completed .clock-ticks line { stroke: var(--clock-complete); }
.elapsed-clock.is-completed .elapsed-clock-value { color: var(--clock-complete); opacity: 1; }
</style>
