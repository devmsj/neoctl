<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'

const props = defineProps({ text: { type: String, default: '' } })
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const characters = text => Array.from(segmenter.segment(text), part => part.segment)
const current = ref(props.text)
const previous = ref('')
const flipping = ref(false)
const revision = ref(0)
let settleTimer
const slots = computed(() => {
  const next = characters(current.value)
  const old = flipping.value ? characters(previous.value) : []
  return Array.from({ length: Math.max(next.length, old.length) }, (_, index) => ({
    before: old[index] || '', after: next[index] || '',
  }))
})
// A short domino delay, capped so long tool names do not take seconds to settle.
const stagger = computed(() => Math.min(45, 600 / Math.max(1, slots.value.length - 1)))
watch(() => props.text, (text, oldText) => {
  clearTimeout(settleTimer)
  previous.value = oldText
  current.value = text
  flipping.value = true
  revision.value += 1
  settleTimer = setTimeout(() => {
    flipping.value = false
    previous.value = ''
  }, 360 + Math.max(0, slots.value.length - 1) * stagger.value)
})
onBeforeUnmount(() => clearTimeout(settleTimer))
</script>

<template>
  <span class="flip-status-text" :aria-label="text">
    <span :key="revision" class="flip-status-letters" aria-hidden="true">
      <span v-for="(slot, index) in slots" :key="index" class="flip-status-slot">
        <span :class="['flip-status-card', { 'is-flipping': flipping }]" :style="{ '--flip-delay': `${index * stagger}ms` }">
          <span v-if="flipping" class="flip-status-front">{{ slot.before }}</span>
          <span class="flip-status-back">{{ slot.after }}</span>
        </span>
      </span>
    </span>
  </span>
</template>

<style scoped>
/* Keep the whole label on one stable line/compositing surface during scroll.
   Per-letter perspective changes projected glyph height at different angles,
   making staggered cards look vertically displaced. Orthographic Y rotation
   keeps the card-flip silhouette without that vertical perspective distortion. */
.flip-status-text {
  display: inline-flex;
  align-items: center;
  color: inherit;
  line-height: 1.5;
  vertical-align: middle;
  transform: translateZ(0);
  isolation: isolate;
}
.flip-status-letters { display: inline-flex; align-items: stretch; flex-wrap: nowrap; }
.flip-status-slot { display: flex; flex: none; height: 1.5em; }
.flip-status-card {
  display: grid;
  height: 100%;
  line-height: inherit;
  transform-style: preserve-3d;
  transform-origin: 50% 50%;
}
.flip-status-front, .flip-status-back {
  grid-area: 1 / 1;
  white-space: pre;
  backface-visibility: hidden;
  -webkit-backface-visibility: hidden;
}
.is-flipping { animation: status-card-turn 360ms cubic-bezier(.4, 0, .2, 1) var(--flip-delay) both; }
.is-flipping .flip-status-back { transform: rotateY(180deg); }
@keyframes status-card-turn {
  from { transform: rotateY(0deg); }
  to { transform: rotateY(-180deg); }
}
@media (prefers-reduced-motion: reduce) {
  .is-flipping { animation: none; }
  .is-flipping .flip-status-front { display: none; }
  .is-flipping .flip-status-back { transform: none; }
}
</style>
