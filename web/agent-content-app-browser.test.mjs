// Built, unmodified App + real Edge + native owner-scoped HTTP/SSE acceptance.
// Run: npm --prefix web run build && node --test web/agent-content-app-browser.test.mjs
// Only test data is mutated. Never write Vue state, storage, production files, or intercept fetch/EventSource.
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { extname, join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { observabilitySnapshot } from './observability-browser-fixture.mjs'
const require = createRequire(import.meta.url)
let playwright
for (const location of [process.env.PLAYWRIGHT_CORE_PATH, '../desktop/.cache/ui-test/node_modules/playwright-core', join(tmpdir(), 'neoctl-observability-tests/node_modules/playwright-core'), 'playwright-core'].filter(Boolean)) {
  try { playwright = require(location); break } catch {}
}
assert.ok(playwright, 'Set PLAYWRIGHT_CORE_PATH to installed playwright-core')
const browser = await playwright.chromium.launch({ channel: 'msedge', headless: true })
after(() => browser.close())
const dist = fileURLToPath(new URL('./dist/', import.meta.url))
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function until(fn, message, timeout = 8000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { if (await fn()) return; await sleep(25) }
  assert.fail(message)
}
const part = (text, state = 'complete') => ({ text, state, reason: state === 'complete' ? '已保存脱敏内容' : '源已截断，不是全文' })
function fragment(text, offset = 0, chars = 16000) {
  let end = Math.min(text.length, offset + chars)
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--
  return { ...part(text.slice(offset, end)), offset, totalChars: text.length, hasMore: end < text.length }
}
const prompt = '任务级脱敏委派 [REDACTED]\n' + '仅处理授权文件😀\n'.repeat(4000) + 'DELEGATION-END'
const longBody = 'LONG-ITEM-BEGIN\n' + 'NO_SPACES_😀'.repeat(4000) + '\nLONG-ITEM-END'
const markdownBody = '\n# 安全报告\n\n- 项目甲\n- 项目乙\n\n```js\nconst a = 1\n```\n\n[安全链接](https://example.com) [危险链接](javascript:alert(1))\n\n<img src=x onerror="window.agentAppXss=1"><script>window.agentAppXss=2</script>\n\n' + '长报告正文😀 '.repeat(6500) + '\nREPORT-END\n'
const reportText = (owner, run) => `REPORT_${owner}_RUN_${run}\n${markdownBody}`
function task(owner, status = 'running') {
  const startedAt = new Date(Date.now() - 5000).toISOString()
  return { kind: 'agent', taskId: 'same-task', agentId: 'child-agent', ownerSessionId: owner, description: `${owner}:same-task`, status,
    runGeneration: 9, createdAt: startedAt, startedAt, ...(status === 'running' ? {} : { completedAt: new Date(Date.parse(startedAt) + 1000).toISOString(), durationMs: 1000 }),
    progress: { visibleText: { channel: 'visible', runGeneration: 9, text: `LIVE_${owner}_1`, truncated: false }, currentAction: 'TECH_LOG_ONLY stream opened', lastText: 'FORBIDDEN_LEGACY_TEXT', totalToolUseCount: 40, steps: [{ id: 'step1', title: 'TECH_STEP_ONLY', status: 'completed' }], lastActivity: startedAt },
    pendingMessageCount: 2, deliveredRetainedThisRun: 3,
    result: { content: 'RESULT_PREVIEW_ONLY', status: 'incomplete', truncated: true },
    runHistory: Array.from({ length: 8 }, (_, i) => ({ runGeneration: i + 1, status: i === 6 ? 'failed' : 'killed', startedAt, completedAt: new Date(Date.parse(startedAt) + 1000).toISOString(), durationMs: 1000, result: { status: 'incomplete', content: `ARCHIVE_PREVIEW_${i + 1}`, truncated: true } })),
  }
}
function timeline(owner) {
  const items = Array.from({ length: 40 }, (_, n) => ({ id: `${n * 100}:0`, kind: 'assistant', messageId: `m${n}`, text: `VISIBLE_${owner}_${n}` }))
  items[10].text = longBody
  items[20] = { id: '2000:0', kind: 'tool_use', messageId: 'm20', toolUseId: 'call-real-1', toolName: 'file_read', status: 'invoked', object: part('C:/authorized/actual-object.txt'), text: '{"path":"C:/authorized/actual-object.txt","token":"[REDACTED]"}' }
  items[21] = { id: '2100:0', kind: 'tool_result', messageId: 'm21', toolUseId: 'call-real-1', toolName: 'file_read', status: 'failed', ok: false, text: 'permission denied [REDACTED]' }
  return items
}
const callLines = () => [0, 1, 2].map(i => ({ id: i + 1, kind: 'tool', toolName: 'subagent_get', toolUseId: `c${i}`, messageId: `m${i}`, title: '工具', titleStatus: 'success', text: 'CALL_RESULT_PREVIEW', toolDisplay: { purpose: '重复委派读取目的', facts: [], previews: [] }, ...(i === 2 ? { presentationLevel: 'primary' } : {}) }))
async function fixture(t, { status = 'running', lines = [] } = {}) {
  const sessions = Object.fromEntries(['A', 'B'].map(owner => [owner, { task: task(owner, status), items: timeline(owner), lines }]))
  const clients = new Set(), bindings = new Map(), requests = [], errors = []
  const state = { failView: null, hold: null, nextOwner: 0, missingRuns: new Set(), delivered: 0 }
  const snapshot = owner => observabilitySnapshot({ session: { sessionId: owner, title: `Session ${owner}` }, lines: sessions[owner].lines,
    backgroundTasks: sessions[owner].task.status === 'running' ? [sessions[owner].task] : [],
    backgroundTaskCount: sessions[owner].task.status === 'running' ? 1 : 0,
    agentTaskHistory: sessions[owner].task.status === 'running' ? [] : [sessions[owner].task] })
  const ownerFor = url => {
    const explicit = url.searchParams.get('sessionId'), tab = url.searchParams.get('tabId') || 'default'
    if (explicit) { assert.ok(sessions[explicit]); bindings.set(tab, explicit); return explicit }
    if (!bindings.has(tab)) bindings.set(tab, ['A', 'B'][state.nextOwner++] || 'A')
    return bindings.get(tab)
  }
  const json = (res, value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)) }
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost'), q = url.searchParams
      if (url.pathname.startsWith('/api/') || url.pathname === '/events') {
        requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(q) })
        if (req.method !== 'GET') { json(res, { error: 'No model or mutation allowed' }, 405); return }
        if (url.pathname === '/events') {
          const owner = ownerFor(url)
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
          res.write(`event: sync\ndata: ${JSON.stringify(snapshot(owner))}\n\n`)
          const client = { owner, res }; clients.add(client); res.on('close', () => clients.delete(client)); return
        }
        if (url.pathname === '/api/state') { json(res, snapshot(ownerFor(url))); return }
        if (url.pathname === '/api/sessions') { json(res, { sessions: ['A', 'B'].map(owner => ({ sessionId: owner, title: `Session ${owner}`, updatedAt: new Date().toISOString() })) }); return }
        if (url.pathname === '/api/tool-call-detail') {
          const owner = q.get('sessionId'), id = q.get('toolUseId')
          assert.ok(sessions[owner]); assert.match(id, /^c[012]$/)
          const run = id === 'c0' ? 1 : id === 'c1' ? 8 : 9
          json(res, { sessionId: owner, toolUseId: id, messageId: q.get('messageId'), toolName: 'subagent_get', ok: true,
            input: part('{"task_id":"same-task"}'), result: part(JSON.stringify({ task_id: 'same-task', run_generation: run })), error: part('', 'missing') }); return
        }
        if (url.pathname === '/api/agent-content') {
          const owner = q.get('sessionId'), run = Number(q.get('runGeneration')), view = q.get('view'), cursor = q.get('cursor')
          assert.ok(sessions[owner], 'Unscoped/wrong owner request'); assert.equal(q.get('taskId'), 'same-task')
          assert.ok(Number.isSafeInteger(run) && run > 0); assert.equal(q.get('pageChars'), '16000')
          assert.ok(['timeline', 'delegation', 'report'].includes(view))
          if (state.failView === view) { state.failView = null; json(res, {}, 503); return }
          const base = { ownerSessionId: owner, taskId: 'same-task', runGeneration: run, state: 'complete', reason: '指定轮次获准脱敏内容', snapshotId: `${owner}-${run}-${view}-snapshot` }
          let payload
          if (view === 'timeline') {
            // Initial empty partial scan proves the App handles progress without a visible item.
            if (!cursor) payload = { ...base, state: 'partial', items: [], nextCursor: 'scan' }
            else {
              const all = sessions[owner].items
              let index = 0, offset = 0, upper = all.length
              if (cursor !== 'scan') {
                const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString())
                assert.equal(decoded.owner, owner); assert.equal(decoded.run, run)
                index = decoded.index; offset = decoded.offset; upper = q.get('refresh') === 'true' ? all.length : decoded.upper
                base.snapshotId = q.get('refresh') === 'true' ? `${base.snapshotId}-${upper}` : decoded.snapshotId || base.snapshotId
              }
              const items = []; let budget = 16000
              while (index < upper && budget > 0 && items.length < 64) {
                const { text, ...source } = all[index], content = fragment(text, offset, budget)
                items.push({ ...source, content }); budget -= Math.max(1, content.text.length)
                if (content.hasMore) { offset += content.text.length; break }
                index++; offset = 0
              }
              const more = index < upper
              const next = Buffer.from(JSON.stringify({ owner, run, index, offset, upper, snapshotId: base.snapshotId })).toString('base64url')
              payload = { ...base, state: more ? 'partial' : 'complete', items, ...(more ? { nextCursor: next } : { refreshCursor: next }) }
            }
          } else if (view === 'report' && state.missingRuns.has(run)) payload = { ...base, state: 'missing', reason: `第${run}轮已淘汰，不回退当前轮` }
          else {
            const text = view === 'delegation' ? prompt : reportText(owner, run)
            const content = fragment(text, Number(cursor || 0))
            payload = { ...base, state: content.hasMore ? 'partial' : 'complete', ...(content.hasMore ? { nextCursor: String(content.offset + content.text.length) } : {}),
              ...(view === 'delegation' ? { delegation: { scope: 'task', prompt: content, description: part('脱敏任务说明') } } : { report: { source: run === 9 ? 'task.result' : 'runHistory', taskStatus: run === 9 ? sessions[owner].task.status : run === 7 ? 'failed' : 'killed', reportStatus: 'incomplete', content, error: part('真实停止/失败原因 [REDACTED]') } }) }
          }
          const hold = state.hold
          const held = hold?.owner === owner && !hold.started
          if (held) { hold.started = true; await hold.gate; hold.connectionClosed = res.destroyed }
          json(res, payload)
          if (held) hold.writeAttempted = true
          return
        }
        json(res, {}); return
      }
      const path = resolve(dist, url.pathname === '/' ? 'index.html' : '.' + url.pathname)
      if (!path.startsWith(resolve(dist) + sep)) { res.writeHead(403); res.end(); return }
      res.setHeader('Content-Type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }[extname(path)] || 'application/octet-stream')
      res.end(await readFile(path))
    } catch (error) { errors.push(`fixture: ${error.stack}`); if (!res.headersSent && !res.destroyed) json(res, {}, 500); else res.end() }
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, permissions: ['clipboard-read', 'clipboard-write'] })
  const page = await context.newPage(); page.setDefaultTimeout(8000)
  page.on('pageerror', e => errors.push(e.stack || e.message))
  t.after(async () => {
    state.hold?.release(); await context.close()
    for (const c of clients) c.res.destroy()
    server.closeAllConnections(); await new Promise(r => server.close(r))
    assert.deepEqual(errors, []); assert.deepEqual(requests.filter(r => r.method !== 'GET'), [])
  })
  await page.goto(`http://127.0.0.1:${server.address().port}/`)
  await until(() => clients.size > 0, 'No native SSE connection')
  assert.match(await page.evaluate(() => navigator.userAgent), /Edg\//)
  const modal = page.locator('.background-task-modal'), reader = modal.locator('.agent-content-reader')
  return { page, modal, reader, state, sessions, requests,
    async sync(owner = 'A') {
      await until(() => [...clients].some(c => c.owner === owner), 'No scoped SSE client')
      for (const c of clients) if (c.owner === owner) { c.res.write(`event: sync\ndata: ${JSON.stringify(snapshot(owner))}\n\n`); state.delivered++ }
    },
    async open() {
      if (await page.locator('.background-task-section > .background-task-summary').count()) await page.locator('.background-task-section > .background-task-summary').click()
      else { await page.locator('.background-task-history summary').click(); await page.locator('.background-task-history-item').first().click() }
      await reader.waitFor()
    },
  }
}
async function finish(reader) {
  const button = reader.getByRole('button', { name: '加载剩余保存内容', exact: true })
  await button.waitFor(); await button.click()
  await until(async () => await reader.getByRole('button', { name: '加载剩余保存内容', exact: true }).count() === 0, 'Pagination did not drain')
}
async function view(reader, name) { await reader.getByRole('button', { name, exact: true }).click() }
async function narrow(page, modal, reader) {
  await page.setViewportSize({ width: 390, height: 844 }); await sleep(150)
  const geometry = await page.evaluate(() => ({ viewport: innerWidth, doc: document.documentElement.scrollWidth, client: document.documentElement.clientWidth, body: document.body.scrollWidth }))
  const m = await modal.boundingBox(), r = await reader.boundingBox()
  assert.ok(geometry.doc <= geometry.client && geometry.body <= geometry.viewport && m.x >= 0 && m.x + m.width <= 390 && r.width <= m.width,
    `390px horizontal overflow: ${JSON.stringify({ geometry, m, r })}`)
  assert.ok(await reader.evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'Reader outer horizontal overflow')
}

