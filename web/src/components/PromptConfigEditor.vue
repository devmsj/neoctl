<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'

const props = defineProps({
  endpoint: { type: String, required: true },
  session: { type: Boolean, default: false },
})
const emit = defineEmits(['saved'])
const content = ref('')
const savedContent = ref('')
const revision = ref('')
const overridden = ref(false)
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
  const current = generation
  const endpoint = props.endpoint
  saving.value = true
  error.value = ''
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(reset ? { reset: true, revision: revision.value } : { content: content.value, revision: revision.value }),
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
    <div v-if="error" class="prompt-config-error" role="alert">{{ error }}</div>
  </form>
</template>
