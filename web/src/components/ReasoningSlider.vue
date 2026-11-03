<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
const props = defineProps({
  modelValue: { type: String, default: '' },
  options: { type: Array, default: () => [] },
  disabled: Boolean,
  emptyLabel: { type: String, default: '未配置档位' },
})
const emit = defineEmits(['update:modelValue'])
const dragging = ref(false), preview = ref(null), hover = ref(null), reducedMotion = ref(false), hidden = ref(false)
const control = ref(null)
let motionQuery
const index = computed(() => props.options.indexOf(props.modelValue))
const valid = computed(() => index.value >= 0)
const locked = computed(() => props.disabled || props.options.length < 2)
const position = computed(() => preview.value ?? Math.max(0, index.value))
const level = computed(() => props.options.length < 2 ? 1 : position.value / (props.options.length - 1))
const at = i => `${(i + .5) / Math.max(1, props.options.length) * 100}%`
const style = computed(() => ({
  '--effort-position': valid.value ? at(position.value) : '0%',
  '--effort-hover': hover.value === null ? '0%' : at(hover.value),
  '--effort-count': Math.max(1, props.options.length),
  '--effort-level': level.value.toFixed(3),
}))
// Playback rate keeps animation phase, so the sweep speeds up without jumping.
function syncRate() {
  const rate = .5 + level.value * 2
  for (const animation of control.value?.getAnimations?.({ subtree: true }) ?? []) {
    if (!(animation instanceof CSSTransition)) animation.updatePlaybackRate(rate)
  }
}
function motionPreference() { reducedMotion.value = motionQuery.matches }
function visibility() { hidden.value = document.hidden; if (hidden.value) release() }
onMounted(() => {
  motionQuery = matchMedia('(prefers-reduced-motion: reduce)')
  motionPreference(); visibility()
  motionQuery.addEventListener('change', motionPreference)
  document.addEventListener('visibilitychange', visibility)
  nextTick(syncRate)
})
onBeforeUnmount(() => {
  motionQuery?.removeEventListener('change', motionPreference)
  document.removeEventListener('visibilitychange', visibility)
})
watch([level, valid], () => nextTick(syncRate))
function select(i) {
  if (props.disabled || !props.options.length) return
  const next = Math.max(0, Math.min(props.options.length - 1, Math.round(Number(i))))
  if (!Number.isFinite(next)) return
  if (props.options[next] !== props.modelValue) emit('update:modelValue', props.options[next])
}
function begin() { if (!locked.value) { dragging.value = true; hover.value = null } }
function input(event) {
  if (locked.value) return
  const value = Number(event.target.value)
  if (dragging.value) preview.value = value
  select(value)
}
function pointermove(event) {
  if (locked.value || dragging.value || event.pointerType === 'touch') return
  const box = event.currentTarget.getBoundingClientRect()
  const next = Math.round(Math.max(0, Math.min(1, (event.clientX - box.left - 10) / Math.max(1, box.width - 20))) * (props.options.length - 1))
  hover.value = valid.value && next === index.value ? null : next
}
function release() { dragging.value = false; preview.value = null }
function keydown(event) {
  if (locked.value) return
  const movement = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1, PageDown: -1, PageUp: 1 }
  if (!(event.key in movement) && event.key !== 'Home' && event.key !== 'End') return
  event.preventDefault(); release()
  select(event.key === 'End' ? props.options.length - 1 : event.key === 'Home' || !valid.value ? 0 : index.value + movement[event.key])
}
watch(() => [props.options, props.disabled], () => { release(); hover.value = null; nextTick(syncRate) })
watch(index, () => { hover.value = null })
</script>

<template>
  <div class="reasoning-slider" :class="{ 'is-dragging': dragging, 'is-disabled': disabled, 'is-unset': !valid, 'is-hidden': hidden, 'is-reduced': reducedMotion }" :style="style">
    <div class="effort-heading"><span>推理强度</span><span v-if="!valid" class="effort-value">{{ options.length ? '请选择' : emptyLabel }}</span></div>
    <div v-if="options.length" class="effort-scroll">
      <div class="effort-scale">
        <div ref="control" class="effort-control">
          <div class="effort-track" aria-hidden="true">
            <span v-if="hover !== null && (!valid || hover > position)" class="effort-preview"/>
            <span class="effort-fill"><span class="effort-sheen"/></span>
            <i v-for="(option, i) in options" :key="option" class="effort-tick" :class="{ lit: valid && i <= position + .001 }" :style="{ left: at(i) }"/>
          </div>
          <span v-if="hover !== null" class="effort-ghost" aria-hidden="true"/>
          <span class="effort-head" aria-hidden="true"/>
          <input class="effort-input" type="range" min="0" :max="Math.max(1, options.length - 1)" step="0.01" :value="position" :disabled="locked" aria-label="推理强度" :aria-valuenow="Math.max(0,index)" :aria-valuetext="valid ? modelValue : '请选择推理强度'" @input="input" @keydown="keydown" @pointerdown="begin" @pointerup="release" @pointercancel="release" @lostpointercapture="release" @blur="release" @pointermove="pointermove" @pointerleave="hover = null" />
        </div>
        <div class="effort-labels"><button v-for="(option, i) in options" :key="option" type="button" :class="{ selected: i === index }" :disabled="disabled" :aria-pressed="i === index" :title="option.length > 12 ? option : undefined" @click="release(); select(i)"><span class="effort-label-text">{{ option }}</span></button></div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Gradients use mask-image: global appearance rules override background-image on every element. */
