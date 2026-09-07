// Standalone real Vue component + existing CSS/sanitizer in Edge; NOT an App integration test.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
const require = createRequire(import.meta.url)
let playwright
for (const path of [process.env.PLAYWRIGHT_CORE_PATH, '../desktop/.cache/ui-test/node_modules/playwright-core', join(tmpdir(), 'neoctl-observability-tests/node_modules/playwright-core'), 'playwright-core'].filter(Boolean)) {
  try { playwright = require(path); break } catch {}
}
assert.ok(playwright, 'Set PLAYWRIGHT_CORE_PATH to installed playwright-core')
const appSource = await readFile(new URL('./src/App.vue', import.meta.url), 'utf8')
// Read, do not copy/modify the production sanitizer. This host contract test uses its
// exact current functions but does not mount App or claim App's props are wired.
const hostFunctions = ['sanitizeMarkdown', 'highlightCodeBlocks', 'normalizeCodeLanguage', 'safeHref'].map(name => {
  const fn = appSource.match(new RegExp(`^function ${name}\\([^]*?^}`, 'm'))?.[0]
  assert.ok(fn, `Existing App ${name} must be available`)
  return fn
}).join('\n')
const fixtureModule = `import { createApp, h, reactive } from '/node_modules/.vite/deps/vue.js';
import { marked } from '/node_modules/.vite/deps/marked.js';
import hljs from '/node_modules/.vite/deps/highlight__js.js';
import Reader from '/src/AgentContentReader.vue';
import '/src/style.css'; import '/src/neo-brutalist-soft.css';
${hostFunctions}
const props = reactive({ownerSessionId:'owner-a',taskId:'task-a',runGeneration:2,status:'killed',renderMarkdown:text=>sanitizeMarkdown(marked.parse(text))});
const ui = reactive({mounted:true}); window.readerProps=props; window.readerUi=ui;
createApp({render:()=>h('section',{class:'tool-result-modal background-task-modal',style:{position:'relative',margin:'0',maxWidth:'100%'}},[h('div',{class:'tool-result-modal-content'},[ui.mounted?h(Reader,props):null])])}).mount('#fixture');`
const server = await createServer({ configFile: false, root: fileURLToPath(new URL('.', import.meta.url)), logLevel: 'error', plugins: [vue(), {
  name: 'agent-reader-independent-fixture',
  configureServer(server) { server.middlewares.use((req, res, next) => {
    if (req.url === '/agent-reader-fixture') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><html><meta charset="utf-8"><body><div id="fixture"></div><script type="module" src="/agent-reader-fixture.mjs"></script></body></html>'); return }
    next()
  }) },
  resolveId(id) { if (id === '/agent-reader-fixture.mjs') return '\0agent-reader-fixture' },
  load(id) { if (id === '\0agent-reader-fixture') return fixtureModule.replaceAll("'/node_modules/.vite/deps/vue.js'", "'vue'").replaceAll("'/node_modules/.vite/deps/marked.js'", "'marked'").replaceAll("'/node_modules/.vite/deps/highlight__js.js'", "'highlight.js'") },
}], optimizeDeps: { include: ['vue', 'marked', 'highlight.js'] }, server: { host: '127.0.0.1', port: 0 } })
let browser
const requests = [], errors = []
const longReport = '# 报告标题\n\n- 列表一\n- 列表二\n\n```js\nconst x = 1\n```\n\n[安全链接](https://example.com)\n\n<img src=x onerror="window.readerXss=1"><script>window.readerXss=2</script>\n\n' + '正文😀 '.repeat(5500) + '\nREPORT-END\n'
const part = (text, state = 'complete') => ({ text, state, reason: 'fixture' })
const fragment = (text, offset = 0, totalChars = text.length, state = 'complete') => ({ ...part(text, state), offset, totalChars, hasMore: offset + text.length < totalChars })
let reportMode = 'normal', failOnce = false, delayed = false, releaseDelayed, refreshCount = 0
try {
  await server.listen()
  browser = await playwright.chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true })
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] })
  const page = await context.newPage()
  page.on('pageerror', e => errors.push(e.message))
  await page.route('**/api/**', async route => {
    const u = new URL(route.request().url()), q = u.searchParams
    requests.push({ method: route.request().method(), url: u.href })
    assert.equal(u.pathname, '/api/agent-content')
    const base = { ownerSessionId: q.get('sessionId'), taskId: q.get('taskId'), runGeneration: Number(q.get('runGeneration')), state: 'complete', reason: '仅获准内容', snapshotId: 's1' }
    if (delayed) { delayed = false; await new Promise(resolve => { releaseDelayed = resolve }) }
    if (failOnce) { failOnce = false; await route.fulfill({ status: 503, json: {} }); return }
    const view = q.get('view')
    if (view === 'delegation') {
      await route.fulfill({ json: { ...base, delegation: { scope: 'task', description: part('说明摘要', 'truncated'), prompt: fragment('task-level safe delegation [REDACTED]') } } }); return
    }
    if (view === 'timeline') {
      const cursor = q.get('cursor')
      const item = (id, text, extra = {}) => ({ id, kind: 'assistant', messageId: id, content: fragment(text), ...extra })
      if (!cursor) { await route.fulfill({ json: { ...base, state: 'partial', items: [], nextCursor: 'scan-2' } }); return }
      if (cursor === 'scan-2') {
        await route.fulfill({ json: { ...base, refreshCursor: 'refresh-1', pendingTail: true, items: [
          item('0:0', '已保存正文一'),
          item('1:0', '{"path":"C:/真实对象"}', { kind: 'tool_use', toolName: 'file_read', toolUseId: 'call-1', status: 'invoked', object: part('C:/真实对象') }),
          item('2:0', 'permission denied', { kind: 'tool_result', toolName: 'file_read', toolUseId: 'call-1', status: 'failed', ok: false }),
        ] } }); return
      }
      assert.equal(q.get('refresh'), 'true'); refreshCount++
      await route.fulfill({ json: { ...base, snapshotId: `s${refreshCount + 1}`, refreshCursor: `refresh-${refreshCount + 1}`, items: [item('3:0', '刷新新增正文')] } }); return
    }
    if (reportMode === 'missing') { await route.fulfill({ json: { ...base, state: 'missing', reason: '指定旧轮报告已淘汰，不回退当前' } }); return }
    if (reportMode === 'wrong-owner') base.ownerSessionId = 'wrong-owner'
    const text = reportMode === 'empty' ? '' : `${base.ownerSessionId}/${base.taskId}/run${base.runGeneration}\n${longReport}`
    const offset = Number(q.get('cursor') || 0), end = Math.min(text.length, offset + 16000)
    const content = fragment(text.slice(offset, end), offset, text.length, reportMode === 'truncated' ? 'truncated' : 'complete')
    await route.fulfill({ json: { ...base, state: content.hasMore ? 'partial' : 'complete', ...(content.hasMore ? { nextCursor: String(end) } : {}), report: { source: 'runHistory', taskStatus: 'killed', reportStatus: 'incomplete', content, error: part('主动停止') } } })
  })
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/agent-reader-fixture`)
  const reader = page.locator('.agent-content-reader')
  await reader.getByRole('heading', { name: '报告标题', exact: true }).waitFor()
  assert.match(await reader.innerText(), /报告未完成|报告完成标记：incomplete/)
  assert.equal(await reader.locator('img, script, [onerror]').count(), 0)
  assert.equal(await page.evaluate(() => window.readerXss), undefined)
  assert.equal(await reader.locator('a').getAttribute('rel'), 'noreferrer noopener')
  await reader.getByRole('button', { name: '复制已加载预览', exact: true }).click()
  await page.waitForFunction(async () => (await navigator.clipboard.readText()).includes('已加载预览'))
  assert.ok(!(await page.evaluate(() => navigator.clipboard.readText())).includes('REPORT-END'))
  await reader.getByRole('button', { name: '加载并复制已保存报告全文', exact: true }).click()
  await page.waitForFunction(async () => (await navigator.clipboard.readText()).includes('REPORT-END'))
  let copied = await page.evaluate(() => navigator.clipboard.readText())
  assert.ok(copied.replaceAll('\r\n', '\n').includes(longReport)); assert.match(copied, /报告未完成：incomplete/)
  const downloaded = page.waitForEvent('download')
  await reader.getByRole('button', { name: '加载并下载已保存报告全文', exact: true }).click()
  const download = await downloaded
  assert.ok((await readFile(await download.path(), 'utf8')).includes(longReport))
  await reader.getByRole('button', { name: '脱敏委派', exact: true }).click()
  await reader.getByText('task-level safe delegation [REDACTED]', { exact: true }).waitFor()
  assert.match(await reader.innerText(), /scope=task/)
  await page.evaluate(() => Object.assign(window.readerProps, { status: 'running', visiblePreview: { text: '事件增量预览', truncated: true, channel: 'visible', runGeneration: 2 } }))
  await reader.getByRole('button', { name: '正文与完整过程', exact: true }).click()
  await reader.getByText('事件增量预览', { exact: true }).waitFor()
  await reader.getByText('扫描已推进；本页没有获准展示条目，仍有后续记录。', { exact: true }).waitFor()
  assert.match(await reader.innerText(), /不能判定整轮没有正文/)
  // No manual next click: real 3s timer traverses empty partial then refreshCursor.
  await reader.getByText('实际对象：C:/真实对象（已保存内容完整）', { exact: true }).waitFor({ timeout: 8000 })
  await reader.getByText('刷新新增正文', { exact: true }).first().waitFor({ timeout: 8000 })
  await reader.getByRole('button', { name: '增量刷新已保存过程', exact: true }).click()
  assert.equal(await reader.locator('article').count(), 4)
  assert.match(await reader.innerText(), /调用 ID：call-1 · 调用状态：invoked/)
  assert.match(await reader.innerText(), /调用 ID：call-1 · 调用状态：failed/)
  await page.evaluate(() => { window.readerProps.visiblePreview = { text: 'HIDDEN-UNKNOWN', truncated: false, channel: 'unknown', runGeneration: 2 } })
  assert.ok(!(await reader.innerText()).includes('HIDDEN-UNKNOWN'))
  await page.evaluate(() => { window.readerProps.visiblePreview = { text: 'OLD-RUN-PREVIEW', truncated: false, channel: 'visible', runGeneration: 1 } })
  assert.ok(!(await reader.innerText()).includes('OLD-RUN-PREVIEW'))
  await page.evaluate(() => { window.readerProps.status = 'killed' })
  await reader.getByRole('button', { name: '指定轮次报告', exact: true }).click()
  await reader.getByRole('heading', { name: '报告标题', exact: true }).waitFor()
  failOnce = true
  await reader.getByRole('button', { name: '重新读取快照', exact: true }).click()
  await reader.getByRole('alert').waitFor(); assert.match(await reader.innerText(), /HTTP 503/)
  await reader.getByRole('button', { name: '重试读取（重新建立快照）', exact: true }).click()
  await reader.getByRole('heading', { name: '报告标题', exact: true }).waitFor()
  reportMode = 'truncated'
  await reader.getByRole('button', { name: '重新读取快照', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('.agent-content-reader')?.textContent.includes('源已截断'))
  assert.equal(await reader.getByRole('button', { name: '加载并复制已保存报告全文', exact: true }).isDisabled(), true)
  reportMode = 'missing'
  await reader.getByRole('button', { name: '重新读取快照', exact: true }).click()
  await reader.getByText(/指定旧轮报告已淘汰/).waitFor()
  assert.equal(await reader.locator('.markdown-body').count(), 0)
  reportMode = 'empty'
  await reader.getByRole('button', { name: '重新读取快照', exact: true }).click()
  await reader.getByText('已保存报告正文为空（不是加载失败或报告缺失）。', { exact: true }).waitFor()
  reportMode = 'wrong-owner'
  await reader.getByRole('button', { name: '重新读取快照', exact: true }).click()
  await reader.getByRole('alert').waitFor(); assert.match(await reader.innerText(), /不匹配/)
  reportMode = 'normal'; delayed = true
  await reader.getByRole('button', { name: '重试读取（重新建立快照）', exact: true }).click()
  while (!releaseDelayed) await new Promise(r => setTimeout(r, 10))
  await page.evaluate(() => Object.assign(window.readerProps, { ownerSessionId: 'owner-b', taskId: 'task-b', runGeneration: 3, visiblePreview: null }))
  await reader.getByRole('heading', { name: '报告标题', exact: true }).waitFor()
  releaseDelayed(); releaseDelayed = undefined
  await page.waitForTimeout(150)
  assert.ok(!(await reader.innerText()).includes('owner-a/task-a/run2'))
  assert.ok((await reader.innerText()).includes('owner-b/task-b/run3'))
  // Same identity restart has a new requestEpoch; delayed old request is isolated.
  delayed = true
  await reader.getByRole('button', { name: '重新读取快照', exact: true }).click()
  while (!releaseDelayed) await new Promise(r => setTimeout(r, 10))
  reportMode = 'empty'
  await reader.getByRole('button', { name: '重新读取快照', exact: true }).click()
  await reader.getByText('已保存报告正文为空（不是加载失败或报告缺失）。', { exact: true }).waitFor()
  releaseDelayed(); releaseDelayed = undefined
  await page.waitForTimeout(150)
  assert.equal(await reader.getByRole('heading', { name: '报告标题', exact: true }).count(), 0)
  await page.setViewportSize({ width: 390, height: 844 })
  assert.ok(await reader.evaluate(el => el.getBoundingClientRect().width <= 390))
  assert.ok(await reader.evaluate(el => el.scrollWidth <= el.clientWidth + 1))
  // In-flight unmount and running timer cancellation.
  delayed = true
  await reader.getByRole('button', { name: '重新读取快照', exact: true }).click()
  while (!releaseDelayed) await new Promise(r => setTimeout(r, 10))
  await page.evaluate(() => { window.readerUi.mounted = false })
  releaseDelayed(); releaseDelayed = undefined
  const requestCount = requests.length
  await page.waitForTimeout(3200)
  assert.equal(requests.length, requestCount)
  assert.equal(requests.some(r => r.method !== 'GET'), false)
  assert.deepEqual(errors, [])
  console.log(`AgentContentReader standalone Edge PASS: ${requests.length} GET-only reads; report pagination/Markdown/XSS/copy/download; task delegation; visible preview gating; empty partial + actual 3s scan/refresh; idempotent timeline/tools; failure/retry/truncated/missing/empty; owner/task/run and epoch isolation; unmount; 390px. NOT whole-App acceptance.`)
} finally { releaseDelayed?.(); await browser?.close(); await server.close() }
