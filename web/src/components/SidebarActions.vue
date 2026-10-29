<script setup>
import ChromeIcon from './ChromeIcon.vue'
import { computed, ref, onMounted, onBeforeUnmount } from 'vue'
const props = defineProps({ mode: { type: String, default: 'system' }, canCreate: Boolean })
const label = computed(() => ({ light: '切到夜间', dark: '日夜跟随系统', system: '切到白天' }[props.mode]))
const emit = defineEmits(['theme', 'settings', 'navigate', 'create', 'controls'])
const root = ref(null), trigger = ref(null), action = ref(null), open = ref(false)
function closeOutside(event) { if (!event.composedPath().includes(root.value)) open.value = false }
function keydown(event) {
  if (event.key === 'Escape' && open.value) { open.value = false; trigger.value?.focus() }
}
function openSettings() { open.value = false; emit('settings'); trigger.value?.focus() }
function moveFocus(event) {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  const items = [...root.value.querySelectorAll('[role=menuitem], [role=menuitemradio]')], index = items.indexOf(document.activeElement)
  event.preventDefault()
  items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus()
}
function navigate(panel) { open.value = false; emit('navigate', panel); trigger.value?.focus() }
function create() { open.value = false; emit('create'); trigger.value?.focus() }
function cycleTheme() { emit('theme') }
onMounted(() => document.addEventListener('pointerdown', closeOutside))
onBeforeUnmount(() => document.removeEventListener('pointerdown', closeOutside))
</script>

<template>
  <div ref="root" class="sidebar-actions" @keydown="keydown">
    <button ref="trigger" type="button" class="sidebar-actions-trigger" aria-label="应用菜单" data-tooltip="应用" aria-haspopup="menu" :aria-expanded="open" @click="open = !open" @keydown.down.prevent="open = true; $nextTick(() => action?.focus())">
      <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="3.5" width="6" height="6" rx="1.2"/><rect x="14.5" y="3.5" width="6" height="6" rx="1.2"/><rect x="3.5" y="14.5" width="6" height="6" rx="1.2"/><rect x="14.5" y="14.5" width="6" height="6" rx="1.2"/></svg>
    </button>
    <div v-if="open" class="sidebar-actions-menu" role="menu" aria-label="应用" @keydown="moveFocus">
      <button ref="action" type="button" role="menuitem" class="sidebar-menu-action" @click="navigate('chat')"><ChromeIcon name="home" /><span>回到对话</span></button>
      <button v-if="canCreate" type="button" role="menuitem" class="sidebar-menu-action" @click="create"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg><span>新建会话</span></button>
      <button type="button" role="menuitem" class="sidebar-menu-action" @click="navigate('sessions')"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" /></svg><span>会话管理</span></button>
      <hr class="app-menu-divider" />
      <button type="button" role="menuitem" class="sidebar-menu-action" @click="openSettings">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m10 3-.6 2.2-1.8 1L5.4 6l-2 3.5L5 11v2l-1.6 1.5 2 3.5 2.2-.2 1.8 1L10 21h4l.6-2.2 1.8-1 2.2.2 2-3.5L19 13v-2l1.6-1.5-2-3.5-2.2.2-1.8-1L14 3Z"/><circle cx="12" cy="12" r="3"/></svg><span>全局配置</span>
      </button>
      <button type="button" role="menuitem" class="sidebar-menu-action" @click="open = false; emit('controls')"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M8 4v16m8-16v16" /></svg><span>显示控件</span></button>
      <button type="button" role="menuitem" data-theme-cycle :data-tooltip="label" class="sidebar-menu-action theme-mode-action" @click="cycleTheme">
        <svg viewBox="0 0 24 24" aria-hidden="true"><template v-if="mode === 'system'"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/></template><path v-else-if="mode === 'light'" d="M20 15.5A8.5 8.5 0 0 1 8.5 4a8.5 8.5 0 1 0 11.5 11.5Z"/><template v-else><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/></template></svg>
        <span>{{ label }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.sidebar-actions{position:relative;display:flex;align-items:center;height:30px}
.sidebar-actions svg{width:17px;height:17px;fill:none;stroke:currentColor;stroke-width:1.55;stroke-linecap:round;stroke-linejoin:round;flex-shrink:0}
:root[data-theme] .sidebar-actions .sidebar-actions-trigger{display:grid;place-items:center;width:30px;height:30px;min-height:0;padding:0;border:0!important;color:var(--chrome-muted)!important}
.sidebar-actions-menu{position:absolute;left:-2px;bottom:38px;z-index:50;width:208px;padding:5px;border:1px solid var(--chrome-line);border-radius:var(--appearance-radius,7px);background:linear-gradient(var(--chrome-surface),var(--chrome-surface)),linear-gradient(var(--chrome-bg),var(--chrome-bg)),var(--sidebar-menu-base,#fff);box-shadow:0 8px 26px #0002}
:root[data-theme] .sidebar-actions-menu .sidebar-menu-action{display:flex;align-items:center;gap:10px;width:100%;min-height:36px;padding:0 10px;border:0!important;text-align:left;font-size:calc(12px * var(--appearance-ui-scale,1))}
:root[data-theme="dark"] .sidebar-actions-menu{--sidebar-menu-base:#111418}
:root[data-neo-desktop] .sidebar-actions{visibility:hidden;pointer-events:none}
:root[data-theme] .sidebar-actions-menu .theme-mode-action{color:var(--chrome-accent)}
</style>
