<script setup>
import { appFetch } from './app-url.mjs'
import TerminalText from './components/TerminalText.vue'
import { createTerminalAnsi } from './terminal-ansi.mjs'
import { reactive, watch, onBeforeUnmount, nextTick, ref } from 'vue'
const props = defineProps({ ownerSessionId: String, runId: String, compact: Boolean, paused: Boolean, fallbackText: String, refreshKey: Number })
const emit = defineEmits(['record'])
const state = reactive({ record: null, stdout: '', stderr: '', offsets: { stdout: 0, stderr: 0 } })
const root = ref(null)
const segments = reactive({ stdout: [], stderr: [] })
const decoders = { stdout: createTerminalAnsi({maxChars: props.compact ? 40000 : Infinity}), stderr: createTerminalAnsi({maxChars: props.compact ? 40000 : Infinity}) }
let generation = 0, timer, controller, loading=false, refreshPending=false
async function load() {
  if(loading || props.paused)return
  loading=true;refreshPending=false
  const token = generation, signal = controller.signal
  try {
    for (const stream of ['stdout', 'stderr']) {
      let bound
      do {
        const offset = state.offsets[stream]
        const query = new URLSearchParams({ sessionId: props.ownerSessionId, runId: props.runId, stream, offset: String(offset), limitBytes: '65536' })
        if (props.compact) query.set('tail', 'true')
        const response = await appFetch(`/api/terminal-output?${query}`, { signal, cache: 'no-store' })
        if (token !== generation || !response.ok) return
        const data = await response.json()
        if (token !== generation) return
        if (data.sessionId !== props.ownerSessionId || data.runId !== props.runId || data.stream !== stream) return
        if (!Number.isSafeInteger(data.offset) || data.offset < offset || (!props.compact && data.offset !== offset)) return
        if (!Number.isSafeInteger(data.nextOffset) || data.nextOffset < data.offset) return
        state.record = data.record
        emit('record', data.record)
        if (data.record?.availability !== 'available' || typeof data.text !== 'string') return
        if (data.text && data.nextOffset === data.offset) return
        bound ??= data.record.streams[stream].storedBytes
        if (data.offset > offset) decoders[stream].reset()
        segments[stream] = decoders[stream].push(data.text)
        state[stream] = props.compact ? ((data.offset > offset ? '' : state[stream]) + data.text).slice(-40000) : state[stream] + data.text
        state.offsets[stream] = data.nextOffset
        if (props.compact) {
          await nextTick()
          root.value?.dispatchEvent(new CustomEvent('observation-output', { bubbles: true }))
        }
        if (props.compact || data.endOfStoredOutput || data.nextOffset >= bound) break
      } while (token === generation)
    }
  } catch { /* Preserve existing output on disconnect. */ }
  finally {
    if(token === generation){loading=false;if (!props.paused && (refreshPending || !state.record || state.record.lifecycle === 'running')) timer = setTimeout(load, refreshPending?0:1000)}
  }
}
watch(() => [props.ownerSessionId, props.runId, props.paused], (values, old) => {
  generation++; controller?.abort(); controller = new AbortController(); clearTimeout(timer);loading=false;refreshPending=false
  if (values[0] !== old?.[0] || values[1] !== old?.[1]) {
    Object.assign(state, { record: null, stdout: '', stderr: '', offsets: { stdout: 0, stderr: 0 } })
    for (const stream of ['stdout', 'stderr']) { decoders[stream].reset(); segments[stream] = [] }
  }
  if (!props.paused && props.ownerSessionId && props.runId) void load()
}, { immediate: true, flush: 'pre' })
watch(()=>props.refreshKey,()=>{if(props.paused||!props.ownerSessionId||!props.runId)return;clearTimeout(timer);if(loading)refreshPending=true;else void load()})
onBeforeUnmount(() => { generation++; controller?.abort(); clearTimeout(timer) })
</script>
<template>
  <section v-if="state.stdout || state.stderr || (compact && fallbackText)" ref="root" class="terminal-output-reader" :class="{'is-observation-output':compact}" aria-label="终端运行输出">
    <TerminalText v-if="compact && !state.stdout && !state.stderr && fallbackText" class="background-task-live-output" :text="fallbackText" :trim-end="compact" />
    <TerminalText v-if="state.stdout" class="background-task-live-output" tabindex="0" :segments="segments.stdout" :trim-end="compact" />
    <TerminalText v-if="state.stderr" class="background-task-live-output terminal-stderr" tabindex="0" :segments="segments.stderr" :trim-end="compact" />
  </section>
</template>
<style>
.tool-observation .terminal-output-reader.is-observation-output{border:0;background:none;margin:0;padding:0;max-height:none;overflow:visible}
.tool-observation .is-observation-output .background-task-live-output{border:0;background:none;margin:0;padding:0;max-height:none;overflow:visible;font:inherit;white-space:pre-wrap;overflow-wrap:anywhere}
.tool-observation .terminal-stderr{color:inherit}
</style>
