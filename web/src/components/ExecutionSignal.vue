<script setup>
import { computed, ref, watch, onMounted, onUnmounted } from 'vue'
import ToolActivityIcon from './ToolActivityIcon.vue'
import { waitDotStyle } from '../execution-signal.mjs'
const props = defineProps({ mode: String, tools: { type: Array, default: () => [] }, waitStartedAt: Number, sessionKey: String, paused: Boolean, label: String })
const tick = ref(Date.now()), entered = ref(Date.now()), index = ref(0)
watch(() => [props.mode, props.sessionKey, props.waitStartedAt], () => { entered.value = Date.now(); index.value = 0 })
const elapsed = computed(() => Math.max(0, tick.value - (props.waitStartedAt || entered.value)))
const age = computed(() => Math.min(100, Math.log1p(elapsed.value / 16000) / Math.log1p(180 / 16) * 100))
const tool = computed(() => props.tools[index.value % Math.max(1, props.tools.length)])
let timer, rotation
onMounted(() => {
  timer = setInterval(() => { if (!props.paused) tick.value = Date.now() }, 1000)
  rotation = setInterval(() => { if (!props.paused && props.mode === 'tools') index.value++ }, 2400)
})
onUnmounted(() => { clearInterval(timer); clearInterval(rotation) })
</script>
<template>
  <span class="execution-signal" :class="{ 'is-paused': paused }" :data-mode="mode" role="img" :aria-label="label" :title="label">
    <svg v-if="mode === 'waiting' || mode === 'loading'" class="signal-matrix" viewBox="0 0 28 28" aria-hidden="true" :style="{ '--age': `${mode === 'waiting' ? age : 0}%` }">
      <circle v-for="i in 9" :key="i" :cx="7 + ((i - 1) % 3) * 7" :cy="7 + Math.floor((i - 1) / 3) * 7" r="1.4" :style="waitDotStyle(i - 1, mode === 'waiting' ? elapsed : 0)" />
    </svg>
    <ToolActivityIcon v-else-if="mode === 'tools' && tool" :key="tool" class="signal-tool" :name="tool" phase="completed" />
    <svg v-else-if="mode === 'paused'" class="signal-symbol" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6v12M15 6v12" /></svg>
    <svg v-else class="signal-symbol signal-working" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M5 12h10M5 17h6" /></svg>
  </span>
</template>
<style scoped>
.execution-signal{--wait-cold:#788095;--wait-warm:#9a7f66;display:inline-grid;place-items:center;width:28px;height:28px;flex:0 0 28px;color:var(--chrome-accent,#b5adbf)}
:global(:root[data-theme='dark'] .execution-signal){--wait-cold:#a2a9bf;--wait-warm:#c1ae9a}
.signal-matrix{width:28px;height:28px;color:color-mix(in srgb,var(--wait-warm) var(--age,0%),var(--wait-cold))}
.signal-matrix circle{fill:currentColor;stroke:none;animation:signal-glint 3.2s ease-in-out infinite;animation-delay:var(--delay);opacity:var(--rest,.12)}
.execution-signal :deep(.signal-tool){width:18px;height:18px;color:inherit;animation:signal-breathe 1.7s ease-in-out infinite}
.signal-symbol{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.4;stroke-linecap:round;stroke-linejoin:round}
.signal-working{animation:signal-breathe 1.7s ease-in-out infinite}
.is-paused *{animation-play-state:paused!important}
@keyframes signal-glint{0%,18%,100%{opacity:var(--rest,.12)}40%{opacity:.95}66%{opacity:var(--rest,.12)}}
@keyframes signal-breathe{0%,100%{opacity:.4}50%{opacity:1}}
@media(prefers-reduced-motion:reduce){.execution-signal *{animation:none!important}}
</style>
