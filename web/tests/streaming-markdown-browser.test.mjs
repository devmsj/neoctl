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
import { createApp, h, reactive, nextTick } from 'vue';
import StreamingMarkdown from '/src/components/StreamingMarkdown.vue';
const state = reactive({ text: '正在检查。', resources: [], revision: 0, mounted: true });
window.updateMarkdown = async (patch) => { Object.assign(state, patch); await nextTick(); };
createApp({ render: () => h('section', { 'data-revision': state.revision }, [
  state.mounted ? h(StreamingMarkdown, { text: state.text, exposedResources: state.resources.map(item => ({ ...item })) }) : null
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
