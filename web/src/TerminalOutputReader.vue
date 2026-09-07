<script setup>
import { reactive, ref, watch, onBeforeUnmount } from 'vue'
const props = defineProps({ ownerSessionId: String, runId: String })
const state = reactive({ loading: false, error: '', record: null, stdout: '', stderr: '', offsets: { stdout: 0, stderr: 0 }, ends: { stdout: false, stderr: false } })
const copying = ref(false)
let generation = 0, timer, controller
const availabilityText = { expired: '输出已过期，不可获取（终态后保留 5 分钟）', evicted: '输出已按进程槽位策略清理，不可获取', lost: '运行已失联，输出不可获取；退出事实未提供', 'io-error': '输出存储不可获取' }
const fact = value => value === undefined || value === null ? '未提供' : String(value)
const isCurrent = token => token === generation
async function page(stream, offset, token) {
  const query = new URLSearchParams({ sessionId: props.ownerSessionId || '', runId: props.runId || '', stream, offset: String(offset), limitBytes: '65536' })
  const response = await fetch(`/api/terminal-output?${query}`, { signal: controller.signal })
  if (!response.ok) throw new Error(response.status === 404 ? '所属会话的终端输出不可获取' : `读取失败（${response.status}），可重试`)
  const data = await response.json()
  if (!isCurrent(token)) return null
  if (data.sessionId !== props.ownerSessionId || data.runId !== props.runId || data.stream !== stream || data.offset !== offset) throw new Error('输出身份或游标不匹配，已停止读取')
  if (!Number.isSafeInteger(data.nextOffset) || data.nextOffset < offset) throw new Error('输出游标无效')
  state.record = data.record
  if (data.text === null || data.record?.availability !== 'available') {
    state.stdout = ''; state.stderr = ''
    throw new Error(availabilityText[data.record?.availability] || '输出不可获取')
  }
  if (typeof data.text !== 'string' || (data.text && data.nextOffset === offset)) throw new Error('输出页面无效')
  return data
}
async function load(all = false) {
  if (state.loading || copying.value || !props.ownerSessionId || !props.runId) return
  const token = generation
  state.loading = true; state.error = ''
  try {
    for (const stream of ['stdout', 'stderr']) {
      let pages = 0, bound
      do {
        const data = await page(stream, state.offsets[stream], token)
        if (!data) return
        bound ??= data.record.streams[stream].storedBytes
        state[stream] += data.text
        state.offsets[stream] = data.nextOffset
        state.ends[stream] = data.endOfStoredOutput
        pages++
        if (data.endOfStoredOutput || data.nextOffset >= bound || (!all && pages >= 1)) break
      } while (isCurrent(token))
    }
  } catch (error) { if (isCurrent(token) && error.name !== 'AbortError') state.error = error.message }
  finally { if (isCurrent(token)) { state.loading = false; schedule(token) } }
}
function schedule(token) {
  clearTimeout(timer)
  if (isCurrent(token) && state.record?.availability === 'available') {
    // Refresh stored facts/output without consuming terminal tool output or sending model requests.
    const expiry = state.record.expiresAt
    if (state.record.lifecycle === 'running') timer = setTimeout(() => load(), 1000)
    else if (typeof expiry === 'number') timer = setTimeout(() => load(), Math.max(10, Math.min(2147483647, expiry - Date.now() + 10)))
  }
}
async function exportOutput(download) {
  if (copying.value || state.loading) return
  const token = generation
  copying.value = true; state.error = ''
  try {
    const output = []
    let truncated = false, running = false
    for (const stream of ['stdout', 'stderr']) {
      let offset = 0, text = '', bound
      do {
        const data = await page(stream, offset, token)
        if (!data) return
        bound ??= data.record.streams[stream].storedBytes
        text += data.text; offset = data.nextOffset
        truncated ||= data.record.truncated
        running ||= data.record.lifecycle === 'running'
        if (data.endOfStoredOutput || offset >= bound) break
      } while (isCurrent(token))
      output.push(`--- ${stream}${state.record?.metadata?.tty && stream === 'stdout' ? '（TTY 合流）' : ''} ---\n${text}`)
    }
    if (!isCurrent(token)) return
    // Check expiry/availability again after long pagination before releasing any export.
    await page('stdout', 0, token)
    if (!isCurrent(token)) return
    const label = truncated ? '已保留输出（源已截断，不是完整输出）' : running ? '当前已保存输出快照（运行尚未结束）' : '完整已保存输出'
    const text = `${label}\n流内顺序保留；stdout/stderr 不代表已知跨流顺序。\n${output.join('\n')}`
    if (download) {
      const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }))
      const a = document.createElement('a'); a.href = url; a.download = `terminal-${props.runId}-${truncated ? 'truncated' : running ? 'snapshot' : 'full'}.txt`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
    } else await navigator.clipboard.writeText(text)
  } catch (error) { if (isCurrent(token) && error.name !== 'AbortError') state.error = error.message }
  finally { if (isCurrent(token)) { copying.value = false; schedule(token) } }
}
watch(() => [props.ownerSessionId, props.runId], () => {
  generation++; controller?.abort(); controller = new AbortController(); clearTimeout(timer)
  Object.assign(state, { loading: false, error: '', record: null, stdout: '', stderr: '', offsets: { stdout: 0, stderr: 0 }, ends: { stdout: false, stderr: false } })
  copying.value = false
  load()
}, { immediate: true })
onBeforeUnmount(() => { generation++; controller?.abort(); clearTimeout(timer) })
</script>
<template>
  <section class="background-task-output-section terminal-output-reader" aria-label="终端运行输出" style="min-width: 0; max-width: 100%; overflow-wrap: anywhere">
    <div class="background-task-output-head"><strong>终端运行输出</strong></div>
    <p>stdout / stderr 分流保留；不推断跨流顺序。字节游标按流独立，读取不会消费工具输出。</p>
    <dl v-if="state.record" class="background-task-facts">
      <div><dt>运行状态</dt><dd>{{ state.record.lifecycle === 'lost' ? '已失联' : state.record.lifecycle === 'running' ? '运行中' : fact(state.record.exit?.status) }}</dd></div>
      <div><dt>退出码</dt><dd>{{ fact(state.record.exit?.exitCode) }}</dd></div>
      <div><dt>信号</dt><dd>{{ fact(state.record.exit?.signal) }}</dd></div>
      <div><dt>终止原因</dt><dd>{{ fact(state.record.exit?.terminationReason) }}</dd></div>
      <div><dt>耗时（ms）</dt><dd>{{ fact(state.record.exit?.durationMs) }}</dd></div>
      <div><dt>输出截断</dt><dd>{{ state.record.truncated ? '是；仅可获取已保留前缀，不是全文' : '否' }}</dd></div>
    </dl>
    <p v-if="state.error" role="alert">{{ state.error }}</p>
    <p v-if="state.loading" role="status">正在加载输出…</p>
    <template v-for="stream in ['stdout', 'stderr']" :key="stream">
      <h4>{{ stream }}{{ state.record?.metadata?.tty && stream === 'stdout' ? '（TTY 合流）' : '' }}</h4>
      <p v-if="state.record">已加载 {{ state.offsets[stream] }} / 已保留 {{ state.record.streams[stream].storedBytes }} 字节；已观察 {{ state.record.streams[stream].observedBytes }} 字节{{ state.record.lifecycle === 'running' ? '（仍在增长）' : '' }}</p>
      <pre v-if="state[stream] !== ''" class="background-task-live-output" tabindex="0" style="white-space: pre-wrap; overflow-wrap: anywhere; max-width: 100%">{{ state[stream] }}</pre>
      <p v-else>{{ state.record?.availability === 'available' ? '当前已保存输出为空' : '输出尚不可获取' }}</p>
    </template>
    <div class="tool-call-detail-actions">
      <button type="button" :disabled="state.loading" @click="load()">{{ state.error ? '重试读取' : '刷新输出' }}</button>
      <button type="button" :disabled="state.loading || state.record?.availability !== 'available'" @click="load(true)">加载全部已保留输出</button>
      <button type="button" :disabled="copying || state.loading || state.record?.availability !== 'available'" @click="exportOutput(false)">{{ copying ? '正在读取…' : state.record?.truncated ? '复制已保留输出（截断）' : state.record?.lifecycle === 'running' ? '复制当前快照' : '复制完整输出' }}</button>
      <button type="button" :disabled="copying || state.loading || state.record?.availability !== 'available'" @click="exportOutput(true)">{{ state.record?.truncated ? '下载已保留输出（截断）' : state.record?.lifecycle === 'running' ? '下载当前快照' : '下载完整输出' }}</button>
    </div>
  </section>
</template>
