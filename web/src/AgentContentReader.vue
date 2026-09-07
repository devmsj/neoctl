<script setup>
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { acceptsPreview, canExportFull, contentText, contentUrl, contentViews, defaultContentView, emptyContent, exportScope, isRunning, mergeContent, partLabel, sameIdentity, validIdentity } from './agent-content-reader.mjs'

const props = defineProps({
  ownerSessionId: { type: String, required: true },
  taskId: { type: String, required: true },
  runGeneration: { type: Number, required: true },
  status: { type: String, required: true },
  view: { type: String, validator: value => contentViews.includes(value) },
  // Host must use its existing sanitizeMarkdown(marked.parse(text)) pipeline.
  renderMarkdown: Function,
  // Host binds this already-redacted event projection to the same owner/task atomically.
  visiblePreview: Object,
})
const labels = { delegation: '脱敏委派', timeline: '正文与完整过程', report: '指定轮次报告' }
const selected = ref(props.view || defaultContentView(props.status))
const state = reactive({ content: emptyContent(), loading: false, error: '', notice: '' })
const readerBody = ref(null)
const follow = ref(false)
let requestEpoch = 0, controller, timer, disposed = false
const identity = () => ({ ownerSessionId: props.ownerSessionId, taskId: props.taskId, runGeneration: props.runGeneration })
const page = computed(() => state.content.page)
const preview = computed(() => acceptsPreview(props.visiblePreview, identity()) ? props.visiblePreview : null)
const assistantItems = computed(() => state.content.items.filter(item => item.kind === 'assistant'))
const scalarText = computed(() => state.content.fragment?.text ?? '')
const scope = computed(() => exportScope(state.content, selected.value))
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
  if (!disposed && selected.value === 'timeline' && isRunning(props.status) && validIdentity(identity()) && !state.error) {
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
  if (data.state === 'partial' && t.view === 'timeline' && !data.items?.length) state.notice = '扫描已推进；本页没有获准展示条目，仍有后续记录。'
  else state.notice = ''
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
    if (mode === 'start') state.content = emptyContent()
    do {
      const accepted = await readPage(t, mode)
      if (!current(t) || !accepted) return
      if (!all || !page.value?.nextCursor) break
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
function restart() { reset() }
function cancel() {
  invalidate(); state.loading = false; state.notice = '已取消只读加载，保留已加载预览；未执行任务控制。'
}
function selectView(view) { selected.value = view }
function onScroll() {
  const el = readerBody.value
  if (el && el.scrollHeight - el.scrollTop - el.clientHeight > 24) follow.value = false
}
async function exportContent(download, full) {
  if (state.loading || !page.value) return
  clearTimeout(timer)
  const t = token()
  state.loading = true; state.error = ''; state.notice = ''
  try {
    if (full) {
      while (page.value?.nextCursor) {
        const accepted = await readPage(t, 'next')
        if (!current(t) || !accepted) return
      }
      if (!canExportFull(state.content, t.view) || !exportScope(state.content, t.view).includes('全文') || exportScope(state.content, t.view).includes('非全文')) throw new Error('源已截断、缺失或仍有未提交记录；不能导出全文，请使用预览操作')
    }
    if (!current(t)) return
    const label = full ? exportScope(state.content, t.view) : '已加载预览（非全文）'
    const report = page.value.report
    const facts = report ? `\n任务状态：${report.taskStatus}；报告标记：${report.reportStatus || '未提供'}\n错误：${report.error?.text || report.error?.reason || '未提供'}` : ''
    const text = `${label}\n所属会话：${t.ownerSessionId}；任务：${t.taskId}；轮次：${t.runGeneration}${facts}\n\n${contentText(state.content, t.view)}`
    if (download) {
      const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }))
      const a = document.createElement('a')
      a.href = url; a.download = `agent-${t.taskId.replace(/[^a-zA-Z0-9_-]/g, '_')}-run-${t.runGeneration}-${t.view}-${full ? 'saved-full' : 'preview'}.txt`
      a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
    } else {
      await navigator.clipboard.writeText(text)
      if (!current(t)) return
    }
    state.notice = `${download ? '已下载' : '已复制'}：${label}`
  } catch (error) { if (current(t) && error.name !== 'AbortError') state.error = error.message || '复制或下载失败，可重试' }
  finally { if (current(t)) { state.loading = false; schedule() } }
}
// Batch the parent's prop patch: sync watchers can combine the new taskId with
// the previous runGeneration and issue a request for an identity that never existed.
// current() also checks live props after every await, so batching cannot accept old data.
watch(() => [props.ownerSessionId, props.taskId, props.runGeneration], () => {
  selected.value = props.view || defaultContentView(props.status)
  reset()
}, { immediate: true, flush: 'pre' })
watch(() => props.view, value => { if (contentViews.includes(value)) selected.value = value })
watch(selected, reset)
watch(() => props.status, () => {
  // Do not move a user's reading position/tab on a lifecycle update. Identity changes
  // select the appropriate default; a drained timeline gets one final terminal read.
  if (!state.loading && selected.value === 'timeline' && !state.error) void load(page.value?.nextCursor ? 'next' : page.value?.refreshCursor ? 'refresh' : 'start')
  else schedule()
})
onBeforeUnmount(() => { disposed = true; invalidate() })
</script>

