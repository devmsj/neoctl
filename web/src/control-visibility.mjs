import { reactive, watch, onBeforeUnmount } from 'vue'
import { authStorageSuffix } from './auth-state.mjs'

export const CONTROL_OPTIONS = [
  { key: 'sessions', label: '会话列表', group: '左侧' },
  { key: 'composer', label: '输入框', group: '对话' },
  { key: 'tasks', label: '后台任务', group: '右侧' },
  { key: 'memory', label: '内存', group: '右侧' },
  { key: 'quota', label: '额度', group: '右侧' },
]
export const defaultControls = () => Object.fromEntries(CONTROL_OPTIONS.map(x => [x.key, true]))
export function normalizeControls(value) {
  const result = defaultControls()
  for (const key of Object.keys(result)) if (typeof value?.[key] === 'boolean') result[key] = value[key]
  return result
}
// Device-local UI preference, scoped per isolated account. Never enters session
// state, model requests, appearance presets or prompt cache keys.
export function useControlVisibility(notify = () => {}) {
  const key = 'neoctl-web.controls.v1' + authStorageSuffix()
  function read() { try { return normalizeControls(JSON.parse(localStorage.getItem(key))) } catch { return defaultControls() } }
  const controls = reactive(read())
  let syncing = false
  const stop = watch(controls, value => {
    if (syncing) return
    try { localStorage.setItem(key, JSON.stringify(value)) } catch { notify('显示设置暂时无法保存') }
  }, { flush: 'sync' })
  function storage(event) {
    if (event.key !== key && event.key !== null) return
    syncing = true; Object.assign(controls, read()); syncing = false
  }
  window.addEventListener('storage', storage)
  onBeforeUnmount(() => { stop(); window.removeEventListener('storage', storage) })
  return { controls, reset: () => Object.assign(controls, defaultControls()) }
}
