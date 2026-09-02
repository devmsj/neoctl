<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as smd from 'streaming-markdown'

const props = defineProps({
  text: { type: String, default: '' },
})

const root = ref(null)
let parser
let processedText = ''

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
  if (!nextText.startsWith(processedText)) {
    rebuild(nextText)
    return
  }
  const delta = nextText.slice(processedText.length)
  processedText = nextText
  if (delta) smd.parser_write(parser, delta)
}

function rebuild(text = props.text) {
  const element = root.value
  if (!element) return
  if (parser) smd.parser_end(parser)
  element.replaceChildren()
  parser = smd.parser(createRenderer(element))
  processedText = String(text || '')
  if (processedText) smd.parser_write(parser, processedText)
}

onMounted(rebuild)

watch(() => props.text, appendText, { flush: 'post' })

onBeforeUnmount(() => {
  if (parser) smd.parser_end(parser)
  parser = undefined
})
</script>

<template>
  <div ref="root" class="streaming-markdown-content"></div>
</template>
