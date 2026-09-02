<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'

const props = defineProps({
  modelValue: { default: '' },
  options: { type: Array, default: () => [] },
  disabled: { type: Boolean, default: false },
  ariaLabel: { type: String, default: '请选择' },
})

const emit = defineEmits(['update:modelValue', 'change'])
const root = ref(null)
const menu = ref(null)
const open = ref(false)
const menuId = `neo-select-${Math.random().toString(36).slice(2, 10)}`

const normalizedOptions = computed(() => props.options.map((option, index) => {
  if (option && typeof option === 'object' && !Array.isArray(option)) {
    return {
      value: Object.prototype.hasOwnProperty.call(option, 'value') ? option.value : option.label,
      label: String(option.label ?? option.value ?? ''),
      disabled: option.disabled === true,
      key: String(option.key ?? option.value ?? index),
    }
  }
  return { value: option, label: String(option ?? ''), disabled: false, key: `${String(option)}-${index}` }
}))

const selectedOption = computed(() => normalizedOptions.value.find((option) => Object.is(option.value, props.modelValue)))
const selectedLabel = computed(() => selectedOption.value?.label || '请选择')

function closeMenu() {
  open.value = false
}

async function openMenu(focusLast = false) {
  if (props.disabled || open.value) return
  open.value = true
  await nextTick()
  const buttons = [...(menu.value?.querySelectorAll('button:not(:disabled)') || [])]
  const selected = menu.value?.querySelector('button[aria-selected="true"]')
  const target = selected || (focusLast ? buttons.at(-1) : buttons[0])
  target?.focus()
}

function toggleMenu() {
  if (open.value) closeMenu()
  else void openMenu()
}

function selectOption(option) {
  if (option.disabled) return
  closeMenu()
  if (!Object.is(option.value, props.modelValue)) {
    emit('update:modelValue', option.value)
    emit('change', option.value)
  }
  nextTick(() => root.value?.querySelector('.neo-select-trigger')?.focus())
}

function handleTriggerKeydown(event) {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    void openMenu(event.key === 'ArrowUp')
  }
  if (event.key === 'Escape' && open.value) {
    event.preventDefault()
    event.stopPropagation()
    closeMenu()
  }
}

function moveMenuFocus(event, direction) {
  const buttons = [...(menu.value?.querySelectorAll('button:not(:disabled)') || [])]
  if (!buttons.length) return
  const current = buttons.indexOf(document.activeElement)
  const index = direction === 'start'
    ? 0
    : direction === 'end'
      ? buttons.length - 1
      : (current + direction + buttons.length) % buttons.length
  event.preventDefault()
  buttons[index]?.focus()
}

function handleMenuKeydown(event) {
  if (event.key === 'ArrowDown') moveMenuFocus(event, 1)
  else if (event.key === 'ArrowUp') moveMenuFocus(event, -1)
  else if (event.key === 'Home') moveMenuFocus(event, 'start')
  else if (event.key === 'End') moveMenuFocus(event, 'end')
  else if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    closeMenu()
    nextTick(() => root.value?.querySelector('.neo-select-trigger')?.focus())
  } else if (event.key === 'Tab') closeMenu()
}

function handleOutsidePointer(event) {
  if (open.value && !root.value?.contains(event.target)) closeMenu()
}

onMounted(() => document.addEventListener('pointerdown', handleOutsidePointer))
onBeforeUnmount(() => document.removeEventListener('pointerdown', handleOutsidePointer))
</script>

<template>
  <span ref="root" class="neo-select" :class="{ open, disabled }">
    <button
      type="button"
      class="neo-select-trigger"
      :disabled="disabled"
      :aria-label="ariaLabel"
      aria-haspopup="listbox"
      :aria-expanded="open"
      :aria-controls="menuId"
      @click="toggleMenu"
      @keydown="handleTriggerKeydown"
    >
      <span>{{ selectedLabel }}</span>
    </button>
    <span
      v-if="open"
      :id="menuId"
      ref="menu"
      class="neo-select-menu"
      role="listbox"
      :aria-label="ariaLabel"
      @keydown="handleMenuKeydown"
    >
      <button
        v-for="option in normalizedOptions"
        :key="option.key"
        type="button"
        role="option"
        :disabled="option.disabled"
        :class="{ selected: Object.is(option.value, modelValue) }"
        :aria-selected="Object.is(option.value, modelValue)"
        @click="selectOption(option)"
      >
        {{ option.label }}
      </button>
    </span>
  </span>
