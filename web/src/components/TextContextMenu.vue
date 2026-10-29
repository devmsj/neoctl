<script setup>
import { nextTick, onMounted, onBeforeUnmount, ref } from 'vue'
import ChromeIcon from './ChromeIcon.vue'
import { isDesktop } from '../local-resources.mjs'
const emit = defineEmits(['notify'])
const target = ref(null), menu = ref(null), left = ref(0), top = ref(0), busy = ref(false)
function editable(node) {
  const el = node?.closest?.('textarea,input,[contenteditable="true"]')
  if (!el || el.disabled) return null
  if (el.tagName === 'INPUT' && !['text','search','url','tel','email','password'].includes(el.type)) return null
  return el
}
function restore(t) {
  if (t.field?.isConnected) {
    t.field.focus({ preventScroll: true })
    if (t.start !== null) t.field.setSelectionRange(t.start, t.end)
  }
  if (t.range?.startContainer.isConnected) {
    const s = getSelection(); s.removeAllRanges(); s.addRange(t.range)
  }
}
function close(restoreFocus = false) {
  const t = target.value; target.value = null
  if (restoreFocus && t) restore(t)
}
async function open(event) {
  if (menu.value?.contains(event.target)) { event.preventDefault(); return }
  const field = editable(event.target), selection = getSelection()
  const start = field?.selectionStart ?? null, end = field?.selectionEnd ?? null
  const text = field && start !== null ? field.value.slice(start, end) : selection?.toString() || ''
  if (!field && !text) { close(); return }
  event.preventDefault(); event.stopPropagation()
  target.value = { field, start, end, text: field?.type === 'password' ? '' : text,
    writable: !!field && !field.readOnly, range: (!field || field.isContentEditable) && selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null }
  const origin = (field || event.target).getBoundingClientRect()
  const x = Number.isFinite(event.clientX) && event.clientX > 0 ? event.clientX : origin.left + 12
  const y = Number.isFinite(event.clientY) && event.clientY > 0 ? event.clientY : origin.top + 20
  left.value = x; top.value = y
  await nextTick()
  const r = menu.value?.getBoundingClientRect(); if (!r) return
  left.value = Math.max(8, Math.min(x, innerWidth - r.width - 8))
  top.value = Math.max(8, Math.min(y, innerHeight - r.height - 8))
  menu.value.querySelector('button:not(:disabled)')?.focus({ preventScroll: true })
}
async function copy(t) {
  if (isDesktop()) { await window.__TAURI__.core.invoke('plugin:local-resources|clipboard_write', { text: t.text }); return }
  if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(t.text); return }
  restore(t)
  if (!document.execCommand('copy')) throw new Error('无法复制，请使用 Ctrl+C')
}
async function paste(t) {
  const data = new DataTransfer()
  if (isDesktop()) {
    const content = await window.__TAURI__.core.invoke('plugin:local-resources|clipboard_read')
    if (typeof content?.text === 'string') data.setData('text/plain', content.text)
    if (content?.imagePng) {
      const bytes = Uint8Array.from(atob(content.imagePng), c => c.charCodeAt(0))
      data.items.add(new File([bytes], '粘贴图片.png', { type: 'image/png' }))
    }
  } else if (navigator.clipboard?.read) {
    try {
      for (const item of await navigator.clipboard.read()) {
        if (item.types.includes('text/plain')) data.setData('text/plain', await (await item.getType('text/plain')).text())
        const type = item.types.find(type => type.startsWith('image/'))
        if (type) data.items.add(new File([await item.getType(type)], '粘贴图片.' + (type.split('/')[1] === 'jpeg' ? 'jpg' : type.split('/')[1]), { type }))
      }
    } catch {
      if (!navigator.clipboard?.readText) throw new Error('无法读取剪贴板，请使用 Ctrl+V')
      data.setData('text/plain', await navigator.clipboard.readText())
    }
  } else if (navigator.clipboard?.readText) data.setData('text/plain', await navigator.clipboard.readText())
  else throw new Error('无法读取剪贴板，请使用 Ctrl+V')
  if (!t.field?.isConnected || t.field.disabled || t.field.readOnly) return
  restore(t)
  // Reuse the composer's existing image validation/upload path and text handling.
  const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data })
  if (!t.field.dispatchEvent(event)) return
  const text = data.getData('text/plain'); if (!text) return
  // Native editing preserves undo history; fallback still emits input for v-model.
  if (!document.execCommand('insertText', false, text)) {
    if (t.start !== null) t.field.setRangeText(text, t.start, t.end, 'end')
    else if (t.field.isContentEditable) {
      const s = getSelection(); if (!s?.rangeCount) return
      const r = s.getRangeAt(0), node = document.createTextNode(text); r.deleteContents(); r.insertNode(node); r.setStartAfter(node); r.collapse(true); s.removeAllRanges(); s.addRange(r)
    } else return
    t.field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste', data: text }))
  }
}
async function act(action, snapshot = target.value) {
  const t = snapshot; if (!t || busy.value) return
  busy.value = true
  try { await (action === 'copy' ? copy(t) : paste(t)); close(); if (action === 'copy') restore(t) }
  catch (error) { close(); restore(t); emit('notify', isDesktop() ? '剪贴板暂时不可用，请重试' : action === 'copy' ? '无法复制，请使用 Ctrl+C' : '无法读取剪贴板，请使用 Ctrl+V') }
  finally { busy.value = false }
}
function outside(event) { if (!menu.value?.contains(event.target)) close() }
function scroll(event) { if (!menu.value?.contains(event.target)) close() }
function keydown(event) {
  if (isDesktop() && !event.isComposing && !event.repeat && (event.ctrlKey || event.metaKey) && !event.altKey && ['c','v'].includes(event.key.toLowerCase())) {
    const field = editable(event.target), selection = getSelection(), start = field?.selectionStart ?? null, end = field?.selectionEnd ?? null
    const text = field && start !== null ? field.value.slice(start, end) : selection?.toString() || ''
    const action = event.key.toLowerCase() === 'c' ? 'copy' : 'paste'
    if (action === 'copy' ? !text || field?.type === 'password' : !field || field.readOnly) return
    event.preventDefault(); event.stopPropagation()
    const snapshot = { field, start, end, text, writable: !!field && !field.readOnly, range: (!field || field.isContentEditable) && selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null }
    void act(action, snapshot); return
  }
  if (!target.value) return
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true) }
  else if (event.key === 'Tab') close(true)
  else if (['ArrowDown','ArrowUp','Home','End'].includes(event.key)) {
    event.preventDefault()
    const items = [...menu.value.querySelectorAll('button:not(:disabled)')], i = items.indexOf(document.activeElement)
    items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (i + (event.key === 'ArrowUp' ? items.length - 1 : 1)) % items.length]?.focus()
  }
}
const dismiss = () => close()
onMounted(() => {
  document.addEventListener('contextmenu', open, true)
  document.addEventListener('pointerdown', outside, true)
  document.addEventListener('keydown', keydown, true)
  document.addEventListener('scroll', scroll, true)
  window.addEventListener('resize', dismiss); window.addEventListener('blur', dismiss)
})
onBeforeUnmount(() => {
  document.removeEventListener('contextmenu', open, true)
  document.removeEventListener('pointerdown', outside, true)
  document.removeEventListener('keydown', keydown, true)
  document.removeEventListener('scroll', scroll, true)
  window.removeEventListener('resize', dismiss); window.removeEventListener('blur', dismiss)
})
</script>
<template>
  <Teleport to="body">
    <div v-if="target" ref="menu" class="session-context-menu text-context-menu" role="menu" aria-label="文字操作" :style="{left:left+'px',top:top+'px'}" @pointerdown.prevent>
      <button type="button" role="menuitem" :disabled="busy || !target.text" @click="act('copy')"><ChromeIcon name="copy" /><span>复制</span></button>
      <button v-if="target.writable" type="button" role="menuitem" :disabled="busy" @click="act('paste')"><ChromeIcon name="paste" /><span>粘贴</span></button>
    </div>
  </Teleport>
</template>
<style>
:root[data-theme] .text-context-menu button { color:var(--chrome-text); }
.text-context-menu button:disabled { opacity:.4; cursor:default; }
</style>
