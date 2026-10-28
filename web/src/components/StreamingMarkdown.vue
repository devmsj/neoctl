<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as smd from 'streaming-markdown'
import { createStreamingHighlighter } from '../streaming-highlight.mjs'
import { createStreamingMath } from '../streaming-math.mjs'
import { resourceActionTitle, isDesktop } from '../local-resources.mjs'

const props = defineProps({
  text: { type: String, default: '' },
  exposedResources: { type: Array, default: () => [] },
})

const root = ref(null)
let parser
let processedText = ''
let parserSourceText = ''
let pendingCommitTimer
let highlighter
let activeCode
let mathRenderer
let activeMath
let idlePreview

function clearIdlePreview() {
  idlePreview?.remove()
  idlePreview = undefined
}

// Exposed only for diagnostics/tests; no reactive state or per-token UI updates.
defineExpose({ highlightMetrics: () => highlighter?.metrics })

function cancelPendingCommit() {
  if (pendingCommitTimer) clearTimeout(pendingCommitTimer)
  pendingCommitTimer = undefined
}

function schedulePendingCommit() {
  cancelPendingCommit()
  pendingCommitTimer = setTimeout(() => {
    pendingCommitTimer = undefined
    // Preview only an ordinary trailing character; do not feed a synthetic newline
    // or rebuild the reply. Rebuilds erased all earlier highlights every idle gap.
    clearIdlePreview()
    if (!activeCode && !activeMath && parser?.pending && !/[\\`*$\[\]<>_~\r\n]/.test(parser.pending)) {
      const data = parser.renderer.data
      const node = data.nodes[data.index]
      if (node && node !== root.value) {
        idlePreview = document.createTextNode(parser.pending)
        node.append(idlePreview)
      }
    }
  }, 80)
}

function safeUrl(value) {
  const text = String(value || '').trim()
  if (!text) return false
  if (/^(?:https?:|mailto:|\/|#)/i.test(text)) return true
  return !/^[a-z][a-z\d+.-]*:/i.test(text)
}

function exposedResource(value) {
  const reference = String(value || '').trim()
  return props.exposedResources.find((item) => String(item?.reference || '').trim() === reference)
}

function compactFileSize(value) {
  const bytes = Number(value)
  if (!Number.isFinite(bytes) || bytes <= 0) return ''
  const units = ['B', 'KB', 'MB', 'GB']
  let size = bytes
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit += 1
  }
  return `${size >= 10 || unit === 0 ? Math.round(size) : size.toFixed(1)}${units[unit]}`
}

function createRenderer(element) {
  const renderer = smd.default_renderer(element)
  return {
    ...renderer,
    add_token(data, type) {
      smd.default_add_token(data, type)
      if (type === smd.CODE_FENCE || type === smd.CODE_BLOCK) {
        activeCode = data.nodes[data.index]
        highlighter.track(activeCode)
      }
      if (type === smd.EQUATION_INLINE || type === smd.EQUATION_BLOCK) {
        activeMath = data.nodes[data.index]
        mathRenderer.track(activeMath, type === smd.EQUATION_BLOCK)
      }
    },
    end_token(data) {
      const node = data.nodes[data.index]
      if (mathRenderer.has(node)) {
        mathRenderer.close(node)
        if (node === activeMath) activeMath = undefined
      }
      if (node === activeCode) activeCode = undefined
      smd.default_end_token(data)
    },
    add_text(data, text) {
      const node = data.nodes[data.index]
      if (highlighter.has(node)) highlighter.append(node, text)
      else if (mathRenderer.has(node)) mathRenderer.append(node, text)
      else smd.default_add_text(data, text)
    },
    set_attr(data, type, value) {
      if (type === smd.LANG && highlighter.has(data.nodes[data.index])) {
        highlighter.language(data.nodes[data.index], value)
        return
      }
      const resource = type === smd.HREF ? exposedResource(value) : undefined
      const attributeValue = resource?.url || value
      if ((type === smd.HREF || type === smd.SRC) && !safeUrl(attributeValue)) return
      smd.default_set_attr(data, type, attributeValue)
      if (type === smd.HREF) {
        const link = data.nodes[data.index]
        if (resource) {
          link.classList.add('inline-resource-link', `inline-resource-${resource.kind || 'link'}`)
          if (resource.kind === 'download' || resource.downloadName) {
            link.setAttribute('download', resource.downloadName || resource.label || '')
            link.setAttribute('data-tooltip', resourceActionTitle(resource.label || resource.downloadName))
            link.removeAttribute('target')
            link.removeAttribute('rel')
            link.dataset.resourceAction = isDesktop() ? '' : '下载'
            link.dataset.resourceDownload = 'true'
            link.dataset.resourceExpiresAt = String(Number(resource.expiresAt) || 0)
            const size = compactFileSize(resource.sizeBytes)
            if (size) link.dataset.resourceSize = `(${size})`
          }
        } else {
          link.setAttribute('target', '_blank')
          link.setAttribute('rel', 'noreferrer noopener')
        }
      }
    },
  }
}

function writeStream(text) {
  // The upstream parser only recognizes display openers followed by a newline.
  // Normalize that boundary incrementally (also across chunk splits), never
  // touching TeX bodies, code spans/fences, or the original message text.
  const write = chunk => {
    if (!chunk) return
    if (parser.token === smd.MAYBE_EQ_BLOCK && chunk[0] !== '\n') smd.parser_write(parser, '\n')
    smd.parser_write(parser, chunk)
  }
  let offset = 0
  for (const match of text.matchAll(/[$\\\[\]]/g)) {
    write(text.slice(offset, match.index))
    write(match[0])
    offset = match.index + 1
  }
  write(text.slice(offset))
}

function appendText(text) {
  if (!parser) return
  const nextText = String(text || '')
  cancelPendingCommit()
  clearIdlePreview()
  if (!nextText.startsWith(processedText) || parserSourceText !== processedText) {
    rebuild(nextText)
    schedulePendingCommit()
    return
  }
  const delta = nextText.slice(processedText.length)
  processedText = nextText
  parserSourceText = nextText
  if (delta) writeStream(delta)
  schedulePendingCommit()
}

function rebuild(text = props.text, sourceText = text) {
  const element = root.value
  if (!element) return
  if (parser) smd.parser_end(parser)
  highlighter?.dispose()
  highlighter = createStreamingHighlighter()
  mathRenderer?.dispose()
  mathRenderer = createStreamingMath()
  clearIdlePreview()
  activeMath = undefined
  activeCode = undefined
  element.replaceChildren()
  parser = smd.parser(createRenderer(element))
  parserSourceText = String(text || '')
  processedText = String(sourceText || '')
  if (parserSourceText) writeStream(parserSourceText)
}

onMounted(() => {
  rebuild()
  schedulePendingCommit()
})

watch(() => props.text, appendText, { flush: 'post' })
// App derives a fresh resources array on every render, including tool/status
// updates. Compare its contents so equivalent arrays do not rebuild the parser
// and put an already visible trailing character back into its pending buffer.
watch(() => JSON.stringify(props.exposedResources), () => {
  rebuild()
  // A resource-only change has no text watcher to flush the new parser's tail.
  schedulePendingCommit()
}, { flush: 'post' })

onBeforeUnmount(() => {
  cancelPendingCommit()
  if (parser) smd.parser_end(parser)
  highlighter?.dispose()
  highlighter = undefined
  mathRenderer?.dispose()
  mathRenderer = undefined
  clearIdlePreview()
  parser = undefined
})
</script>

<template>
  <div ref="root" class="streaming-markdown-content"></div>
</template>
