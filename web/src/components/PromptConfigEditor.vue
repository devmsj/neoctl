<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'

const props = defineProps({
  endpoint: { type: String, required: true },
  session: { type: Boolean, default: false },
  runtimePrompt: { type: Object, default: undefined },
})
const emit = defineEmits(['saved'])
const content = ref('')
const savedContent = ref('')
const revision = ref('')
const overridden = ref(false)
const mode = ref('append')
const savedMode = ref('append')
const legacy = ref(false)
const effectiveContent = ref('')
const deferred = ref(false)
const pending = computed(() => props.runtimePrompt?.sessionPrompt ? props.runtimePrompt.sessionPrompt.deferred : deferred.value)
const activePreview = computed(() => props.runtimePrompt?.systemPrompt?.replace('__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__', '') || effectiveContent.value)
const loading = ref(false)
const saving = ref(false)
const loaded = ref(false)
const error = ref('')
let generation = 0
let controller
const dirty = computed(() => content.value !== savedContent.value || (props.session && mode.value !== savedMode.value))
const canSave = computed(() => loaded.value && dirty.value && Boolean(content.value.trim()) && !loading.value && !saving.value)

function errorText(body, fallback) {
  const code = String(body?.errorCode || '')
  if (code.includes('CONFLICT')) return '配置已更新，请重新加载'
  if (code.includes('INVALID')) return '提示词内容无效'
  if (code.includes('TOO_LARGE')) return '提示词内容过长'
  if (code.includes('BUSY')) return '配置忙碌，请稍后重试'
  return fallback
}

function apply(body) {
  if (typeof body?.content !== 'string' || typeof body?.revision !== 'string') throw new Error('invalid payload')
  content.value = body.content
  savedContent.value = body.content
  revision.value = body.revision
  overridden.value = body.override === true
  mode.value = body.mode === "inherit" ? "append" : body.mode || "append"
  savedMode.value = mode.value
  legacy.value = mode.value === "legacy_full_override"
  effectiveContent.value = body.effectiveContent || ""
  deferred.value = body.deferred === true
  loaded.value = true
}

async function load() {
  if (saving.value) return
  controller?.abort()
  controller = new AbortController()
  const current = ++generation
  const endpoint = props.endpoint
  loading.value = true
  error.value = ''
  try {
    const response = await fetch(endpoint, { cache: 'no-store', signal: controller.signal })
    const body = await response.json()
    if (current !== generation || endpoint !== props.endpoint) return
    if (!response.ok || body?.ok === false || body?.error) {
      error.value = errorText(body, '加载失败')
      return
    }
    apply(body)
  } catch (cause) {
    if (current === generation && cause?.name !== 'AbortError') error.value = '加载失败'
  } finally {
    if (current === generation) loading.value = false
  }
}

async function save(reset = false) {
  if (saving.value || loading.value || !loaded.value || (!reset && !canSave.value)) return
  if (!reset && legacy.value && mode.value !== 'legacy_full_override' && !window.confirm('转换后将重新合成全局和工具上下文。请确认编辑框只保留你需要的自定义指令，避免重复注入旧内容。')) return
  const current = generation
  const endpoint = props.endpoint
  saving.value = true
  error.value = ''
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(reset ? { reset: true, revision: revision.value } : { content: content.value, revision: revision.value, ...(props.session ? { mode: mode.value } : {}) }),
      signal: controller?.signal,
    })
    const body = await response.json()
    if (current !== generation || endpoint !== props.endpoint) return
    if (!response.ok || body?.ok === false || body?.error) {
      error.value = errorText(body, '保存失败')
      return
    }
    apply(body)
    emit('saved', body)
  } catch (cause) {
    if (current === generation && cause?.name !== 'AbortError') error.value = '保存失败'
  } finally {
    if (current === generation) saving.value = false
  }
}

watch(() => props.endpoint, () => {
  generation += 1
  controller?.abort()
  content.value = ''
  savedContent.value = ''
  revision.value = ''
  loaded.value = false
  saving.value = false
  overridden.value = false
  mode.value = savedMode.value = 'append'
  legacy.value = false
  effectiveContent.value = ''
  deferred.value = false
  void load()
}, { immediate: true })
onBeforeUnmount(() => { generation += 1; controller?.abort() })
</script>

<template>
  <form class="prompt-config-editor" :aria-busy="loading || saving" @submit.prevent="save()">
    <div class="prompt-config-toolbar">
      <span class="prompt-config-scope">{{ session ? '当前会话' : '系统提示词' }}</span>
      <div class="prompt-config-actions">
        <button type="button" class="mini-button" :disabled="loading || saving" @click="load">重新加载</button>
        <button v-if="session" type="button" class="mini-button" :disabled="!loaded || !overridden || loading || saving" @click="save(true)">恢复默认</button>
        <button type="submit" class="primary" :disabled="!canSave">{{ saving ? '保存中' : '保存' }}</button>
      </div>
    </div>
    <template v-if="session && loaded">
      <label class="prompt-config-mode">会话指令模式
        <select v-model="mode" aria-label="会话指令模式" :disabled="loading || saving">
          <option value="append">继承全局并追加</option>
          <option value="replace_base">仅替换全局正文（保留工具和插件上下文）</option>
          <option v-if="legacy" value="legacy_full_override">旧版完整覆盖（不继承）</option>
        </select>
      </label>
      <p class="prompt-config-note">{{ overridden ? '已配置会话指令' : '当前继承全局；下方仅编辑会话追加指令' }}。工具开关只更新运行时能力说明，不改写自定义文本。</p>
      <p v-if="legacy" class="prompt-config-note" role="status">旧版完整覆盖保留了原文，可能包含过期的工具说明。请手动保留自定义指令并切换模式，或恢复默认；不会自动删改旧内容。</p>
    </template>
    <div v-if="loading && !loaded" class="runtime-context-empty" role="status">加载中</div>
    <textarea
      v-else
      v-model="content"
      class="prompt-config-textarea"
      aria-label="系统提示词"
      :disabled="!loaded || loading || saving"
      spellcheck="false"
      autocomplete="off"
      rows="18"
      @keydown.ctrl.enter.prevent="save()"
      @keydown.meta.enter.prevent="save()"
    ></textarea>
    <details v-if="session && loaded" class="prompt-config-preview">
      <summary>当前有效上下文（只读）{{ runtimePrompt?.sessionPrompt?.deferred ? ' · 有待生效修改' : '' }}</summary>
      <pre>{{ activePreview }}</pre>
    </details>
    <details v-if="session && pending" class="prompt-config-preview">
      <summary>已保存配置的合成预览（下一轮生效）</summary>
      <pre>{{ effectiveContent }}</pre>
    </details>
    <div v-if="error" class="prompt-config-error" role="alert">{{ error }}</div>
  </form>
</template>

<style scoped>
.prompt-config-mode { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.prompt-config-mode select { max-width: 100%; min-width: 0; padding: 6px; color: inherit; background: var(--bg, Canvas); border: 1px solid var(--border, #888); border-radius: 6px; }
.prompt-config-note { margin: 0; font-size: 12px; line-height: 1.6; opacity: .8; }
.prompt-config-preview { min-width: 0; max-width: 100%; }
.prompt-config-preview summary { cursor: pointer; font-size: 13px; }
.prompt-config-preview pre { max-height: 360px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; }
</style>
