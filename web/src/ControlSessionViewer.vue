<script setup>
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import StreamingMarkdown from './components/StreamingMarkdown.vue'
import { canRenderMarkdown, parseControlTranscript, sessionEndpoint } from '../control-transcript.mjs'

const params = new URLSearchParams(window.location.search)
const deviceId = params.get('deviceId') || ''
const sessionId = params.get('sessionId') || ''
const view = shallowRef(parseControlTranscript(''))
const meta = shallowRef({})
const loading = ref(false)
const error = ref('')
const checkedAt = ref('')
const loaded = ref(false)
const linkNotice = ref('')
let endpoint = ''
let timer
let controller
let stopped = false
let etag = ''
let lastToken = ''
let lastTranscript = null
try { endpoint = sessionEndpoint(deviceId, sessionId) } catch (cause) { error.value = cause.message }

const title = computed(() => view.value.title || (typeof meta.value.title === 'string' && meta.value.title) || '未命名会话')
const updatedAt = computed(() => typeof meta.value.updatedAt === 'string' ? meta.value.updatedAt : '')
const roles = { user: '用户', assistant: '助手', tool_result: '工具结果', system: '系统记录', progress: '进度', attachment: '附件记录', tombstone: '占位记录' }
const roleLabel = (role) => Object.hasOwn(roles, role) ? roles[role] : role

function blockNavigation(event) {
  if (event.target instanceof Element && event.target.closest('a, input, button, form')) {
    event.preventDefault()
    event.stopPropagation()
    linkNotice.value = '上报内容中的链接与控件已禁用，避免访问外部地址或操作本机会话。'
  }
}

async function refresh() {
  if (stopped || loading.value || !endpoint) return
  clearTimeout(timer)
  loading.value = true
  let timeout
  try {
    const token = sessionStorage.getItem('neo-control-token') || ''
    if (token !== lastToken) {
      // Never reuse a previous principal's cached session / ETag.
      etag = ''
      lastToken = token
      lastTranscript = null
      view.value = parseControlTranscript('')
      meta.value = {}
      loaded.value = false
    }
    if (!token) throw new Error('未找到 Control 登录令牌，请先在同源 Control 页面登录后刷新。')
    controller = new AbortController()
    timeout = setTimeout(() => controller?.abort(), 15000)
    const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' }
    if (etag) headers['If-None-Match'] = etag
    // Fixed same-origin, GET-only endpoint. Refuse redirects rather than forward
    // credentials or follow resource URLs supplied by a report.
    const response = await fetch(endpoint, {
      method: 'GET', headers, signal: controller.signal, mode: 'same-origin',
      credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer',
    })
    if (stopped) return
    if (response.status === 401 || response.status === 403) {
      etag = ''
      lastTranscript = null
      view.value = parseControlTranscript('')
      meta.value = {}
      loaded.value = false
      throw new Error('无权读取此会话，请返回 Control 检查登录状态和权限。')
    }
    if (response.status !== 304) {
      if (!response.ok) throw new Error(response.status === 404 ? '未找到上报会话，请检查 URL 或等待设备上报。' : `读取失败（HTTP ${response.status}）`)
      const data = await response.json()
      if (stopped) return
      if (!data || typeof data.transcript !== 'string' || (data.meta != null && (typeof data.meta !== 'object' || Array.isArray(data.meta)))) {
        throw new Error('响应格式无效，应为 {meta, transcript}，transcript 必须是 JSONL 字符串。')
      }
      if (data.transcript !== lastTranscript) {
        view.value = parseControlTranscript(data.transcript)
        lastTranscript = data.transcript
      }
      meta.value = data.meta || {}
      etag = response.headers.get('ETag') || ''
      loaded.value = true
    } else if (!loaded.value) {
      etag = ''
      throw new Error('服务器返回 304，但当前没有可展示的缓存。')
    }
    checkedAt.value = new Date().toLocaleTimeString()
    error.value = ''
  } catch (cause) {
    if (!stopped) error.value = cause?.name === 'AbortError' ? '读取超时，稍后自动重试。' : cause instanceof Error ? cause.message : '读取失败，稍后自动重试。'
  } finally {
    clearTimeout(timeout)
    controller = undefined
    loading.value = false
    if (!stopped) timer = setTimeout(refresh, 2000)
  }
}

