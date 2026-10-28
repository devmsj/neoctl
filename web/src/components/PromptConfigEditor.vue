<script setup>
import ChromeIcon from './ChromeIcon.vue'
import SettingsSaveButton from './SettingsSaveButton.vue'
import { appFetch } from '../app-url.mjs'
import { computed, onBeforeUnmount, ref, watch } from 'vue'

const props = defineProps({
  endpoint: { type: String, required: true },
  session: { type: Boolean, default: false },
  runtimePrompt: { type: Object, default: undefined },
})
const emit = defineEmits(['saved'])
const editorId = 'prompt-editor-' + Math.random().toString(36).slice(2, 10)
const content = ref('')
const savedContent = ref('')
const revision = ref('')
const overridden = ref(false)
const mode = ref('append')
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
const dirty = computed(() => content.value !== savedContent.value)
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
    const response = await appFetch(endpoint, { cache: 'no-store', signal: controller.signal })
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
  const current = generation
  const endpoint = props.endpoint
  saving.value = true
  error.value = ''
  try {
    const response = await appFetch(endpoint, {
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
  mode.value = 'append'
  legacy.value = false
  effectiveContent.value = ''
  deferred.value = false
  void load()
}, { immediate: true })
onBeforeUnmount(() => { generation += 1; controller?.abort() })
</script>

<template>
  <form class="prompt-config-editor" :aria-busy="loading || saving" @submit.prevent="save()">
    <section class="prompt-edit-region" :aria-label="session ? '可编辑的会话指令' : '可编辑的系统提示词'">
      <div class="prompt-config-toolbar">
        <label class="prompt-config-scope" :for="editorId"><ChromeIcon name="edit" /><strong>{{ session ? (legacy ? '历史会话指令' : '会话指令') : '系统提示词' }}</strong></label>
        <div class="prompt-config-actions">
          <span v-if="dirty" class="prompt-draft-mark" role="status" data-tooltip="未保存" aria-label="未保存"></span>
          <button type="button" class="mini-button" data-tooltip="重新加载" aria-label="重新加载" :disabled="loading || saving" @click="load"><ChromeIcon name="refresh" /></button>
          <button v-if="session" type="button" class="mini-button" data-tooltip="恢复默认" aria-label="恢复默认" :disabled="!loaded || !overridden || loading || saving" @click="save(true)"><ChromeIcon name="undo" /></button>
          <SettingsSaveButton :busy="saving" :disabled="!canSave" />
        </div>
      </div>
      <div v-if="loading && !loaded" class="runtime-context-empty" role="status">加载中</div>
      <textarea v-else :id="editorId" v-model="content" class="prompt-config-textarea"
        :aria-label="session ? '会话指令' : '系统提示词'" :disabled="!loaded || loading || saving"
        spellcheck="false" autocomplete="off" rows="10"
        @keydown.ctrl.enter.prevent="save()" @keydown.meta.enter.prevent="save()"></textarea>
    </section>
    <section v-if="session && loaded" class="prompt-readonly-region" aria-label="只读的生效上下文">
      <details class="prompt-config-preview" open>
        <summary class="prompt-readonly-heading"><ChromeIcon name="chevron" /><strong>生效上下文</strong><span class="prompt-access-label">只读</span><span v-if="pending" class="prompt-pending" role="status" data-tooltip="修改将在下一轮生效" aria-label="修改将在下一轮生效"><ChromeIcon name="clock" /></span></summary>
        <pre tabindex="0" aria-label="生效上下文，只读">{{ activePreview || '—' }}</pre>
      </details>
      <details v-if="pending" class="prompt-config-preview">
        <summary><ChromeIcon name="chevron" /><span>下一轮预览</span></summary>
        <pre tabindex="0" aria-label="下一轮上下文，只读">{{ effectiveContent }}</pre>
      </details>
    </section>
    <div v-if="error" class="prompt-config-error" role="alert">{{ error }}</div>
  </form>
</template>
