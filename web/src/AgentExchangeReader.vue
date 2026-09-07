<script setup>
import { onBeforeUnmount, ref, watch } from 'vue'
import { contentUrl, emptyContent, mergeContent } from './agent-content-reader.mjs'

const props = defineProps({ ownerSessionId: String, task: Object, renderMarkdown: Function })
const items = ref([])
const error = ref('')
let epoch = 0, controller, timer
const preStyle = { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }

async function load() {
  const current = ++epoch
  controller?.abort()
  controller = new AbortController()
  const signal = controller.signal
  clearTimeout(timer)
  const task = props.task
  const ownerSessionId = props.ownerSessionId
  if (!task?.taskId || !ownerSessionId || !Number.isSafeInteger(task.runGeneration)) return
  const active = () => current === epoch && !signal.aborted
  const next = []
  let failed = false
  async function read(view, runGeneration) {
    const identity = { ownerSessionId, taskId: task.taskId, runGeneration }
    let content = emptyContent(), cursor
    do {
      const response = await fetch(contentUrl(identity, view, cursor), { signal, cache: 'no-store' })
      if (!response.ok) throw new Error('加载失败')
      const page = await response.json()
      if (!active()) return ''
      if (page.state === 'unavailable') throw new Error('加载失败')
      content = mergeContent(content, page, identity, view, cursor ? 'next' : 'start')
      if (cursor && page.nextCursor === cursor) throw new Error('加载失败')
      cursor = page.nextCursor
    } while (cursor && active())
    return content.fragment?.text || ''
  }
  async function get(view, generation) {
    try { return await read(view, generation) }
    catch (e) { if (active() && e.name !== 'AbortError') failed = true; return '' }
  }
  function add(id, direction, text) {
    if (typeof text === 'string' && text.trim()) next.push({ id, direction, text })
  }
  add('delegation', '主代理 → 子代理', await get('delegation', task.runGeneration))
  const runs = [...(task.runHistory || []), task].filter(run => Number.isSafeInteger(run.runGeneration))
    .sort((a, b) => a.runGeneration - b.runGeneration)
  for (const run of runs) {
    if (!active()) return
    const text = await get('messages', run.runGeneration)
    try {
      const messages = JSON.parse(text || '[]')
      if (!Array.isArray(messages)) throw new Error()
      for (const message of messages) add(`message:${run.runGeneration}:${message.id}`, '主代理 → 子代理', message.text)
    } catch { failed = true }
    add(`report:${run.runGeneration}`, '子代理 → 主代理', await get('report', run.runGeneration))
  }
  if (!active()) return
  items.value = next
  error.value = failed ? '加载失败' : ''
  if (['pending', 'running'].includes(task.status)) timer = setTimeout(load, 3000)
}
watch(() => [props.ownerSessionId, props.task?.taskId, props.task?.runGeneration, props.task?.status], () => {
  items.value = []; error.value = ''; void load()
}, { immediate: true })
onBeforeUnmount(() => { epoch++; controller?.abort(); clearTimeout(timer) })
</script>

<template>
  <section class="agent-content-reader agent-parent-messages" aria-label="代理消息">
    <article v-for="item in items" :key="item.id" class="agent-parent-message">
      <header><strong>{{ item.direction }}</strong></header>
      <div v-if="renderMarkdown" class="markdown" v-html="renderMarkdown(item.text)"></div>
      <pre v-else :style="preStyle">{{ item.text }}</pre>
    </article>
    <p v-if="error" class="reader-error" role="alert">{{ error }}</p>
  </section>
</template>