onMounted(refresh)
onBeforeUnmount(() => { stopped = true; clearTimeout(timer); controller?.abort() })
</script>

<template>
  <div class="viewer-shell">
    <header class="viewer-header">
      <div class="eyebrow">NEO CONTROL <span class="badge">只读 · 上报快照</span></div>
      <h1>{{ title }}</h1>
      <p class="identity">设备 {{ deviceId || '未指定' }} <span> / </span> 会话 {{ sessionId || '未指定' }}</p>
      <div class="toolbar">
        <button type="button" :disabled="loading || !endpoint" @click="refresh">{{ loading ? '正在读取…' : '立即刷新' }}</button>
        <span role="status">每 2 秒自动检查<span v-if="checkedAt"> · 上次检查 {{ checkedAt }}</span></span>
      </div>
      <p v-if="updatedAt" class="timestamp">上报更新时间：{{ updatedAt }}</p>
    </header>

    <aside class="safety-notice">
      <strong>仅查看，不恢复或运行会话。</strong>
      复用 Web 的 Markdown 展示组件，但不是完整 Web 会话恢复；不连接 engine，不执行命令、工具或上报配置，也不能修改会话。
      资源文件不随会话文本上传，图片、附件和本地结果文件在此不可用。
      外部资源不会自动加载；链接、图片语法及 HTML 保守显示为原始文本，链接交互禁用，并由 CSP 限制资源加载。
    </aside>
    <p v-if="error" class="error" role="alert">{{ error }}<span v-if="loaded"> 当前保留上次成功读取的快照。</span></p>
    <p v-if="view.incompleteTail" class="notice">末尾记录尚未写完，暂不展示；下次刷新重试，不修改原文件。</p>
    <details v-if="view.warnings.length" class="notice"><summary>{{ view.warnings.length }} 条记录解析提示</summary><p v-for="(warning, i) in view.warnings" :key="i">{{ warning }}</p></details>
    <p v-if="linkNotice" class="notice" role="status">{{ linkNotice }}</p>
    <p v-if="loaded && !view.entries.length" class="empty">尚无可展示的消息，等待下一次上报。</p>

    <main aria-label="只读会话记录" @click.capture="blockNavigation" @auxclick.capture="blockNavigation" @submit.capture.prevent>
      <template v-for="entry in view.entries" :key="entry.key">
        <article v-if="entry.type === 'message'" class="message" :class="{ 'user-message': entry.role === 'user', 'tool-message': entry.role === 'tool_result' }">
          <header class="message-header"><strong>{{ roleLabel(entry.role) }}</strong><span>{{ entry.agentId }}</span><time>{{ entry.createdAt }}</time></header>
          <p v-if="!entry.blocks.length" class="notice">空消息</p>
          <template v-for="(block, index) in entry.blocks" :key="index">
            <div v-if="block.type === 'text'" class="message-text">
              <StreamingMarkdown v-if="canRenderMarkdown(block.text)" :text="block.text" />
              <pre v-else class="literal">{{ block.text }}</pre>
            </div>
            <details v-else-if="block.type === 'tool_use' || block.type === 'tool_result'" class="tool-block">
              <summary>{{ block.type === 'tool_use' ? '工具调用' : '工具结果' }} · {{ block.name || '未命名工具' }}<span v-if="block.type === 'tool_result'"> · {{ block.ok ? '成功' : '失败' }}</span><span class="tool-id">{{ block.toolUseId }}</span></summary>
              <p class="notice">仅为上报记录，不会执行或加载结果中的资源。</p>
              <pre class="literal">{{ block.text }}</pre>
            </details>
            <details v-else-if="block.type === 'thinking'"><summary>思考记录（只读）</summary><pre class="literal">{{ block.text }}</pre></details>
            <p v-else-if="block.type === 'image'" class="notice">{{ block.text }}</p>
            <details v-else><summary>未支持的内容块（原始文本）</summary><pre class="literal">{{ block.text }}</pre></details>
          </template>
        </article>
        <section v-else-if="entry.type === 'compact'" class="compact-boundary">
          <strong>上下文压缩边界<span v-if="entry.windowNumber !== null"> · 窗口 {{ entry.windowNumber }}</span></strong>
          <p>{{ entry.createdAt }}<span v-if="entry.reason"> · {{ entry.reason }}</span></p>
          <p>保留压缩前展示历史；{{ entry.replacementCount }} 条替换上下文消息不作为新消息重放。</p>
          <details v-if="entry.report"><summary>压缩报告</summary><pre class="literal">{{ entry.report }}</pre></details>
        </section>
        <p v-else class="notice record-notice">{{ entry.text }}</p>
      </template>
    </main>
    <footer>只读展示上报的 transcript.jsonl；未上报或已省略的内容无法在此还原。</footer>
  </div>