<template>
  <section class="background-task-output-section agent-content-reader" aria-label="子代理只读内容" style="min-width: 0; max-width: 100%; overflow-wrap: anywhere;">
    <div class="background-task-output-head"><strong>子代理内容 · 第 {{ runGeneration ?? '未知' }} 轮</strong></div>
    <p class="background-task-help">任务：{{ taskId || '未提供' }} · 任务状态：{{ status || '未知' }}。仅只读加载，不调用模型、不续跑、不发送消息。</p>
    <nav aria-label="子代理内容视图" style="display: flex; flex-wrap: wrap; gap: 8px;">
      <button v-for="viewName in contentViews" :key="viewName" type="button" :aria-pressed="selected === viewName" @click="selectView(viewName)">{{ labels[viewName] }}</button>
    </nav>
    <p v-if="state.loading" role="status">正在加载指定轮次内容…</p>
    <p v-if="state.error" role="alert">{{ state.error }}；已显示内容仅为此前读取的预览。</p>
    <p v-if="state.notice" role="status">{{ state.notice }}</p>
    <p v-if="page">{{ page.state === 'partial' ? '分页加载中，当前为预览' : page.state === 'missing' ? '指定内容缺失' : page.state === 'unavailable' ? '指定内容不可获取' : '已读完当前保存快照' }} · {{ page.reason }}</p>
    <p v-if="page?.pendingTail">末尾记录尚未提交完整行，等待只读刷新；不代表任务无进度。</p>
    <div ref="readerBody" class="background-task-log-stack" style="min-width: 0; max-width: 100%; max-height: 60vh; overflow: auto; overflow-wrap: anywhere;" tabindex="0" aria-label="子代理内容阅读区" @scroll="onScroll">
      <section v-if="selected === 'delegation'" class="background-task-command-section">
        <h4>任务级脱敏委派（scope=task）</h4>
        <p>仅原始任务委派范围；不是指定轮次的 resume 指令，不含父上下文、继承消息或待投递消息。</p>
        <template v-if="page?.delegation">
          <p>说明：{{ page.delegation.description.text || page.delegation.description.reason }}（{{ partLabel(page.delegation.description) }}）</p>
          <pre class="background-task-command" :style="preStyle">{{ scalarText }}</pre>
          <p>{{ partLabel(state.content.fragment) }} · 已加载 {{ scalarText.length }} / {{ state.content.fragment?.totalChars }} 字符</p>
        </template>
      </section>
      <section v-else-if="selected === 'timeline'" class="background-task-progress-section">
        <h4>实时可展示正文预览</h4>
        <template v-if="preview">
          <pre class="background-task-activity" :style="preStyle">{{ preview.text }}</pre>
          <p>{{ preview.truncated ? '实时预览已截断，不是全文' : '实时事件预览，不保证已落盘，不是全文' }}；不与下方保存过程合并，不用于全文导出。</p>
        </template>
        <p v-else>没有获准的实时可展示正文；旧记录无通道或通道未知时不展示正文，不使用技术日志或 lastText 替代。</p>
        <h4>当前轮已保存可展示正文</h4>
        <p v-if="!assistantItems.length">{{ page?.nextCursor ? '已加载范围暂未发现可展示正文；仍需继续扫描，不能判定整轮没有正文。' : '当前快照没有可展示正文；未知或未记录通道不作为正文。' }}</p>
        <div v-for="item in assistantItems" :key="item.id" style="min-width: 0; overflow: auto;">
          <div v-if="renderMarkdown" class="markdown-body" v-html="markdown(item.content.text)"></div>
          <pre v-else class="background-task-activity" :style="preStyle">{{ item.content.text }}</pre>
          <p>{{ partLabel(item.content) }} · {{ item.content.text.length }} / {{ item.content.totalChars }} 字符</p>
        </div>
        <h4>完整过程 · 按记录顺序分页（从较早记录读取）</h4>
        <p>以下仅获准正文与真实工具记录；invoked 表示已调用，不证明仍在运行。快照读完不代表任务完成。</p>
        <article v-for="item in state.content.items" :key="item.id" class="background-task-output-section" style="min-width: 0;">
          <strong>{{ item.kind === 'assistant' ? '可展示正文' : item.kind === 'tool_use' ? '工具调用' : '工具结果' }} {{ item.toolName || '' }}</strong>
          <p>记录 {{ item.id }} · {{ item.createdAt || '时间未提供' }}</p>
          <template v-if="item.kind !== 'assistant'">
            <p>调用 ID：{{ item.toolUseId || '未提供' }} · 调用状态：{{ item.status || 'unknown' }}</p>
            <p v-if="item.kind === 'tool_use'">实际对象：{{ item.object?.text || item.object?.reason || '未提供' }}（{{ partLabel(item.object) }}）</p>
            <p v-else>结果摘要（当前已加载前 240 字符，非全文）：{{ item.content.text.slice(0, 240) || item.content.reason }}</p>
          </template>
          <details>
            <summary>{{ item.kind === 'assistant' ? '正文原文' : item.kind === 'tool_use' ? '脱敏调用参数' : '结果内容' }} · 已加载 {{ item.content.text.length }} / {{ item.content.totalChars }} 字符 · {{ partLabel(item.content) }}{{ item.content.hasMore ? ' · 单条尚未读完' : '' }}</summary>
            <pre class="background-task-activity" :style="preStyle">{{ item.content.text }}</pre>
          </details>
        </article>
      </section>
      <section v-else class="background-task-result-section">
        <h4>第 {{ runGeneration }} 轮报告</h4>
        <template v-if="page?.report">
          <p>来源：{{ page.report.source }} · 该轮任务状态：{{ page.report.taskStatus }} · 报告完成标记：{{ page.report.reportStatus || '未提供（不默认完成）' }}</p>
          <p v-if="page.report.taskStatus === 'failed' || page.report.taskStatus === 'killed' || page.report.reportStatus === 'incomplete'">失败、停止或未完成报告：可读取已保存内容，不等于任务成功或报告已完成。</p>
          <p>错误：{{ page.report.error?.text || page.report.error?.reason || '未提供错误原因' }}（{{ partLabel(page.report.error) }}）</p>
          <p>{{ partLabel(state.content.fragment) }} · 已加载 {{ scalarText.length }} / {{ state.content.fragment?.totalChars }} 字符</p>
          <p v-if="state.content.fragment?.state === 'missing'">指定轮次尚无已保存报告；不会回退其他轮次，也不会启动模型获取。</p>
          <p v-else-if="state.content.fragment?.totalChars === 0">已保存报告正文为空（不是加载失败或报告缺失）。</p>
          <div v-if="renderMarkdown" class="markdown-body" style="min-width: 0; max-width: 100%; overflow: auto;" v-html="markdown(scalarText)"></div>
          <pre v-else class="background-task-activity background-task-result" :style="preStyle">{{ scalarText }}</pre>
        </template>
      </section>
    </div>
    <p v-if="page">阅读范围：{{ scope }}</p>
    <label v-if="selected === 'timeline'"><input v-model="follow" type="checkbox">跟随已保存过程更新（手动滚动后暂停）</label>
    <p v-if="selected === 'timeline' && isRunning(status)">运行期间每 3 秒只读扫描 / 增量刷新；实时预览来自安全 visible 事件，不是技术日志。</p>
    <div class="tool-call-detail-actions" style="display: flex; flex-wrap: wrap; min-width: 0; gap: 8px;">
      <button type="button" @click="restart">{{ state.error ? '重试读取（重新建立快照）' : '重新读取快照' }}</button>
      <button v-if="state.loading" type="button" @click="cancel">取消只读加载</button>
      <button v-if="page?.nextCursor" type="button" :disabled="state.loading || !!state.error" @click="load('next')">继续加载下一页 / 超长单条余文</button>
      <button v-if="page?.nextCursor" type="button" :disabled="state.loading || !!state.error" @click="load('next', true)">加载剩余保存内容</button>
      <button v-if="selected === 'timeline' && page?.refreshCursor" type="button" :disabled="state.loading || !!state.error" @click="load('refresh')">增量刷新已保存过程</button>
      <button type="button" :disabled="state.loading || !page" @click="exportContent(false, false)">复制已加载预览</button>
      <button type="button" :disabled="state.loading || !page" @click="exportContent(true, false)">下载已加载预览</button>
      <button type="button" :disabled="state.loading || !!state.error || !canExportFull(state.content, selected)" @click="exportContent(false, true)">加载并复制{{ selected === 'timeline' ? '保存快照' : selected === 'delegation' ? '委派正文' : '已保存报告' }}全文</button>
      <button type="button" :disabled="state.loading || !!state.error || !canExportFull(state.content, selected)" @click="exportContent(true, true)">加载并下载{{ selected === 'timeline' ? '保存快照' : selected === 'delegation' ? '委派正文' : '已保存报告' }}全文</button>
    </div>
  </section>
</template>
