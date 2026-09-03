<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as smd from 'streaming-markdown'

const props = defineProps({
  text: { type: String, default: '' },
})

const root = ref(null)
let parser
let processedText = ''
let parserSourceText = ''
let pendingCommitTimer

function cancelPendingCommit() {
  if (pendingCommitTimer) clearTimeout(pendingCommitTimer)
  pendingCommitTimer = undefined
}

function schedulePendingCommit() {
  cancelPendingCommit()
  pendingCommitTimer = setTimeout(() => {
    pendingCommitTimer = undefined
    // streaming-markdown waits for a following character before committing
    // ambiguous trailing Markdown. Finish the visual buffer after a brief idle
    // period so pre-tool status text is visible before the tool begins.
    if (parser?.pending && processedText) rebuild(`${processedText}\n`, processedText)
  }, 80)
}

function safeUrl(value) {
  const text = String(value || '').trim()
  if (!text) return false
  if (/^(?:https?:|mailto:|\/|#)/i.test(text)) return true
  return !/^[a-z][a-z\d+.-]*:/i.test(text)
}

function createRenderer(element) {
  const renderer = smd.default_renderer(element)
  return {
    ...renderer,
    set_attr(data, type, value) {
      if ((type === smd.HREF || type === smd.SRC) && !safeUrl(value)) return
      smd.default_set_attr(data, type, value)
      if (type === smd.HREF) {
        const link = data.nodes[data.index]
        link.setAttribute('target', '_blank')
        link.setAttribute('rel', 'noreferrer noopener')
      }
    },
  }
}

function appendText(text) {
  if (!parser) return
  const nextText = String(text || '')
  cancelPendingCommit()
  if (!nextText.startsWith(processedText) || parserSourceText !== processedText) {
    rebuild(nextText)
    schedulePendingCommit()
    return
  }
  const delta = nextText.slice(processedText.length)
  processedText = nextText
  parserSourceText = nextText
  if (delta) smd.parser_write(parser, delta)
  schedulePendingCommit()
}

function rebuild(text = props.text, sourceText = text) {
  const element = root.value
  if (!element) return
  if (parser) smd.parser_end(parser)
  element.replaceChildren()
  parser = smd.parser(createRenderer(element))
  parserSourceText = String(text || '')
  processedText = String(sourceText || '')
  if (parserSourceText) smd.parser_write(parser, parserSourceText)
}

onMounted(() => {
  rebuild()
  schedulePendingCommit()
})

watch(() => props.text, appendText, { flush: 'post' })

onBeforeUnmount(() => {
  cancelPendingCommit()
  if (parser) smd.parser_end(parser)
  parser = undefined
})
</script>

<template>
  <div ref="root" class="streaming-markdown-content"></div>
</template>