</template>

<style>
:root { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; color: #e1e7ef; background: #10151e; color-scheme: dark; line-height: 1.65; }
* { box-sizing: border-box; }
body { margin: 0; }
.viewer-shell { max-width: 1060px; margin: 0 auto; padding: 34px 24px 60px; }
.eyebrow { color: #a4b1c5; font-size: 12px; letter-spacing: .12em; }
.badge { display: inline-block; margin-left: 12px; padding: 2px 10px; border: 1px solid #387467; border-radius: 20px; color: #a9e4cc; letter-spacing: normal; }
h1 { font-size: clamp(24px, 4vw, 36px); margin: 12px 0; overflow-wrap: anywhere; }
.identity, .timestamp { font-size: 12px; color: #9aa9be; overflow-wrap: anywhere; }
.identity span { margin: 0 8px; }
.toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 16px; font-size: 13px; color: #a4b1c5; }
button { font: inherit; border: 1px solid #466079; border-radius: 8px; padding: 7px 14px; background: #23344a; color: #edf4ff; cursor: pointer; }
button:disabled { opacity: .5; cursor: default; }
button:focus-visible, summary:focus-visible { outline: 2px solid #9bccff; outline-offset: 3px; }
.safety-notice { margin: 24px 0; padding: 16px 18px; border: 1px solid #365266; border-radius: 10px; background: #182633; font-size: 13px; color: #bbcfdf; }
.safety-notice strong { color: #deedf7; }
.error { background: #43232a; border: 1px solid #a55e6d; padding: 12px 16px; border-radius: 8px; }
.notice, .empty { color: #a4b1c5; font-size: 13px; overflow-wrap: anywhere; }
.message { margin: 18px 0; padding: 20px 22px; border: 1px solid #2b384a; border-radius: 12px; background: #18202d; min-width: 0; }
.user-message { border-left: 3px solid #769ddc; }
.tool-message { background: #151e27; }
.message-header { display: flex; flex-wrap: wrap; align-items: baseline; gap: 12px; margin-bottom: 12px; font-size: 12px; color: #98a9bf; overflow-wrap: anywhere; }
.message-header strong { color: #d8e6fa; font-size: 14px; }
.message-header time { margin-left: auto; }
.message-text { overflow-wrap: anywhere; }
.literal { white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; font: 13px/1.7 ui-monospace, Consolas, monospace; margin: 12px 0; }
details { border: 1px solid #344255; border-radius: 7px; margin: 12px 0; padding: 10px 14px; }
summary { cursor: pointer; overflow-wrap: anywhere; }
.tool-id { color: #91a1b7; font-size: 11px; margin-left: 12px; }
.compact-boundary { border-block: 1px dashed #6c647d; padding: 18px; margin: 28px 0; background: #211f2d; font-size: 13px; color: #c9c0da; }
.compact-boundary p { margin: 4px 0; }
.record-notice { padding: 0 12px; }
.streaming-markdown-content pre { overflow-x: auto; padding: 14px; border-radius: 7px; background: #101721; }
.streaming-markdown-content code { font-family: ui-monospace, Consolas, monospace; }
.streaming-markdown-content table { display: block; overflow-x: auto; border-collapse: collapse; }
.streaming-markdown-content th, .streaming-markdown-content td { border: 1px solid #405067; padding: 5px 10px; }
.streaming-markdown-content blockquote { margin-left: 0; border-left: 3px solid #647993; padding-left: 16px; color: #b5c3d7; }
/* Defense in depth; CSP, not CSS, prevents automatic resource requests. */
main a { pointer-events: none; color: inherit; text-decoration: none; }
main img, main iframe, main video, main audio, main object, main embed { display: none; }
footer { border-top: 1px solid #2c394d; margin-top: 30px; padding-top: 20px; font-size: 12px; color: #98a9bf; }
@media (max-width: 600px) { .viewer-shell { padding: 22px 12px 40px; } .message { padding: 14px; } .message-header time { margin-left: 0; } }
</style>
