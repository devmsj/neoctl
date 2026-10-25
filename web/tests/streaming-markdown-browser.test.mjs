// Real Vue component regression: the parser's trailing character must not
// disappear when parent renders produce a new, equivalent resources array.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { marked } from '../src/markdown.mjs'

const lianhuSample = JSON.parse(readFileSync(new URL('./fixtures/lianhu-markdown.json', import.meta.url), 'utf8'))
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'

const require = createRequire(import.meta.url)
let playwright
for (const path of [process.env.PLAYWRIGHT_CORE_PATH, '../../desktop/.cache/ui-test/node_modules/playwright-core', join(tmpdir(), 'neoctl-observability-tests/node_modules/playwright-core'), 'playwright-core'].filter(Boolean)) {
  try { playwright = require(path); break } catch {}
}
assert.ok(playwright, 'Set PLAYWRIGHT_CORE_PATH to installed playwright-core')

const fixtureModule = `
import { createApp, h, reactive, nextTick, ref } from 'vue';
const component = ref(null);
window.highlightMetrics = () => component.value?.highlightMetrics();
import StreamingMarkdown from '/src/components/StreamingMarkdown.vue';
const state = reactive({ text: '正在检查。', resources: [], revision: 0, mounted: true });
window.updateMarkdown = async (patch) => { Object.assign(state, patch); await nextTick(); };
createApp({ render: () => h('section', { 'data-revision': state.revision }, [
  state.mounted ? h(StreamingMarkdown, { ref: component, text: state.text, exposedResources: state.resources.map(item => ({ ...item })) }) : null
]) }).mount('#fixture');
`
const server = await createServer({
  configFile: false,
  root: fileURLToPath(new URL('../', import.meta.url)),
  logLevel: 'error',
  plugins: [vue(), {
    name: 'streaming-markdown-fixture',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url !== '/streaming-markdown-fixture') return next()
        res.setHeader('Content-Type', 'text/html; charset=utf-8')
        res.end('<!doctype html><html><body><div id="fixture"></div><script type="module" src="/streaming-markdown-fixture.mjs"></script></body></html>')
      })
    },
    resolveId(id) { if (id === '/streaming-markdown-fixture.mjs') return '\0streaming-markdown-fixture' },
    load(id) { if (id === '\0streaming-markdown-fixture') return fixtureModule },
  }],
  optimizeDeps: { include: ['vue', 'streaming-markdown'] },
  server: { host: '127.0.0.1', port: 0 },
})
let browser
try {
  await server.listen()
  browser = await playwright.chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true })
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/streaming-markdown-fixture`)
  await page.waitForFunction(() => typeof window.updateMarkdown === 'function')
  const content = page.locator('.streaming-markdown-content')
  const update = patch => page.evaluate(patch => window.updateMarkdown(patch), patch)
  const settle = () => page.waitForTimeout(180)

  await settle()
  assert.equal(await content.textContent(), '正在检查。', 'initial idle flush shows the final punctuation')

  // App's unrelated tool/status updates re-render with a freshly allocated array.
  await update({ revision: 1 })
  await settle()
  assert.equal(await content.textContent(), '正在检查。', 'parent-only update must not hide the final punctuation indefinitely')
  await page.evaluate(() => { window.savedParagraph = document.querySelector('.streaming-markdown-content p') })
  for (let revision = 2; revision < 6; revision++) {
    await update({ revision })
    assert.equal(await content.textContent(), '正在检查。', 'equivalent resources must not flicker or rebuild the text')
  }
  assert.equal(await page.evaluate(() => window.savedParagraph === document.querySelector('.streaming-markdown-content p')), true)

  await update({ text: '正在检查。下一步。' })
  await settle()
  assert.equal(await content.textContent(), '正在检查。下一步。', 'continuation has no duplicated text or synthetic line break')

  // A real resource change still rebuilds links, and must schedule its own flush.
  await update({ text: '[文件](report.txt)。' })
  await settle()
  await update({ resources: [{ reference: 'report.txt', url: '/api/download/report', kind: 'download', downloadName: 'report.txt' }] })
  await settle()
  assert.equal(await content.textContent(), '文件。', 'resource-only rebuild flushes the final punctuation')
  assert.equal(await content.locator('a').getAttribute('href'), '/api/download/report')
  assert.equal(await content.locator('a').getAttribute('download'), 'report.txt')
  await update({ resources: [{ reference: 'report.txt', url: '/api/download/updated', kind: 'download', downloadName: 'updated.txt' }] })
  await settle()
  assert.equal(await content.locator('a').getAttribute('href'), '/api/download/updated')
  assert.equal(await content.textContent(), '文件。')

  await update({ text: '**加粗' })
  await settle()
  await update({ text: '**加粗**，完成。' })
  await settle()
  assert.equal(await content.textContent(), '加粗，完成。')
  assert.equal(await content.locator('strong').textContent(), '加粗')

  // Replay the actual response one character at a time, including split **.
  await update({ text: '' })
  for (let end = 1; end <= lianhuSample.length; end++) {
    await update({ text: lianhuSample.slice(0, end) })
  }
  await settle()
  const expectedStrong = ['莲湖区在西安主城区内，可以先参考刚才的西安城区预报。', '在莲湖区出门：']
  assert.deepEqual(await content.locator('strong').allTextContents(), expectedStrong)
  assert.equal(await content.locator('tr').count(), 6)
  assert.equal((await content.textContent()).includes('**'), false)
  // Completed/history rendering uses marked instead of the streaming parser.
  const completedHtml = marked.parse(lianhuSample)
  const completedStrong = await page.evaluate(html => {
    const node = document.createElement('div')
    node.innerHTML = html
    return [...node.querySelectorAll('strong')].map(item => item.textContent)
  }, completedHtml)
  assert.deepEqual(completedStrong, expectedStrong)

  await update({ text: '`**代码内 **保持`' })
  await settle()
  assert.equal(await content.textContent(), '**代码内 **保持')
  assert.equal(await content.locator('code').textContent(), '**代码内 **保持')

  // An unclosed fence must color during output, keep its node over idle gaps,
  // and coalesce many small deltas into bounded worker jobs.
  const prefix = '```js\n'
  let source = 'const value = 42;\n'
  await update({ text: prefix + source })
  await page.waitForFunction(() => document.querySelector('pre .hljs-keyword'))
  await page.evaluate(() => { window.savedCode = document.querySelector('pre code'); window.savedLiveKeyword = document.querySelector('pre .hljs-keyword') })
  for (let i = 0; i < 100; i++) {
    source += `const item${i} = "value";\n`
    await update({ text: prefix + source })
    await page.waitForTimeout(5)
  }
  await page.waitForTimeout(600)
  assert.equal(await page.evaluate(() => window.savedCode === document.querySelector('pre code')), true, 'idle does not rebuild an open code block')
  assert.equal(await content.locator('pre code').textContent(), source.trimEnd(), 'highlight never loses or duplicates streamed code')
  assert.equal(await page.evaluate(() => window.savedLiveKeyword === document.querySelector('pre .hljs-keyword')), true, 'live highlighting patches tokens without replacing the stable prefix')
  const metrics = await page.evaluate(() => window.highlightMetrics())
  assert.ok(metrics.applied > 1, 'multiple live color updates before closing the fence')
  assert.ok(metrics.submitted < 30, `100 updates coalesced: ${JSON.stringify(metrics)}`)
  const calls = metrics.submitted
  for (let i = 0; i < 10; i++) await update({ revision: 20 + i })
  await settle()
  assert.equal((await page.evaluate(() => window.highlightMetrics())).submitted, calls, 'parent-only updates do not tokenize code')
  console.log('Live highlight metrics:', JSON.stringify(metrics))
  await update({ text: prefix + source + '```\n\nDone.' })
  await page.waitForTimeout(600)
  assert.ok(await content.locator('pre .hljs-keyword').count() > 0)

  // Closed code must never lose its colored nodes while later prose pauses.
  await page.evaluate(() => {
    window.stableCode = document.querySelector('pre code')
    window.stableKeyword = document.querySelector('pre .hljs-keyword')
    window.colorRemovals = 0
    window.colorObserver = new MutationObserver(records => {
      for (const r of records) for (const n of r.removedNodes) {
        if (n === window.stableCode || n === window.stableKeyword || n.contains?.(window.stableKeyword)) window.colorRemovals++
      }
    })
    window.colorObserver.observe(document.querySelector('.streaming-markdown-content'), { childList: true, subtree: true })
  })
  for (let i = 0; i < 8; i++) {
    await update({ text: prefix + source + '```\n\nDone.' + '续写。'.repeat(i + 1) })
    await page.waitForTimeout(160)
    assert.equal(await page.evaluate(() => window.stableKeyword === document.querySelector('pre .hljs-keyword')), true)
  }
  assert.equal(await page.evaluate(() => window.colorRemovals), 0, 'idle gaps never remove highlighted tokens')
  await page.evaluate(() => window.colorObserver.disconnect())

  // Real formula callbacks, before the reply ends. Delimiters split at every byte.
  const formulas = String.raw`Euler $e^{i\pi}+1=0$ and \(a^2+b^2=c^2\).

$$x=\frac{-b\pm\sqrt{b^2-4ac}}{2a}$$

\[\int_0^1 x^2\,dx=\frac{1}{3}\]

$$
A=\begin{pmatrix}1 & 2 \\ 3 & 4\end{pmatrix}
$$

\[
\begin{cases}x & x\geq0 \\ -x & x<0\end{cases}
\]

Done.
`
  await update({ text: '' })
  for (let i = 1; i <= formulas.length; i++) await update({ text: formulas.slice(0, i) })
  await page.waitForFunction(() => document.querySelectorAll('.katex').length === 6)
  assert.equal(await content.locator('.math-display .katex').count(), 4)
  assert.equal(await content.locator('.math-fallback').count(), 0)
  assert.ok((await content.locator('annotation').allTextContents()).some(t => t.includes(String.raw`\\ 3 & 4`)), 'matrix row separators preserved')
  await page.evaluate(() => { window.stableMath = document.querySelector('.katex') })
  await update({ text: formulas + '续写。' }); await settle()
  assert.equal(await page.evaluate(() => window.stableMath === document.querySelector('.katex')), true)

  // Incomplete formulas keep the last valid preview; closed invalid input falls back.
  await update({ text: String.raw`$x+1 ` })
  await page.waitForFunction(() => document.querySelector('.katex'))
  await page.evaluate(() => { window.validPreview = document.querySelector('.katex') })
  await update({ text: String.raw`$x+1 +\frac{ ` }); await settle()
  assert.equal(await page.evaluate(() => window.validPreview === document.querySelector('.katex')), true)
  await update({ text: String.raw`$x+1 +\frac{1}{2}$ end.` })
  await page.waitForFunction(() => document.querySelector('annotation')?.textContent.includes('frac{1}{2}'))
  await update({ text: String.raw`$\notARealCommand{x}$ end.` })
  await page.waitForFunction(() => document.querySelector('.math-fallback'))
  await update({ text: '`$x$` and \\`code\\`\n\n```js\nconst tex = "$$x$$";\n```\nDone.' })
  await settle()
  assert.equal(await content.locator('.katex').count(), 0, 'literal code is never rendered as math')

  // 30KB block: keep main-thread heartbeat moving and use slower adaptive cadence.
  const large = 'const entry = { count: 42, label: "sample" };\n'.repeat(700)
  await update({ text: prefix + large })
  await page.waitForFunction(() => document.querySelectorAll('pre .hljs-keyword').length > 600)
  const largeStats = await page.evaluate(async prefix => {
    const gaps = []; let last = performance.now()
    const heartbeat = setInterval(() => { const now = performance.now(); gaps.push(now - last); last = now }, 16)
    let text = document.querySelector('pre code').textContent
    for (let i = 0; i < 80; i++) {
      text += '\nconst next' + i + ' = 1;'
      await window.updateMarkdown({ text: prefix + text })
      await new Promise(r => setTimeout(r, 5))
    }
    await new Promise(r => setTimeout(r, 650))
    clearInterval(heartbeat)
    return { ...window.highlightMetrics(), heartbeatCount: gaps.length, maxHeartbeatMs: Math.max(...gaps) }
  }, prefix)
  assert.ok(largeStats.submitted < 15, JSON.stringify(largeStats))
  assert.ok(largeStats.heartbeatCount > 10, 'UI event loop remains responsive')
  console.log('30KB highlight metrics:', JSON.stringify(largeStats))
  // Over the cap: render all text, but do not schedule unbounded work.
  await update({ text: prefix + 'x'.repeat(110001) })
  await settle()
  assert.equal((await page.evaluate(() => window.highlightMetrics())).submitted, 0)
  assert.equal((await content.locator('pre code').textContent()).length, 110000, 'only the parser pending character is deferred')

  await update({ text: '替换。', resources: [] })
  await settle()
  assert.equal(await content.textContent(), '替换。', 'non-prefix replacement is flushed')
  await update({ text: '' })
  await settle()
  assert.equal(await content.textContent(), '')
  await update({ text: '卸载前。' })
  await update({ mounted: false })
  await settle()
  assert.deepEqual(errors, [])
  console.log('PASS: trailing punctuation, equivalent resources, resource changes, continuation, replacement, unmount')
} finally {
  await browser?.close()
  await server.close()
}