test('App native SSE: live visible preview, task delegation pagination, 40 timeline records/long item/tools, all view retries', { timeout: 60000 }, async t => {
  const f = await fixture(t), { page, reader } = f
  await f.open(); await reader.getByText('LIVE_A_1', { exact: true }).waitFor()
  const stateReads = f.requests.filter(r => r.path === '/api/state').length
  f.sessions.A.task.progress.visibleText.text = 'LIVE_A_2_FROM_NATIVE_SSE'
  await f.sync(); await reader.getByText('LIVE_A_2_FROM_NATIVE_SSE', { exact: true }).waitFor()
  assert.equal(f.requests.filter(r => r.path === '/api/state').length, stateReads)
  assert.doesNotMatch(await reader.innerText(), /TECH_LOG_ONLY|TECH_STEP_ONLY|FORBIDDEN_LEGACY_TEXT/)
  await f.modal.locator('summary').filter({ hasText: '辅助技术日志与最近步骤' }).click()
  assert.match(await f.modal.innerText(), /TECH_LOG_ONLY/)
  await f.modal.locator('summary').filter({ hasText: '辅助技术日志与最近步骤' }).click()
  await view(reader, '脱敏委派'); await finish(reader)
  assert.equal(await reader.locator('.background-task-command').textContent(), prompt)
  assert.match(await reader.innerText(), /scope=task/); assert.match(await reader.innerText(), /不是指定轮次的 resume 指令/)
  await view(reader, '正文与完整过程'); await finish(reader)
  assert.equal(await reader.locator('article').count(), 40)
  const long = reader.locator('article').filter({ hasText: '记录 1000:0' })
  await long.locator('summary').click(); assert.equal(await long.locator('pre').textContent(), longBody)
  assert.match(await reader.innerText(), /实际对象：C:\/authorized\/actual-object.txt/)
  assert.match(await reader.innerText(), /调用 ID：call-real-1 · 调用状态：invoked/)
  assert.match(await reader.innerText(), /调用 ID：call-real-1 · 调用状态：failed/)
  assert.match(await reader.innerText(), /结果摘要.*permission denied/)
  f.sessions.A.items.push({ id: '4000:0', kind: 'assistant', messageId: 'm40', text: 'APPENDED_SAVED_BODY' })
  await reader.getByText('APPENDED_SAVED_BODY', { exact: true }).first().waitFor({ timeout: 8000 })
  await reader.getByRole('button', { name: '增量刷新已保存过程', exact: true }).click()
  await until(async () => !(await reader.getByRole('button', { name: '增量刷新已保存过程', exact: true }).isDisabled()), 'Refresh unfinished')
  assert.equal(await reader.locator('article').count(), 41)
  await narrow(page, f.modal, reader)
  await page.setViewportSize({ width: 1440, height: 1000 })
  for (const bad of [{ channel: 'unknown', runGeneration: 9 }, { channel: 'visible', runGeneration: 8 }]) {
    f.sessions.A.task.progress.visibleText = { ...bad, text: 'REJECTED_EVENT_PREVIEW', truncated: false }
    await f.sync()
    await until(async () => !(await reader.innerText()).includes('LIVE_A_2_FROM_NATIVE_SSE'), 'Unsafe/old preview did not clear')
    assert.doesNotMatch(await reader.innerText(), /REJECTED_EVENT_PREVIEW/)
  }
  for (const [key, label] of [['delegation', '脱敏委派'], ['timeline', '正文与完整过程'], ['report', '指定轮次报告']]) {
    await view(reader, label)
    await until(async () => await reader.getByRole('button', { name: '取消只读加载', exact: true }).count() === 0, 'Initial view load unfinished')
    f.state.failView = key
    await reader.getByRole('button', { name: '重新读取快照', exact: true }).click()
    await reader.getByRole('alert').waitFor(); assert.match(await reader.innerText(), /HTTP 503/)
    await reader.getByRole('button', { name: '重试读取（重新建立快照）', exact: true }).click()
    await until(async () => await reader.getByRole('alert').count() === 0 && await reader.getByRole('button', { name: '取消只读加载', exact: true }).count() === 0, `Retry failed: ${key}`)
  }
  await narrow(page, f.modal, reader)
  t.diagnostic(`Native SSE delivered=${f.state.delivered}; all three view retries and >24/8 records passed; GET=${f.requests.length}`)
})

