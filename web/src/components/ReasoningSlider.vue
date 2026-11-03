<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'
const props = defineProps({
  modelValue: { type: String, default: '' },
  options: { type: Array, default: () => [] },
  disabled: Boolean,
  emptyLabel: { type: String, default: '未配置档位' },
})
const emit = defineEmits(['update:modelValue'])
const id = useId().replace(/[^a-zA-Z0-9_-]/g, '')
const dragging = ref(false), preview = ref(null), direction = ref(1)
const deformation = ref(0), reducedMotion = ref(false), hidden = ref(false)
const flowTrack = ref(null), sheen = ref(null)
let frame = 0, lastFrame = 0, springVelocity = 0, lastInput = 0, motionQuery
let flowEnergy = 0, flowRate = 1
function setFlowRate(rate) {
  // Playback rate preserves animation phase; changing duration would make light jump.
  for (const element of [flowTrack.value, sheen.value]) {
    for (const animation of element?.getAnimations() ?? []) animation.updatePlaybackRate(rate)
  }
}
// Interaction updates speed briefly; idle flow stays in browser-managed animation.
function stopMotion() {
  cancelAnimationFrame(frame); frame = 0; lastFrame = 0
  springVelocity = 0; deformation.value = 0
  flowEnergy = 0; flowRate = 1; setFlowRate(1)
}
function settle(now) {
  const dt = Math.min((now - lastFrame) / 1000 || 1 / 60, 1 / 30)
  lastFrame = now
  springVelocity += (-160 * deformation.value - 17 * springVelocity) * dt
  deformation.value = Math.max(-1, Math.min(1, deformation.value + springVelocity * dt))
  flowEnergy *= Math.exp(-dt * 3.2)
  const targetRate = 1 + flowEnergy * 9
  flowRate += (targetRate - flowRate) * (1 - Math.exp(-dt * 14))
  setFlowRate(flowRate)
  if (Math.abs(deformation.value) < .001 && Math.abs(springVelocity) < .01) {
    deformation.value = 0; springVelocity = 0
    if (flowEnergy < .001 && Math.abs(flowRate - 1) < .02) { stopMotion(); return }
  }
  frame = requestAnimationFrame(settle)
}
function impulse(delta, elapsed = 80) {
  if (!delta || reducedMotion.value || hidden.value || props.disabled) return
  direction.value = Math.sign(delta)
  const speed = Math.min(1, Math.abs(delta) / Math.max(1, props.options.length - 1) * 160 / Math.max(16, elapsed))
  flowEnergy = Math.max(flowEnergy, speed)
  deformation.value = direction.value * Math.min(.85, .12 + speed * .85)
  springVelocity = direction.value * speed * 2
  if (!frame) { lastFrame = performance.now(); frame = requestAnimationFrame(settle) }
}
function begin() { if (!locked.value) { dragging.value = true; lastInput = performance.now() } }
function motionPreference() { reducedMotion.value = motionQuery.matches; if (reducedMotion.value) stopMotion() }
function visibility() { hidden.value = document.hidden; if (hidden.value) { release(); stopMotion() } }
onMounted(() => {
  motionQuery = matchMedia('(prefers-reduced-motion: reduce)')
  motionPreference(); visibility()
  motionQuery.addEventListener('change', motionPreference)
  document.addEventListener('visibilitychange', visibility)
  nextTick(() => setFlowRate(flowRate))
})
onBeforeUnmount(() => {
  stopMotion()
  motionQuery?.removeEventListener('change', motionPreference)
  document.removeEventListener('visibilitychange', visibility)
})
const index = computed(() => props.options.indexOf(props.modelValue))
const valid = computed(() => index.value >= 0)
const locked = computed(() => props.disabled || props.options.length < 2)
const position = computed(() => preview.value ?? Math.max(0, index.value))
const style = computed(() => ({
  '--effort-position': `${(position.value + .5) / Math.max(1, props.options.length) * 100}%`,
  '--effort-count': Math.max(1, props.options.length),
  '--effort-direction': direction.value,
  '--effort-stretch': 1 + Math.abs(deformation.value) * .19,
  '--effort-compress': 1 - Math.abs(deformation.value) * .13,
  '--effort-shear': `${deformation.value * -7}deg`,
  '--effort-flow-offset': `${deformation.value * 18}px`,
  '--effort-glint': `${50 - deformation.value * 23}%`,
}))
function select(i) {
  if (props.disabled || !props.options.length) return
  const next = Math.max(0, Math.min(props.options.length - 1, Math.round(Number(i))))
  if (!Number.isFinite(next)) return
  if (next !== index.value && !dragging.value) impulse(next - Math.max(0, index.value))
  if (props.options[next] !== props.modelValue) emit('update:modelValue', props.options[next])
}
function input(event) {
  if (locked.value) return
  const value = Number(event.target.value)
  if (dragging.value) {
    const now = performance.now()
    impulse(value - position.value, now - lastInput)
    lastInput = now; preview.value = value
  }
  select(value)
}
function release() { dragging.value = false; preview.value = null }
function keydown(event) {
  if (locked.value) return
  const movement = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1, PageDown: -1, PageUp: 1 }
  if (!(event.key in movement) && event.key !== 'Home' && event.key !== 'End') return
  event.preventDefault(); release()
  select(event.key === 'End' ? props.options.length - 1 : event.key === 'Home' || !valid.value ? 0 : index.value + movement[event.key])
}
watch(() => [props.options, props.disabled], () => { release(); stopMotion(); nextTick(() => setFlowRate(1)) })
</script>

