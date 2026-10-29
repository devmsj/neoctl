<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'
import ChromeIcon from './ChromeIcon.vue'
import { CONTROL_OPTIONS } from '../control-visibility.mjs'
defineProps({ controls: { type: Object, required: true } })
const emit = defineEmits(['change', 'reset', 'close'])
const panel = ref(null)
let previous
function keydown(event) {
  if (event.key === 'Escape') { event.stopPropagation(); emit('close') }
  if (event.key !== 'Tab') return
  const buttons = [...panel.value.querySelectorAll('button:not(:disabled)')]
  if (event.shiftKey && document.activeElement === buttons[0]) { event.preventDefault(); buttons.at(-1)?.focus() }
  else if (!event.shiftKey && document.activeElement === buttons.at(-1)) { event.preventDefault(); buttons[0]?.focus() }
}
onMounted(() => { previous = document.activeElement; panel.value?.querySelector('button')?.focus() })
onBeforeUnmount(() => { if (previous?.isConnected) previous.focus() })
</script>
<template>
  <Teleport to="body">
    <div class="control-visibility-scrim" @pointerdown.self="emit('close')">
      <section ref="panel" class="control-visibility-panel" role="dialog" aria-modal="true" aria-label="显示控件" @keydown="keydown">
        <header><button type="button" aria-label="关闭显示控件" data-tooltip="关闭" @click="emit('close')"><ChromeIcon name="close" /></button></header>
        <div v-for="group in ['左侧', '对话', '右侧']" :key="group" class="control-visibility-group">
          <span class="control-visibility-caption">{{ group }}</span>
          <button v-for="item in CONTROL_OPTIONS.filter(x => x.group === group)" :key="item.key" type="button" role="checkbox" :aria-checked="controls[item.key]" :aria-label="item.label" @click="emit('change', item.key, !controls[item.key])">
            <span>{{ item.label }}</span><span class="control-check" aria-hidden="true"><ChromeIcon v-if="controls[item.key]" name="check" /></span>
          </button>
        </div>
        <footer><button type="button" @click="emit('reset')">全部显示</button></footer>
      </section>
    </div>
  </Teleport>
</template>
<style>
.control-visibility-scrim { position:fixed; inset:var(--neo-window-inset,0px) 0 0; z-index:1900; }
:root[data-theme] .control-visibility-panel { position:absolute; right:16px; top:8px; width:min(280px,calc(100vw - 24px)); max-height:calc(100dvh - var(--neo-window-inset,0px) - 24px); overflow:auto; padding:12px 16px; border:1px solid var(--chrome-line); border-radius:var(--appearance-radius,7px); background:var(--glass-popup,var(--chrome-surface)); color:var(--chrome-text); box-shadow:0 10px 32px #0002; }
.control-visibility-panel header { display:flex; align-items:center; justify-content:flex-end; min-height:24px; }
:root[data-theme] .control-visibility-panel button { min-height:32px; border:0!important; background:transparent!important; box-shadow:none!important; color:var(--chrome-text)!important; font-size:12px; font-weight:400; padding:0; }
:root[data-theme] .control-visibility-panel button:focus-visible { outline:1px solid var(--chrome-accent)!important; outline-offset:2px; }
.control-visibility-panel header button { width:28px; display:grid; place-items:center; }
.control-visibility-group { margin-top:8px; padding-top:8px; border-top:1px solid var(--chrome-line); }
.control-visibility-caption { display:block; color:var(--chrome-faint); font-size:11px; margin:2px 0 4px; }
.control-visibility-group button { display:flex; align-items:center; justify-content:space-between; width:100%; }
.control-check { width:16px; height:16px; display:grid; place-items:center; border:1px solid var(--chrome-line); border-radius:3px; color:var(--chrome-accent); }
.control-check svg { width:12px; height:12px; }
[aria-checked=true] .control-check { border-color:var(--chrome-accent); background:var(--chrome-accent-soft); }
.control-visibility-panel footer { border-top:1px solid var(--chrome-line); margin-top:12px; padding-top:6px; }
:root[data-theme] .control-visibility-panel footer button { color:var(--chrome-accent)!important; }

</style>
