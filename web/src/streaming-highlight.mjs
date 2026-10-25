import { patchChildren } from './dom-patch.mjs'

// Incremental renderer integration: no document scans or main-thread tokenization.
// At most one worker job is in flight; edits coalesce to the latest block version.
export function createStreamingHighlighter({ createWorker = () => new Worker(new URL('./code-highlight.worker.mjs', import.meta.url), { type: 'module' }), interval = 120 } = {}) {
  const blocks = new Map()
  let worker, timer, watchdog, busy, sequence = 0, stopped = false, failed = false
  const metrics = { submitted: 0, applied: 0, characters: 0, maxWorkerMs: 0 }
  const limit = 100000

  function schedule() {
    if (stopped || failed || timer || busy) return
    const dirty = [...blocks.values()].filter(b => b.dirty && b.source.length <= limit)
    if (!dirty.length) return
    const delay = Math.max(0, Math.min(...dirty.map(b => b.nextAt)) - performance.now())
    timer = setTimeout(run, delay)
  }
  function fail() {
    failed = true
    clearTimeout(watchdog)
    worker?.terminate()
    worker = undefined
    busy = undefined
  }
  function run() {
    timer = undefined
    if (stopped || failed) return
    const block = [...blocks.values()].find(b => b.dirty && b.source.length <= limit && b.nextAt <= performance.now())
    if (!block) { schedule(); return }
    block.dirty = false
    if (!block.source) { schedule(); return }
    try {
      if (!worker) {
        worker = createWorker()
        worker.onmessage = receive
        worker.onerror = fail
      }
      const source = block.source
      busy = { id: ++sequence, block, source, version: block.version }
      metrics.submitted++; metrics.characters += source.length
      worker.postMessage({ id: sequence, source, language: block.language })
      // A pathological grammar must not hold a worker indefinitely.
      watchdog = setTimeout(fail, 2500)
    } catch { fail() }
  }
  function receive({ data }) {
    if (stopped || !busy || data.id !== busy.id) return
    clearTimeout(watchdog)
    const { block, source } = busy
    busy = undefined
    metrics.maxWorkerMs = Math.max(metrics.maxWorkerMs, data.duration || 0)
    // Prefix results are safe even when more characters arrived during the job.
    // Keep the plain suffix immediately visible until the next scheduled pass.
    if (blocks.get(block.code) === block && block.source.startsWith(source) && data.html !== undefined) {
      const selection = block.code.ownerDocument.getSelection()
      if (!selection || selection.isCollapsed || !selection.containsNode(block.code, true)) {
        const template = block.code.ownerDocument.createElement('template')
        template.innerHTML = data.html
        template.content.append(block.code.ownerDocument.createTextNode(block.source.slice(source.length)))
        patchChildren(block.code, template.content)
        block.code.className = 'hljs' + (data.language ? ` language-${data.language}` : '')
        if (!block.language && data.language) block.language = data.language
        metrics.applied++
      }
    }
    block.nextAt = performance.now() + Math.max(interval, Math.min(800, (data.duration || 0) * 4), block.source.length > 20000 ? 400 : 0)
    schedule()
  }
  return {
    metrics,
    track(code) {
      const pre = code.parentElement
      pre.tabIndex = 0; pre.setAttribute('role', 'region'); pre.setAttribute('aria-label', '代码块')
      blocks.set(code, { code, source: '', language: '', dirty: false, version: 0, nextAt: performance.now() + interval })
    },
    has(code) { return blocks.has(code) },
    language(code, value) {
      const block = blocks.get(code)
      if (!block) return
      const raw = String(value).trim().split(/\s/)[0].toLowerCase()
      const aliases = { js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', py: 'python', sh: 'bash', shell: 'bash', mjs: 'javascript', cjs: 'javascript', html: 'xml', vue: 'xml', yml: 'yaml', md: 'markdown' }
      block.language = aliases[raw] || raw
      if (/^[\w-]+$/.test(raw)) {
        code.className = `language-${block.language}`
        code.parentElement.dataset.lang = raw
        code.parentElement.setAttribute('aria-label', raw + ' 代码块')
      }
    },
    append(code, text) {
      const block = blocks.get(code)
      if (!block) return
      block.source += text; block.version++; block.dirty = true
      const last = code.lastChild
      if (last?.nodeType === 3) last.appendData(text)
      else code.append(code.ownerDocument.createTextNode(text))
      schedule()
    },
    dispose() {
      stopped = true
      clearTimeout(timer); clearTimeout(watchdog)
      worker?.terminate(); worker = undefined; blocks.clear(); busy = undefined
    },
  }
}