<template>
  <div class="reasoning-slider" :class="{ 'is-dragging': dragging, 'is-disabled': disabled, 'is-unset': !valid, 'is-hidden': hidden, 'is-reduced': reducedMotion }" :style="style">
    <div class="effort-heading"><span>推理强度</span><span v-if="!valid" class="effort-value">{{ options.length ? '请选择' : emptyLabel }}</span></div>
    <div v-if="options.length" class="effort-scroll">
      <div class="effort-scale">
        <div class="effort-control">
          <div class="effort-glass" aria-hidden="true">
            <svg class="effort-current" viewBox="0 0 1000 100" preserveAspectRatio="none">
              <defs>
                <linearGradient :id="id+'-current'" x1="0" y1="0" x2="0" y2="1"><stop stop-color="var(--effort-light)" stop-opacity=".5"/><stop offset=".38" stop-color="currentColor" stop-opacity=".12"/><stop offset=".7" stop-color="currentColor" stop-opacity=".015"/><stop offset="1" stop-color="var(--effort-light)" stop-opacity=".3"/></linearGradient>
                <filter :id="id+'-flow-soft'" x="-10%" y="-50%" width="120%" height="200%"><feGaussianBlur stdDeviation="4 2"/></filter>
              </defs>
              <g ref="flowTrack" class="effort-flow">
                <g v-for="offset in [0, 1000]" :key="offset" :transform="`translate(${offset} 0)`">
                  <path d="M50 46C220 24 490 31 860 49C550 38 300 40 50 46Z" :fill="`url(#${id}-current)`" :filter="`url(#${id}-flow-soft)`"/>
                  <path d="M180 70C420 53 620 57 980 72C650 64 430 66 180 70Z" fill="var(--effort-light)" fill-opacity=".12" :filter="`url(#${id}-flow-soft)`"/>
                  <path d="M50 46C220 24 490 31 860 49" fill="none" stroke="var(--effort-light)" stroke-opacity=".2" stroke-width="1.2" :filter="`url(#${id}-flow-soft)`"/>
                </g>
              </g>
            </svg>
            <span class="effort-wake"/>
          </div>
          <div class="effort-thumb" aria-hidden="true">
            <svg class="effort-lens" viewBox="0 0 400 112" preserveAspectRatio="none">
              <defs>
                <path :id="id+'-shape'" d="M0 56C72 56 92 4 200 4S328 56 400 56C328 56 308 108 200 108S72 56 0 56Z"/>
                <clipPath :id="id+'-clip'"><use :href="'#'+id+'-shape'"/></clipPath>
                <linearGradient :id="id+'-body'" x1="0" y1="0" x2="0" y2="1">
                  <stop stop-color="var(--effort-light)" stop-opacity=".95"/>
                  <stop offset=".1" stop-color="currentColor" stop-opacity=".64"/>
                  <stop offset=".28" stop-color="currentColor" stop-opacity=".3"/>
                  <stop offset=".52" stop-color="var(--effort-shade)" stop-opacity=".66"/>
                  <stop offset=".73" stop-color="currentColor" stop-opacity=".19"/>
                  <stop offset=".91" stop-color="currentColor" stop-opacity=".55"/>
                  <stop offset="1" stop-color="var(--effort-light)" stop-opacity=".95"/>
                </linearGradient>
                <radialGradient :id="id+'-top'" cx="50%" cy="0%" r="65%"><stop stop-color="var(--effort-light)" stop-opacity=".7"/><stop offset=".4" stop-color="currentColor" stop-opacity=".15"/><stop offset="1" stop-color="currentColor" stop-opacity="0"/></radialGradient>
                <radialGradient :id="id+'-bottom'" cx="50%" cy="100%" r="60%"><stop stop-color="var(--effort-light)" stop-opacity=".7"/><stop offset=".45" stop-color="currentColor" stop-opacity=".13"/><stop offset="1" stop-color="currentColor" stop-opacity="0"/></radialGradient>
                <linearGradient :id="id+'-edge'" x1="0" y1="0" x2="1" y2="0"><stop stop-color="currentColor" stop-opacity="0"/><stop offset=".22" stop-color="currentColor" stop-opacity=".35"/><stop offset=".42" stop-color="var(--effort-light)" stop-opacity=".95"/><stop offset=".58" stop-color="var(--effort-light)" stop-opacity=".95"/><stop offset=".78" stop-color="currentColor" stop-opacity=".35"/><stop offset="1" stop-color="currentColor" stop-opacity="0"/></linearGradient>
                <linearGradient :id="id+'-sheen'" x1="0" y1="0" x2="1" y2="0"><stop stop-color="var(--effort-light)" stop-opacity="0"/><stop offset=".45" stop-color="var(--effort-light)" stop-opacity=".05"/><stop offset=".52" stop-color="var(--effort-light)" stop-opacity=".32"/><stop offset=".62" stop-color="var(--effort-light)" stop-opacity=".03"/><stop offset="1" stop-color="var(--effort-light)" stop-opacity="0"/></linearGradient>
                <filter :id="id+'-rim-soft'" x="-20%" y="-50%" width="140%" height="200%"><feGaussianBlur stdDeviation="2.5"/></filter>
              </defs>
              <use :href="'#'+id+'-shape'" :fill="`url(#${id}-body)`"/>
              <g :clip-path="`url(#${id}-clip)`"><rect width="400" height="112" :fill="`url(#${id}-top)`"/><rect width="400" height="112" :fill="`url(#${id}-bottom)`"/></g>
              <g :clip-path="`url(#${id}-clip)`" class="effort-sheen-clip"><rect ref="sheen" class="effort-sheen" x="-200" y="0" width="400" height="112" :fill="`url(#${id}-sheen)`"/></g>
              <use :href="'#'+id+'-shape'" fill="none" :stroke="`url(#${id}-edge)`" stroke-width="4" :filter="`url(#${id}-rim-soft)`"/>
              <use :href="'#'+id+'-shape'" fill="none" :stroke="`url(#${id}-edge)`" stroke-width="1.2"/>
            </svg>
          </div>
          <input class="effort-input" type="range" min="0" :max="Math.max(1, options.length - 1)" step="0.01" :value="position" :disabled="locked" aria-label="推理强度" :aria-valuenow="Math.max(0,index)" :aria-valuetext="valid ? modelValue : '请选择推理强度'" @input="input" @keydown="keydown" @pointerdown="begin" @pointerup="release" @pointercancel="release" @lostpointercapture="release" @blur="release" />
        </div>
        <div class="effort-labels"><button v-for="(option, i) in options" :key="option" type="button" :class="{ selected: i === index }" :disabled="disabled" :aria-pressed="i === index" :title="option.length > 12 ? option : undefined" @click="release(); select(i)"><span class="effort-tick" aria-hidden="true"/><span class="effort-label-text">{{ option }}</span></button></div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.reasoning-slider{--effort-color:var(--chrome-accent);--effort-light:color-mix(in srgb,var(--chrome-accent) 25%,white);--effort-shade:color-mix(in srgb,var(--chrome-raised) 80%,black);min-width:0;padding:6px 0 0;color:var(--chrome-muted)}
