<script setup>
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import ChromeIcon from './ChromeIcon.vue'
const props = defineProps({ target: Object, disabledReason: String })
const emit = defineEmits(['close', 'delete'])
const menu = ref(null), left = ref(0), top = ref(0)
let origin
async function position() {
  if (!props.target) return
  origin = props.target.origin || document.activeElement
  left.value = props.target.x; top.value = props.target.y
  await nextTick()
  const bounds = menu.value?.getBoundingClientRect()
  if (!bounds) return
  left.value = Math.max(8, Math.min(props.target.x, innerWidth - bounds.width - 8))
  top.value = Math.max(8, Math.min(props.target.y, innerHeight - bounds.height - 8))
  menu.value?.querySelector('button')?.focus({ preventScroll: true })
}
watch(() => props.target, position, { immediate: true })
function close(restore = false) {
  emit('close')
  if (restore && origin?.isConnected) origin.focus?.({ preventScroll: true })
}
function outside(event) { if (!menu.value?.contains(event.target)) close() }
function scroll(event) { if (!menu.value?.contains(event.target)) close() }
function keydown(event) {
  if (!props.target) return
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true) }
  else if (event.key === 'Tab') close()
  else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
    event.preventDefault(); menu.value?.querySelector('button')?.focus()
  }
}
function remove() {
  if (props.disabledReason) return
  const session = props.target.session
  close(true); emit('delete', session)
}
onMounted(() => {
  document.addEventListener('pointerdown', outside, true)
  document.addEventListener('keydown', keydown, true)
  document.addEventListener('scroll', scroll, true)
  window.addEventListener('resize', close)
  window.addEventListener('blur', close)
})
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', outside, true)
  document.removeEventListener('keydown', keydown, true)
  document.removeEventListener('scroll', scroll, true)
  window.removeEventListener('resize', close)
  window.removeEventListener('blur', close)
})
</script>
<template>
  <Teleport to="body">
    <div v-if="target" ref="menu" class="session-context-menu" role="menu" aria-label="会话操作" :style="{left:left+'px',top:top+'px'}" @contextmenu.prevent>
      <button type="button" role="menuitem" :aria-disabled="Boolean(disabledReason)" :data-tooltip="disabledReason || '删除会话'" @click="remove"><ChromeIcon name="trash"/><span>删除</span></button>
    </div>
  </Teleport>
</template>
<style>
.session-context-menu{position:fixed;z-index:10000;width:150px;padding:5px;border:var(--appearance-border-width, 1px) solid var(--chrome-line,var(--line));border-radius:var(--appearance-radius, 6px);background:var(--chrome-surface,var(--panel));box-shadow:0 6px 20px #0003;color:var(--chrome-text,var(--text));font:12px/1.5 var(--chrome-sans,sans-serif)}
.session-context-menu button{display:flex;align-items:center;gap:9px;width:100%;min-height:32px;padding:7px 10px;border:0!important;border-radius:var(--appearance-radius, 3px);background:transparent!important;color:var(--chrome-danger,var(--red));box-shadow:none!important;cursor:pointer;font:inherit;transform:none!important;transition:none!important}
.session-context-menu button .chrome-icon{width:15px;height:15px;flex:0 0 15px}
.session-context-menu button:is(:hover,:focus-visible){background:var(--chrome-hover)!important;outline:none}
.session-context-menu button[aria-disabled='true']{color:var(--chrome-muted,var(--muted));opacity:.5;cursor:not-allowed}
</style>