test('App terminal report: safe Markdown, preview/full clipboard/download, 8 archived runs, eviction, main reader and delivery', { timeout: 60000 }, async t => {
  const f = await fixture(t, { status: 'killed' }), { page, reader, modal } = f
  await f.open(); await reader.getByRole('heading', { name: '安全报告', exact: true }).waitFor()
  assert.equal(await reader.locator('img, script, [onerror], a[href^="javascript:"]').count(), 0)
  assert.equal(await page.evaluate(() => window.agentAppXss), undefined)
  assert.equal(await reader.locator('ul li').count(), 2); assert.equal(await reader.locator('pre code').count(), 1)
  assert.equal(await reader.getByRole('link', { name: '安全链接', exact: true }).getAttribute('rel'), 'noreferrer noopener')
  await reader.getByRole('button', { name: '复制已加载预览', exact: true }).click()
  await until(async () => (await page.evaluate(() => navigator.clipboard.readText())).includes('已加载预览'), 'Preview clipboard missing')
  assert.doesNotMatch(await page.evaluate(() => navigator.clipboard.readText()), /REPORT-END/)
  await reader.getByRole('button', { name: '加载并复制已保存报告全文', exact: true }).click()
  await until(async () => (await page.evaluate(() => navigator.clipboard.readText())).includes('REPORT-END'), 'Full clipboard missing')
  const copied = (await page.evaluate(() => navigator.clipboard.readText())).replaceAll('\r\n', '\n')
  assert.ok(copied.includes(reportText('A', 9))); assert.match(copied, /报告未完成：incomplete/); assert.match(copied, /任务状态：killed/)
  const downloading = page.waitForEvent('download')
  await reader.getByRole('button', { name: '加载并下载已保存报告全文', exact: true }).click()
  const download = await downloading
  assert.ok((await readFile(await download.path(), 'utf8')).includes(reportText('A', 9)))
  const nav = modal.getByRole('navigation', { name: '代理轮次选择', exact: true })
  assert.equal(await nav.getByRole('button').count(), 9)
  for (let run = 1; run <= 8; run++) {
    await nav.getByRole('button', { name: new RegExp(`^第 ${run} 轮 ·`) }).click()
    await until(async () => (await reader.innerText()).includes(`REPORT_A_RUN_${run}`), `Archive ${run} not loaded`)
    assert.doesNotMatch(await reader.innerText(), /REPORT_A_RUN_9|LIVE_A_1/)
    assert.ok(f.requests.some(r => r.path === '/api/agent-content' && r.query.runGeneration === String(run) && r.query.view === 'report'))
  }
  f.state.missingRuns.add(1)
  await nav.getByRole('button', { name: /^第 1 轮 ·/ }).click()
  await reader.getByText(/第1轮已淘汰/).waitFor()
  assert.doesNotMatch(await reader.innerText(), /REPORT_A_RUN_9/)
  assert.equal(await reader.locator('.markdown-body').count(), 0)
  // The selected archived metadata disappearing via native SSE must not select current.
  f.sessions.A.task.runHistory = f.sessions.A.task.runHistory.filter(r => r.runGeneration !== 1)
  await f.sync(); await modal.getByText('该轮次记录已清理，不可获取；不会回退到当前轮次。', { exact: true }).waitFor()
  assert.equal(await reader.count(), 0)
  await nav.getByRole('button', { name: '当前第 9 轮', exact: true }).click()
  await reader.getByRole('heading', { name: '安全报告', exact: true }).waitFor()
  const delivery = modal.locator('details').filter({ has: page.locator('summary', { hasText: '消息交付与辅助信息' }) })
  assert.equal(await delivery.getAttribute('open'), null)
  await delivery.locator('summary').click(); assert.match(await delivery.innerText(), /待交付\s*2/); assert.match(await delivery.innerText(), /本轮最近已交付\s*3/)
  assert.match(await delivery.innerText(), /不代表采纳或完成/)
  const dimensions = await reader.evaluate(el => ({ reader: el.getBoundingClientRect().width, parent: el.parentElement.getBoundingClientRect().width, oldGrid: !!el.closest('.background-task-agent-grid') }))
  assert.ok(dimensions.reader >= dimensions.parent * 0.9 && !dimensions.oldGrid, `Report not primary-width: ${JSON.stringify(dimensions)}`)
  await finish(reader); await narrow(page, modal, reader)
  t.diagnostic('All 8 archived generations, current, API eviction and SSE metadata eviction validated; full export beyond preview, delivery remains accessible.')
})