.effort-heading{display:flex;align-items:center;justify-content:space-between;gap:16px;font-size:12px;line-height:20px}
.effort-value{color:var(--effort-color);max-width:65%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-variant-numeric:tabular-nums}
.effort-scroll{overflow:clip;padding:16px 12px 8px;min-width:0}
.effort-scale{width:100%;min-width:0}
.effort-control{position:relative;height:56px;isolation:isolate;overflow:hidden;border-radius:24px!important}
.effort-glass{position:absolute;inset:7px 0;border:1px solid color-mix(in srgb,var(--effort-color) 28%,transparent);border-radius:999px!important;overflow:hidden;color:var(--effort-color);background:linear-gradient(180deg,color-mix(in srgb,var(--effort-color) 13%,transparent),color-mix(in srgb,var(--effort-shade) 60%,transparent) 48%,color-mix(in srgb,var(--effort-shade) 45%,transparent) 70%,color-mix(in srgb,var(--effort-color) 17%,transparent));box-shadow:inset 0 1px 2px color-mix(in srgb,var(--effort-light) 23%,transparent),inset 0 -1px 3px color-mix(in srgb,var(--effort-light) 25%,transparent),inset 0 -6px 10px color-mix(in srgb,var(--effort-color) 10%,transparent)}
.effort-glass::after{content:'';position:absolute;inset:0;pointer-events:none;background:radial-gradient(ellipse at 1% 50%,color-mix(in srgb,var(--effort-light) 15%,transparent),transparent 20%),radial-gradient(ellipse at 99% 50%,color-mix(in srgb,var(--effort-light) 12%,transparent),transparent 20%)}
.effort-current{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
.effort-wake{position:absolute;top:5%;height:90%;width:55%;left:var(--effort-position);transform:translateX(-72%) scaleX(var(--effort-direction));background:radial-gradient(ellipse at 80% 50%,color-mix(in srgb,var(--effort-light) 29%,transparent),transparent 68%);filter:blur(3px);opacity:.65;transition:left .65s cubic-bezier(.16,1,.3,1),opacity .3s}
.effort-thumb{position:absolute;top:3px;bottom:3px;left:var(--effort-position);width:45%;transform:translateX(-50%);color:var(--effort-color);pointer-events:none;transition:left .42s cubic-bezier(.2,.85,.2,1),width .42s cubic-bezier(.2,.85,.2,1),filter .3s;filter:drop-shadow(0 0 5px color-mix(in srgb,var(--effort-color) 18%,transparent))}
.effort-lens{display:block;width:100%;height:100%;overflow:visible;transform-origin:var(--effort-glint) 50%;transform:scale(var(--effort-stretch),var(--effort-compress)) skewX(var(--effort-shear))}
.effort-flow{animation:effort-flow-stream 20s linear infinite}
.effort-sheen{animation:effort-sheen-travel 12s linear infinite;transform:translateX(0)}
@keyframes effort-flow-stream{from{transform:translateX(-1000px)}to{transform:translateX(0)}}
@keyframes effort-sheen-travel{0%{transform:translateX(-80px);opacity:0}18%{opacity:.45}62%{opacity:.7}85%,100%{transform:translateX(480px);opacity:0}}
.is-disabled .effort-flow,.is-disabled .effort-sheen,.is-hidden .effort-flow,.is-hidden .effort-sheen,.is-unset .effort-flow,.is-unset .effort-sheen{animation-play-state:paused}
.reasoning-slider .effort-input{position:absolute!important;top:0!important;left:calc(50% / var(--effort-count) - 10px)!important;width:calc(100% - 100% / var(--effort-count) + 20px)!important;height:56px!important;min-height:0!important;padding:0!important;border:0!important;margin:0!important;opacity:0;cursor:ew-resize;appearance:none;touch-action:pan-y}
.effort-input::-webkit-slider-thumb{appearance:none;width:20px;height:56px}
.effort-input::-moz-range-thumb{width:20px;height:56px;border:0}
.effort-control:has(.effort-input:focus-visible){outline:1px solid var(--effort-color);outline-offset:4px;border-radius:999px!important}
.is-dragging .effort-thumb{transition:left 35ms linear,width 35ms linear,filter .25s;filter:drop-shadow(0 0 9px color-mix(in srgb,var(--effort-color) 45%,transparent))}
.is-dragging .effort-wake{opacity:1}
.effort-labels{position:relative;display:grid;grid-template-columns:repeat(var(--effort-count),minmax(0,1fr));margin-top:10px}
.effort-labels::before{content:'';position:absolute;top:4px;left:calc(50% / var(--effort-count));right:calc(50% / var(--effort-count));height:1px;background:linear-gradient(90deg,transparent,color-mix(in srgb,var(--effort-color) 24%,transparent),transparent)}
.reasoning-slider.reasoning-slider .effort-labels button{display:flex!important;flex-direction:column;align-items:center;gap:5px;min-width:0!important;min-height:34px!important;height:34px!important;box-sizing:border-box;margin:0!important;padding:0 3px 3px!important;border:0!important;border-radius:4px!important;box-shadow:none!important;background:transparent!important;color:var(--chrome-muted)!important;font:inherit;font-size:11px;line-height:20px;cursor:pointer;transition:color .22s}
.effort-tick{display:block;width:1px;height:9px;flex:0 0 9px;background:currentColor;opacity:.5;transform:scaleY(.78);transform-origin:50% 0;transition:transform .22s,opacity .22s,box-shadow .22s}
.effort-label-text{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.reasoning-slider.reasoning-slider .effort-labels button.selected{color:var(--effort-color)!important}
.effort-labels button.selected .effort-tick{transform:scaleY(1);opacity:1;box-shadow:0 0 7px color-mix(in srgb,var(--effort-color) 50%,transparent)}
.reasoning-slider.reasoning-slider .effort-labels button:hover:not(:disabled){color:var(--chrome-text)!important}
.reasoning-slider.reasoning-slider .effort-labels button:focus-visible{outline:1px solid var(--effort-color)!important;outline-offset:1px}
.is-unset .effort-thumb,.is-unset .effort-wake{opacity:0}
.is-disabled{opacity:.5}.is-disabled .effort-input,.is-disabled .effort-labels button{cursor:default}
.is-reduced .effort-flow,.is-reduced .effort-sheen{animation:none!important}
@media(prefers-reduced-motion:reduce){.reasoning-slider *{transition:none!important;animation:none!important}.effort-wake,.effort-sheen{display:none}}
</style>
