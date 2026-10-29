<script setup>
import LoadingRing from './LoadingRing.vue'
import { onBeforeUnmount, ref, watch } from 'vue'
import ChromeIcon from './ChromeIcon.vue'
import { appFetch } from '../app-url.mjs'

const props = defineProps({ endpoint: { type: String, required: true }, confirmDelete: { type: Function, required: true } })
const items = ref([])
const page = ref(1)
const total = ref(0)
const totalPages = ref(1)
const loading = ref(false)
const error = ref('')
const deleting = ref('')
let controller
let generation = 0

async function load(target = page.value) {
  controller?.abort()
  controller = new AbortController()
  const current = ++generation
  loading.value = true
  error.value = ''
  try {
    const url = new URL(props.endpoint, window.location.origin)
    url.searchParams.set('page', String(target))
    url.searchParams.set('pageSize', '10')
    const response = await appFetch(url.pathname + url.search, { signal: controller.signal, cache: 'no-store' })
    const data = await response.json()
    if (current !== generation) return
    if (!response.ok || data.error || !Array.isArray(data.items)) throw new Error('invalid response')
    items.value = data.items
    page.value = data.page
    total.value = data.total
    totalPages.value = data.totalPages
  } catch (cause) {
    if (current === generation && cause?.name !== 'AbortError') error.value = '加载失败，请重试'
  } finally {
    if (current === generation) loading.value = false
  }
}

async function remove(item) {
  if (deleting.value || loading.value) return
  const current = generation, endpoint = props.endpoint
  deleting.value = item.id
  try {
    const confirmed = await props.confirmDelete({ title: '删除建议？', message: `“${item.title}”删除后无法恢复。`, confirmLabel: '删除', tone: 'danger' })
    if (!confirmed || current !== generation || endpoint !== props.endpoint) return
    const url = new URL(endpoint, window.location.origin)
    url.pathname += '/delete'
    const response = await appFetch(url.pathname + url.search, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: item.id }) })
    const data = await response.json()
    if (current !== generation || endpoint !== props.endpoint) return
    if (!response.ok || data.ok !== true) throw new Error('delete failed')
    await load(page.value)
  } catch {
    if (current === generation) error.value = '删除失败，请重试'
  } finally { deleting.value = '' }
}

watch(() => props.endpoint, () => { items.value = []; page.value = 1; total.value = 0; totalPages.value = 1; load(1) }, { immediate: true })
onBeforeUnmount(() => { generation++; controller?.abort() })
</script>

<template>
  <div class="feedback-page" :aria-busy="loading || !!deleting">
    <div class="feedback-toolbar">
      <span>共 {{ total }} 条</span>
      <button type="button" class="mini-button page-icon-button" data-tooltip="刷新" aria-label="刷新" :disabled="loading || !!deleting" @click="load()"><LoadingRing v-if="loading" /><ChromeIcon v-else name="refresh" /></button>
    </div>
    <div v-if="error" class="empty-state" role="alert">{{ error }}</div>
    <div v-if="loading" class="empty-state" role="status" aria-label="正在加载"><LoadingRing /></div>
    <div v-else-if="!items.length" class="empty-state">暂无建议</div>
    <div v-else class="feedback-list">
      <article v-for="item in items" :key="item.id" class="settings-card feedback-item">
        <header class="settings-card-head"><strong>{{ item.title }}</strong><div class="feedback-item-actions"><time :datetime="item.createdAt">{{ new Date(item.createdAt).toLocaleString() }}</time><button type="button" class="mini-button page-icon-button" data-tooltip="删除建议" aria-label="删除建议" :disabled="!!deleting || loading" @click="remove(item)"><LoadingRing v-if="deleting === item.id" /><ChromeIcon v-else name="trash" /></button></div></header>
        <p>{{ item.body }}</p>
      </article>
    </div>
    <nav class="feedback-pagination" aria-label="建议分页">
      <button type="button" class="mini-button page-icon-button" data-tooltip="上一页" aria-label="上一页" :disabled="loading || !!deleting || page <= 1" @click="load(page - 1)"><ChromeIcon name="back" /></button>
      <span>{{ page }} / {{ totalPages }}</span>
      <button type="button" class="mini-button page-icon-button" data-tooltip="下一页" aria-label="下一页" :disabled="loading || !!deleting || page >= totalPages" @click="load(page + 1)"><ChromeIcon name="apply" /></button>
    </nav>
  </div>
</template>

<style scoped>
.feedback-page, .feedback-list { display: grid; gap: 16px; min-width: 0; }
.feedback-toolbar, .feedback-pagination { display: flex; align-items: center; gap: 12px; }
.feedback-toolbar { justify-content: space-between; }
.feedback-pagination { justify-content: center; }
.feedback-item .settings-card-head { flex-wrap: wrap; gap: 8px; }
.feedback-item .feedback-item-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; }
.feedback-item strong, .feedback-item p { overflow-wrap: anywhere; }
.feedback-item time, .feedback-toolbar > span, .feedback-pagination > span { font-size: calc(12px * var(--appearance-ui-scale, 1)); opacity: .7; }
.feedback-item p { margin: 0; padding: 16px; white-space: pre-wrap; line-height: 1.65; }
</style>