test('App central grouped and ungrouped subagent_get independent calls use result task_id/run_generation', { timeout: 45000 }, async t => {
  const f = await fixture(t, { status: 'killed', lines: callLines() }), { page } = f
  const group = page.locator('.tool-group-trigger').first(); await group.waitFor()
  assert.equal(await page.locator('.tool-group-purpose').count(), 2)
  assert.deepEqual(await page.locator('.tool-group-purpose').allTextContents(), ['重复委派读取目的', '重复委派读取目的'])
  await group.click()
  const buttons = page.locator('.tool-result-summary .image2-detail-button')
  assert.equal(await buttons.count(), 3, 'Two grouped and one primary independent tool card required')
  for (const [i, run] of [1, 8, 9].entries()) {
    await buttons.nth(i).focus(); await page.keyboard.press('Enter')
    const reader = page.locator('.tool-result-modal .agent-content-reader')
    await reader.getByRole('heading', { name: '安全报告', exact: true }).waitFor()
    assert.match(await reader.innerText(), new RegExp(`REPORT_A_RUN_${run}`))
    assert.ok(f.requests.some(r => r.path === '/api/tool-call-detail' && r.query.toolUseId === `c${i}` && r.query.sessionId === 'A'))
    assert.ok(f.requests.some(r => r.path === '/api/agent-content' && r.query.taskId === 'same-task' && r.query.runGeneration === String(run) && r.query.sessionId === 'A'))
    if (i === 2) await narrow(page, page.locator('.tool-result-modal'), reader)
    await page.keyboard.press('Escape'); await reader.waitFor({ state: 'detached' })
  }
  t.diagnostic('3 independent invocation detail requests resolve generations 1/8/9 from result, not input/current fallback; central reader uses same route.')
})