.reasoning-slider{--effort-color:var(--chrome-accent);--effort-rest:var(--chrome-line);--effort-ease:cubic-bezier(.2,.8,.2,1);min-width:0;padding:6px 0 0;color:var(--chrome-muted)}
.effort-heading{display:flex;align-items:center;justify-content:space-between;gap:16px;font-size:12px;line-height:20px}
.effort-value{color:var(--effort-color);max-width:65%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.effort-scroll{overflow:clip;padding:8px 12px 4px;min-width:0}
.effort-scale{width:100%;min-width:0}
.effort-control{position:relative;height:40px;isolation:isolate}
.effort-track{position:absolute;left:0;right:0;top:50%;height:12px;margin-top:-6px;border-radius:6px!important;overflow:hidden;background:color-mix(in srgb,var(--effort-rest) 60%,transparent);box-shadow:inset 0 0 0 1px var(--effort-rest)}
.effort-fill,.effort-preview{position:absolute;left:0;top:0;bottom:0;border-radius:6px!important}
.effort-fill{width:var(--effort-position);overflow:hidden;background-color:var(--effort-color);-webkit-mask-image:linear-gradient(to right,rgb(0 0 0/.35),#000);mask-image:linear-gradient(to right,rgb(0 0 0/.35),#000);transition:width .45s var(--effort-ease)}
.effort-preview{width:var(--effort-hover);background-color:color-mix(in srgb,var(--effort-color) 22%,transparent)}
.effort-sheen{position:absolute;top:0;bottom:0;left:0;width:45%;background-color:color-mix(in srgb,var(--chrome-raised) 70%,transparent);-webkit-mask-image:linear-gradient(to right,transparent,#000,transparent);mask-image:linear-gradient(to right,transparent,#000,transparent);transform:translateX(-110%);animation:effort-sweep 2.6s ease-in-out infinite}
@keyframes effort-sweep{0%{transform:translateX(-110%)}70%,100%{transform:translateX(240%)}}
.effort-tick{position:absolute;top:3px;bottom:3px;width:2px;margin-left:-1px;border-radius:1px!important;background:color-mix(in srgb,var(--chrome-faint) 45%,transparent);transition:background .3s}
.effort-tick.lit{background:color-mix(in srgb,var(--chrome-raised) 75%,transparent)}
.effort-head,.effort-ghost{position:absolute;top:50%;width:18px;height:18px;margin:-9px 0 0 -9px;box-sizing:border-box;border-radius:50%!important;pointer-events:none}
.effort-head{left:var(--effort-position);border:2px solid var(--effort-color);background:var(--chrome-raised);box-shadow:inset 0 0 0 3px var(--chrome-raised),inset 0 0 0 9px var(--effort-color),0 0 calc(4px + var(--effort-level) * 8px) color-mix(in srgb,var(--effort-color) 40%,transparent);transition:left .45s var(--effort-ease),transform .2s;animation:effort-breathe 2.4s ease-in-out infinite}
@keyframes effort-breathe{50%{box-shadow:inset 0 0 0 3px var(--chrome-raised),inset 0 0 0 9px var(--effort-color),0 0 calc(8px + var(--effort-level) * 14px) color-mix(in srgb,var(--effort-color) 65%,transparent)}}
.effort-ghost{left:var(--effort-hover);border:1.5px dashed color-mix(in srgb,var(--effort-color) 70%,transparent);background:var(--chrome-raised)}
.is-dragging .effort-head{transform:scale(1.18);transition:left 40ms linear,transform .2s}
.is-dragging .effort-fill{transition:width 40ms linear}
.reasoning-slider .effort-input{position:absolute!important;top:0!important;left:calc(50% / var(--effort-count) - 10px)!important;width:calc(100% - 100% / var(--effort-count) + 20px)!important;height:40px!important;min-height:0!important;padding:0!important;border:0!important;margin:0!important;opacity:0;cursor:ew-resize;appearance:none;touch-action:pan-y}
.effort-input::-webkit-slider-thumb{appearance:none;width:20px;height:40px}
.effort-input::-moz-range-thumb{width:20px;height:40px;border:0}
.effort-control:has(.effort-input:focus-visible) .effort-head{outline:2px solid var(--effort-color);outline-offset:3px}
.effort-labels{display:grid;grid-template-columns:repeat(var(--effort-count),minmax(0,1fr))}
.reasoning-slider.reasoning-slider .effort-labels button{display:flex!important;justify-content:center;min-width:0!important;min-height:26px!important;height:26px!important;box-sizing:border-box;margin:0!important;padding:0 3px!important;border:0!important;border-radius:4px!important;box-shadow:none!important;background:transparent!important;color:var(--chrome-faint)!important;font:inherit;font-size:11px;line-height:26px;cursor:pointer;transition:color .22s}
.effort-label-text{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.reasoning-slider.reasoning-slider .effort-labels button.selected{color:var(--effort-color)!important}
.reasoning-slider.reasoning-slider .effort-labels button:hover:not(:disabled){color:var(--chrome-text)!important}
.reasoning-slider.reasoning-slider .effort-labels button:focus-visible{outline:1px solid var(--effort-color)!important;outline-offset:1px}
.is-unset .effort-head{opacity:0}
.is-disabled{opacity:.5}.is-disabled .effort-input,.is-disabled .effort-labels button{cursor:default}
.is-disabled .effort-head,.is-disabled .effort-sheen,.is-hidden .effort-head,.is-hidden .effort-sheen,.is-unset .effort-head,.is-unset .effort-sheen{animation-play-state:paused}
.is-reduced .effort-head,.is-reduced .effort-sheen{animation:none!important}
@media(prefers-reduced-motion:reduce){.reasoning-slider *{transition:none!important;animation:none!important}}
</style>
