<script setup>
import { reactive, watch, onBeforeUnmount } from 'vue'
const props = defineProps({ ownerSessionId: String, runId: String })
const state = reactive({ record: null, stdout: '', stderr: '', offsets: { stdout: 0, stderr: 0 } })
let generation = 0, timer, controller
async function load() {
  const token = generation
  try {
    for (const stream of ['stdout', 'stderr']) {
      let bound
      do {
        const offset = state.offsets[stream]
        const query = new URLSearchParams({ sessionId: props.ownerSessionId, runId: props.runId, stream, offset: String(offset), limitBytes: '65536' })
        const response = await fetch(`/api/terminal-output?${query}`, { signal: controller.signal, cache: 'no-store' })
        if (token !== generation || !response.ok) return
        const data = await response.json()
        if (token !== generation) return
        if (data.sessionId !== props.ownerSessionId || data.runId !== props.runId || data.stream !== stream || data.offset !== offset) return
        if (!Number.isSafeInteger(data.nextOffset) || data.nextOffset < offset) return
        state.record = data.record
        if (data.record?.availability !== 'available' || typeof data.text !== 'string') return
        if (data.text && data.nextOffset === offset) return
        bound ??= data.record.streams[stream].storedBytes
        state[stream] += data.text
        state.offsets[stream] = data.nextOffset
        if (data.endOfStoredOutput || data.nextOffset >= bound) break
      } while (token === generation)
    }
  } catch { /* Keep existing output during reconnect; never replace it with protocol text. */ }
  finally {
    if (token === generation && (!state.record || state.record.lifecycle === 'running')) timer = setTimeout(load, 1000)
  }
}
watch(() => [props.ownerSessionId, props.runId], () => {
  generation++; controller?.abort(); controller = new AbortController(); clearTimeout(timer)
  Object.assign(state, { record: null, stdout: '', stderr: '', offsets: { stdout: 0, stderr: 0 } })
  if (props.ownerSessionId && props.runId) void load()
}, { immediate: true, flush: 'pre' })
onBeforeUnmount(() => { generation++; controller?.abort(); clearTimeout(timer) })
</script>
<template>
  <section v-if="state.stdout || state.stderr" class="terminal-output-reader" aria-label="终端运行输出">
    <pre v-if="state.stdout" class="background-task-live-output" tabindex="0">{{ state.stdout }}</pre>
    <pre v-if="state.stderr" class="background-task-live-output terminal-stderr" tabindex="0">{{ state.stderr }}</pre>
  </section>
</template>