</template>

<style scoped>
.neo-select {
  position: relative;
  z-index: 0;
  width: 100%;
  min-width: 0;
  display: block;
  box-sizing: border-box;
  border: 1px solid var(--line);
  background: var(--surface);
  font-weight: 400;
  transition: border-color .14s ease, box-shadow .14s ease, background .14s ease;
}
.neo-select:hover:not(.disabled),
.neo-select.open { border-color: color-mix(in srgb, var(--purple) 55%, var(--line)); }
.neo-select:focus-within,
.neo-select.open {
  z-index: 40;
  border-color: var(--purple);
  background: color-mix(in srgb, var(--purple-soft) 22%, var(--surface));
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--purple) 12%, transparent);
}
.neo-select.disabled {
  opacity: .46;
  background: var(--panel-soft);
}
.neo-select[data-mode='enabled'] {
  border-color: color-mix(in srgb, var(--purple) 42%, var(--line));
  background: color-mix(in srgb, var(--purple-soft) 30%, var(--surface));
}
.neo-select-trigger {
  position: relative;
  width: 100%;
  min-height: 40px;
  display: flex;
  align-items: center;
  border: 0;
  outline: 0;
  padding: 0 38px 0 12px;
  background: transparent;
  color: var(--text);
  font: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}
.neo-select-trigger > span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 400;
}
.neo-select-trigger::after {
  content: '';
  position: absolute;
  top: 50%;
  right: 14px;
  width: 6px;
  height: 6px;
  border-right: 1.5px solid currentColor;
  border-bottom: 1.5px solid currentColor;
  color: var(--muted);
  transform: translateY(-68%) rotate(45deg);
  transition: color .14s ease, transform .14s ease;
}
.neo-select:focus-within .neo-select-trigger::after,
.neo-select.open .neo-select-trigger::after {
  color: var(--purple);
  transform: translateY(-28%) rotate(225deg);
}
.neo-select-trigger:disabled { cursor: not-allowed; }
.neo-select-menu {
  position: absolute;
  top: calc(100% + 7px);
  left: -1px;
  z-index: 50;
  width: calc(100% + 2px);
  max-height: min(280px, 44vh);
  display: grid;
  gap: 2px;
  box-sizing: border-box;
  overflow: auto;
  padding: 5px;
  border: 1px solid color-mix(in srgb, var(--purple) 42%, var(--line));
  background: var(--surface-raised);
  box-shadow: 0 14px 34px rgba(0, 0, 0, .18), 0 0 0 1px color-mix(in srgb, var(--purple) 6%, transparent);
  animation: neo-select-menu-enter .14s cubic-bezier(.2, .72, .2, 1) both;
}
.neo-select-menu button {
  position: relative;
  min-height: 34px;
  border: 0;
  padding: 0 30px 0 10px;
  background: transparent;
  color: var(--muted);
  font: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}
.neo-select-menu button:hover:not(:disabled),
.neo-select-menu button:focus-visible {
  outline: 0;
  background: var(--purple-soft);
  color: var(--purple);
}
.neo-select-menu button.selected { color: var(--text); font-weight: 600; }
.neo-select-menu button.selected::after {
  content: '';
  position: absolute;
  top: 50%;
  right: 12px;
  width: 8px;
  height: 4px;
  border-left: 1.5px solid var(--purple);
  border-bottom: 1.5px solid var(--purple);
  transform: translateY(-65%) rotate(-45deg);
}
.neo-select-menu button:disabled { opacity: .4; cursor: not-allowed; }
@keyframes neo-select-menu-enter {
  from { opacity: 0; transform: translateY(-5px) scale(.98); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
</style>