for (const navigation of ['new-session', 'session-switch']) {
  test(`App ${navigation}: real UI owner scope, same task/run, delayed old HTTP isolated`, { timeout: 40000 }, async t => {
    const f = await fixture(t, { status: 'killed' }), { page, reader, modal } = f
    const hold = { owner: 'A', started: false }; hold.gate = new Promise(r => { hold.release = r }); f.state.hold = hold
    await f.open(); await until(() => hold.started, 'Old owner request did not start')
    await page.keyboard.press('Escape')
    if (navigation === 'new-session') { await page.locator('.nav button').first().focus(); await page.keyboard.press('Enter') }
    else {
      await page.getByRole('button', { name: '会话管理', exact: true }).first().click()
      await page.locator('.session-card').filter({ hasText: 'Session B' }).getByRole('button', { name: '打开', exact: true }).click()
    }
    await until(async () => await page.evaluate(() => sessionStorage.getItem('neoctl-web.sessionId')) === 'B', 'Real UI did not bind owner B')
    await page.locator('.background-task-history-item').filter({ hasText: 'B:same-task' }).waitFor({ state: 'attached' })
    // History details can remain expanded; click actual entry rather than modifying state.
    const history = page.locator('.background-task-history')
    if (await history.getAttribute('open') === null) await history.locator('summary').click()
    await history.locator('button').filter({ hasText: 'B:same-task' }).click()
    await until(async () => (await reader.innerText()).includes('REPORT_B_RUN_9'), 'B report missing')
    await page.evaluate(() => {
      window.agentLateLeak = false
      const observer = new MutationObserver(() => { if (document.querySelector('.background-task-modal')?.textContent.includes('REPORT_A_RUN_9')) window.agentLateLeak = true })
      observer.observe(document.body, { childList: true, characterData: true, subtree: true })
    })
    hold.release(); await until(() => hold.writeAttempted, 'Held HTTP response never released'); await sleep(1000)
    assert.doesNotMatch(await modal.innerText(), /REPORT_A_RUN_9/)
    assert.equal(await page.evaluate(() => window.agentLateLeak), false)
    assert.match(await reader.innerText(), /REPORT_B_RUN_9/)
    for (const owner of ['A', 'B']) assert.ok(f.requests.some(r => r.path === '/api/agent-content' && r.query.sessionId === owner && r.query.taskId === 'same-task' && r.query.runGeneration === '9'))
    t.diagnostic(`Real ${navigation}: delayed A released after B rendered; abort=${hold.connectionClosed}; scoped native SSE and GET, no storage/Vue writes.`)
  })
}
