<script setup>
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { acceptsPreview, contentUrl, contentViews, defaultContentView, emptyContent, isRunning, mergeContent, sameIdentity, validIdentity } from './agent-content-reader.mjs'

const props = defineProps({
  ownerSessionId: { type: String, required: true },
  taskId: { type: String, required: true },
  runGeneration: { type: Number, required: true },
  status: { type: String, required: true },
  compact: Boolean,
  view: { type: String, validator: value => contentViews.includes(value) },
  // Host must use its existing sanitizeMarkdown(marked.parse(text)) pipeline.
  renderMarkdown: Function,
  // Host binds this already-redacted event projection to the same owner/task atomically.
  visiblePreview: Object,
})
const labels = { delegation: '任务', timeline: '过程', report: '报告', messages: '消息' }
const views = computed(() => props.compact ? ['report', 'messages'] : contentViews)
const initialView = () => props.view || (props.compact ? 'report' : defaultContentView(props.status))
const selected = ref(initialView())
const state = reactive({ content: emptyContent(), loading: false, error: '', notice: '' })
const readerBody = ref(null)
const follow = ref(false)
let requestEpoch = 0, controller, timer, disposed = false
const identity = () => ({ ownerSessionId: props.ownerSessionId, taskId: props.taskId, runGeneration: props.runGeneration })
const page = computed(() => state.content.page)
const preview = computed(() => acceptsPreview(props.visiblePreview, identity()) ? props.visiblePreview : null)
const messageItems = computed(() => {
  if (selected.value !== 'messages' || state.content.fragment?.hasMore) return []
  try { const items = JSON.parse(state.content.fragment?.text || '[]'); return Array.isArray(items) ? items.filter(item => typeof item.text === 'string' && item.text.trim()) : [] } catch { return [] }
})
const errorText = computed(() => state.error ? (/HTTP (\d+)/.exec(state.error)?.[1] ? '加载失败' : '内容不可用') : '')
const scalarText = computed(() => state.content.fragment?.text ?? '')
const preStyle = { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', minWidth: '0', maxWidth: '100%' }
const token = () => ({ ...identity(), view: selected.value, epoch: requestEpoch, signal: controller.signal })
const current = t => !disposed && !t.signal.aborted && t.epoch === requestEpoch && t.view === selected.value && sameIdentity(t, identity())
function invalidate() { requestEpoch++; controller?.abort(); controller = new AbortController(); clearTimeout(timer) }
function markdown(text) {
  // No second parser/sanitizer. Only the trusted host callback may produce HTML.
  try { return props.renderMarkdown?.(text) ?? '' } catch { return '' }
}
function schedule() {
  clearTimeout(timer)
  if (!disposed && ['timeline', 'report', 'messages'].includes(selected.value) && isRunning(props.status) && validIdentity(identity()) && !state.error) {
    timer = setTimeout(() => load(page.value?.nextCursor ? 'next' : page.value?.refreshCursor ? 'refresh' : 'start'), 3000)
  }
}
async function readPage(t, mode) {
  const prior = state.content
  const cursor = mode === 'next' ? prior.page?.nextCursor : mode === 'refresh' ? prior.page?.refreshCursor : undefined
  if (mode !== 'start' && !cursor) throw new Error('未提供继续读取游标，请重新读取')
  const response = await fetch(contentUrl(t, t.view, cursor, mode === 'refresh'), { method: 'GET', signal: t.signal, cache: 'no-store' })
  if (!current(t)) return false
  if (!response.ok) throw new Error(`内容读取失败（HTTP ${response.status}），可重试`)
  const data = await response.json()
  if (!current(t)) return false
  const merged = mergeContent(prior, data, t, t.view, mode)
  if (cursor && data.nextCursor === cursor) throw new Error('继续游标未推进，请重新读取')
  state.content = merged
  if (data.state === 'unavailable') throw new Error(data.reason || '内容不可获取，可重新读取')
  // An empty partial scan is real pagination progress, not proof of no visible output.
  state.notice = ''
  if (follow.value && t.view === 'timeline') {
    await nextTick()
    if (!current(t)) return false
    if (follow.value && readerBody.value) readerBody.value.scrollTop = readerBody.value.scrollHeight
  }
  return true
}
async function load(mode = 'start', all = false) {
  if (state.loading || !validIdentity(identity())) return
  clearTimeout(timer)
  const t = token()
  state.loading = true; state.error = ''; state.notice = ''
  try {
    if (mode === 'start' && !page.value) state.content = emptyContent()
    do {
      const accepted = await readPage(t, mode)
      if (!current(t) || !accepted) return
      if ((!all && selected.value !== 'messages' && !(t.view === 'timeline' && !state.content.items.length)) || !page.value?.nextCursor) break
      mode = 'next'
    } while (current(t))
  } catch (error) { if (current(t) && error.name !== 'AbortError') state.error = error.message || '内容读取失败，可重试' }
  finally { if (current(t)) { state.loading = false; schedule() } }
}
function reset() {
  invalidate(); state.content = emptyContent(); state.loading = false; state.error = ''; state.notice = ''; follow.value = false
  if (!validIdentity(identity())) { state.error = '所属会话、任务或轮次未提供；旧记录不会推断为当前轮次'; return }
  void load()
}
function cancel() {
  invalidate(); state.loading = false; state.notice = '已取消'
}
function selectView(view) { selected.value = view }
function onScroll() {
  const el = readerBody.value
  if (el && el.scrollHeight - el.scrollTop - el.clientHeight > 24) follow.value = false
}
// Batch the parent's prop patch: sync watchers can combine the new taskId with
// the previous runGeneration and issue a request for an identity that never existed.
// current() also checks live props after every await, so batching cannot accept old data.
watch(() => [props.ownerSessionId, props.taskId, props.runGeneration], () => {
  selected.value = initialView()
  reset()
}, { immediate: true, flush: 'pre' })
watch(() => props.view, value => { if (contentViews.includes(value)) selected.value = value })
watch(selected, reset)
watch(() => props.status, () => {
  // Do not move a user's reading position/tab on a lifecycle update. Identity changes
  // select the appropriate default; a drained timeline gets one final terminal read.
  if (!state.loading && !state.error) void load(page.value?.nextCursor ? 'next' : page.value?.refreshCursor ? 'refresh' : 'start')
  else schedule()
})
onBeforeUnmount(() => { disposed = true; invalidate() })
</script>

<template>
  <section class="agent-content-reader" aria-label="子代理内容">
    <div class="agent-reader-toolbar">
      <nav class="agent-reader-tabs" aria-label="子代理内容视图">
        <button v-for="viewName in views" :key="viewName" type="button" :aria-pressed="selected === viewName" @click="selectView(viewName)">{{ labels[viewName] }}</button>
      </nav>
    </div>
    <p v-if="state.loading" class="reader-state" role="status">加载中…</p>
    <p v-if="errorText" class="reader-error" role="alert">{{ errorText }}</p>
    <p v-if="state.notice && !state.loading" class="reader-state" role="status">{{ state.notice }}</p>
    <div ref="readerBody" class="agent-reader-body" tabindex="0" aria-label="子代理内容阅读区" @scroll="onScroll">
      <section v-if="selected === 'report'" class="agent-report-content">
        <p v-if="page?.report?.reportStatus === 'incomplete'" class="reader-state">未完成</p>
        <pre v-if="page?.report?.error?.text" class="reader-error" :style="preStyle">{{ page.report.error.text }}</pre>
        <div v-if="scalarText && renderMarkdown" class="markdown agent-report-body" v-html="markdown(scalarText)"></div>
        <pre v-else-if="scalarText" class="agent-plain-content" :style="preStyle">{{ scalarText }}</pre>
      </section>
      <section v-else-if="selected === 'messages'" class="agent-parent-messages">
        <article v-for="item in messageItems" :key="item.id" class="agent-parent-message">
          <header><strong>主代理</strong></header>
          <div v-if="item.text && renderMarkdown" class="markdown" v-html="markdown(item.text)"></div>
          <pre v-else class="agent-plain-content" :style="preStyle">{{ item.text }}</pre>
        </article>
      </section>
      <section v-else-if="selected === 'delegation'">
        <div v-if="scalarText && renderMarkdown" class="markdown" v-html="markdown(scalarText)"></div>
        <pre v-else-if="scalarText" class="agent-plain-content" :style="preStyle">{{ scalarText }}</pre>
      </section>
      <section v-else class="agent-timeline-content">
        <article v-for="item in state.content.items" :key="item.id" class="agent-timeline-item">
          <template v-if="item.kind === 'assistant'">
            <div v-if="renderMarkdown" class="markdown" v-html="markdown(item.content.text)"></div>
            <pre v-else class="agent-plain-content" :style="preStyle">{{ item.content.text }}</pre>
          </template>
          <details v-else class="agent-tool-record">
            <summary><span>{{ item.toolName }}</span><span v-if="item.status === 'failed'" class="tool-result-failure-mark" aria-label="执行失败">×</span></summary>
            <pre :style="preStyle">{{ item.content.text }}</pre>
          </details>
        </article>
        <div v-if="preview?.text && isRunning(status)" class="agent-live-content">
          <div v-if="renderMarkdown" class="markdown" v-html="markdown(preview.text)"></div>
          <pre v-else class="agent-plain-content" :style="preStyle">{{ preview.text }}</pre>
        </div>
      </section>
    </div>
    <p v-if="state.content.fragment?.state === 'truncated'" class="reader-state">已截断</p>
    <div v-if="page?.nextCursor || state.loading" class="reader-actions reader-footer">
      <button v-if="page?.nextCursor" type="button" :disabled="state.loading || !!state.error" @click="load('next', true)">加载更多</button>
      <button v-if="state.loading" type="button" @click="cancel">取消</button>
    </div>
  </section>
</template>
