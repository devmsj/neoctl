<script setup>
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as smd from 'streaming-markdown'

const props = defineProps({
  initialText: { type: String, default: '' },
  chunks: { type: Array, default: () => [] },
})

const root = ref(null)
let parser
let processedChunks = 0
let seededText = ''
let animateText = true

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
    add_text(data, text) {
      if (!text) return
      const parent = data.nodes[data.index]
      if (!animateText) {
        parent.appendChild(document.createTextNode(text))
        return
      }
      const span = document.createElement('span')
      span.className = 'stream-text-reveal'
      span.textContent = text
      parent.appendChild(span)
    },
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

function appendChunks() {
  if (!parser) return
  while (processedChunks < props.chunks.length) {
    const chunk = String(props.chunks[processedChunks] || '')
    processedChunks += 1
    if (chunk) smd.parser_write(parser, chunk)
  }
}

function rebuild() {
  const element = root.value
  if (!element) return
  element.replaceChildren()
  parser = smd.parser(createRenderer(element))
  processedChunks = 0
  seededText = props.initialText
  if (seededText) {
    animateText = false
    smd.parser_write(parser, seededText)
    animateText = true
  }
  appendChunks()
}

onMounted(rebuild)

watch(() => [props.initialText, props.chunks.length], async ([initialText, chunkCount]) => {
  await nextTick()
  if (initialText !== seededText || chunkCount < processedChunks) rebuild()
  else appendChunks()
})

onBeforeUnmount(() => {
  if (parser) smd.parser_end(parser)
  parser = undefined
})
</script>

<template>
  <div ref="root" class="streaming-markdown-content"></div>
</template>
