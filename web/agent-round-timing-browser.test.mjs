// Real built App + Edge + native HTTP/SSE. No model/tool execution, request routing,
// EventSource/Date/timer replacement, or Vue state mutation. Only DOM evidence is observed.
// Run: npm --prefix web run build && node --test web/agent-round-timing-browser.test.mjs
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
assert.ok(playwright, 'Set PLAYWRIGHT_CORE_PATH to an installed playwright-core directory')
const browser = await playwright.chromium.launch({ channel: 'msedge', headless: true })
after(() => browser.close())
const dist = fileURLToPath(new URL('./dist/', import.meta.url))
const sleep = ms => new Promise(r => setTimeout(r, ms))
const iso = ms => new Date(ms).toISOString()
const terminalStatuses = ['completed', 'failed', 'killed']
async function until(predicate, message, timeout = 7000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { if (await predicate()) return; await sleep(40) }
  assert.fail(message)
}
function finishedRun(runGeneration, status = 'completed', durationMs = 1200 + runGeneration * 1000) {
  const start = Date.now() - 3600000 + runGeneration * 20000
  return { runGeneration, status, startedAt: iso(start), completedAt: iso(start + durationMs), durationMs,
    result: { status: status === 'completed' ? 'completed' : 'incomplete', content: `HISTORY_RUN_${runGeneration}_ONLY`, truncated: false } }
}
function agent(taskId, runGeneration = 1, extra = {}) {
  return { kind: 'agent', taskId, agentId: `agent-${taskId}`, ownerSessionId: 'round-owner',
    description: `Task ${taskId}`, status: 'running', runGeneration,
    // Deliberately far from startedAt: task creation must never become a run clock.
    createdAt: iso(Date.now() - 86400000), startedAt: iso(Date.now() - 18000),
    pendingMessageCount: 0, deliveredRetainedThisRun: 0, output: '',
    progress: { currentAction: '', steps: [], totalToolUseCount: 0 }, runHistory: [], ...extra }
}
function terminalTask(taskId = 'terminal-history') {
  return { kind: 'terminal', taskId: `terminal:${taskId}`, sessionId: taskId, ownerSessionId: 'round-owner',
    description: `Task ${taskId}`, command: 'echo fixture-only-not-executed', status: 'exited',
    createdAt: Date.now() - 20000, completedAt: iso(Date.now() - 19000), durationMs: 1000,
    exitCode: 0, terminationReason: 'completed', shell: 'powershell' }
}
const centralLines = [
  { id: 1, kind: 'user', text: 'Read-only round timing regression' },
  ...['DUPLICATE_PURPOSE', 'DUPLICATE_PURPOSE', 'LAST_PURPOSE'].map((purpose, i) => ({
    id: i + 2, kind: 'tool', toolName: 'file_read', toolUseId: `preserved-call-${i}`, messageId: `result-${i}`,
    titleStatus: 'success', text: `retained preview ${i}`, toolDisplay: { purpose, facts: [], previews: [] },
  })),
]
const part = text => ({ text, state: 'complete', reason: 'saved read-only fixture' })
const fragment = text => ({ ...part(text), offset: 0, totalChars: text.length, hasMore: false })

async function fixture(t, tasks) {
  const clients = new Set(), requests = [], errors = []
  let syncCount = 0
  const snapshot = () => {
    const active = tasks.filter(task => task.status === 'running' || task.status === 'pending')
    return observabilitySnapshot({ lines: centralLines, session: { sessionId: 'round-owner', title: 'Round timing regression' },
      backgroundTasks: active, backgroundTaskCount: active.length,
      agentTaskHistory: tasks.filter(task => task.kind === 'agent' && terminalStatuses.includes(task.status)),
      terminalTaskHistory: tasks.filter(task => task.kind === 'terminal' && task.status !== 'running') })
  }
  const json = (res, value, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(value))
  }
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost'), q = url.searchParams
      if (url.pathname.startsWith('/api/') || url.pathname === '/events') {
        requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(q) })
        if (req.method !== 'GET') { json(res, { error: 'No mutation/model/tool execution allowed' }, 405); return }
        if (url.pathname === '/events') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
          res.write(`event: sync\ndata: ${JSON.stringify(snapshot())}\n\n`)
          clients.add(res); res.on('close', () => clients.delete(res)); return
        }
        if (url.pathname === '/api/state') { json(res, snapshot()); return }
        if (url.pathname === '/api/sessions') { json(res, { sessions: [] }); return }
        if (url.pathname === '/api/agent-content') {
          assert.equal(q.get('sessionId'), 'round-owner')
          const task = tasks.find(task => task.taskId === q.get('taskId'))
          assert.ok(task, 'Reader must request the selected real task identity')
          const generation = Number(q.get('runGeneration'))
          const run = task.runGeneration === generation ? task : task.runHistory.find(run => run.runGeneration === generation)
          assert.ok(run, `Reader must request a retained, explicit generation: requested ${task.taskId}/${generation}; current=${task.runGeneration}, history=${task.runHistory.map(run => run.runGeneration)}; URL=${url.pathname}${url.search}`)
          const base = { ownerSessionId: task.ownerSessionId, taskId: task.taskId, runGeneration: generation,
            state: 'complete', reason: 'saved fixture', snapshotId: `${task.taskId}-${generation}` }
          const marker = `CONTENT_${task.taskId}_RUN_${generation}_ONLY`
          if (q.get('view') === 'delegation') {
            json(res, { ...base, delegation: { scope: 'task', description: part(task.description), prompt: fragment('TASK_LEVEL_DELEGATION_ONLY') } }); return
          }
          if (q.get('view') === 'timeline') {
            json(res, { ...base, items: [{ id: `${generation}:0`, kind: 'assistant', messageId: `visible-${generation}`, content: fragment(marker) }] }); return
          }
          assert.equal(q.get('view'), 'report')
          json(res, { ...base, report: { source: run === task ? 'current' : 'runHistory', taskStatus: run.status,
            reportStatus: run.result?.status || 'incomplete', content: fragment(`${marker}\n${run.result?.content || ''}`), error: part(run.error || '') } }); return
        }
        if (url.pathname === '/api/terminal-output') {
          const task = tasks.find(task => task.kind === 'terminal' && task.sessionId === q.get('runId'))
          assert.ok(task); assert.equal(q.get('sessionId'), task.ownerSessionId)
          json(res, { sessionId: task.ownerSessionId, runId: task.sessionId, stream: q.get('stream'), offset: 0,
            nextOffset: 0, text: '', endOfStoredOutput: true, record: { runId: task.sessionId, ownerSessionId: task.ownerSessionId,
              metadata: { startedAt: task.createdAt, tty: false }, lifecycle: 'terminal', availability: 'available', truncated: false, expiresAt: Date.now() + 300000,
              exit: { status: task.status, exitCode: task.exitCode, signal: null, terminationReason: task.terminationReason, durationMs: task.durationMs },
              streams: { stdout: { storedBytes: 0, observedBytes: 0 }, stderr: { storedBytes: 0, observedBytes: 0 } } } }); return
        }
        json(res, {}); return
      }
      const path = resolve(dist, url.pathname === '/' ? 'index.html' : '.' + url.pathname)
      if (!path.startsWith(resolve(dist) + sep)) { res.writeHead(403); res.end(); return }
      res.setHeader('Content-Type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }[extname(path)] || 'application/octet-stream')
      res.end(await readFile(path))
    } catch (error) {
      errors.push(`fixture: ${error.stack}`)
      if (!res.headersSent && !res.destroyed) json(res, {}, 500)
      else res.end()
    }
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  page.setDefaultTimeout(7000)
  page.on('pageerror', e => errors.push(e.stack || e.message))
  t.after(async () => {
    await context.close()
    for (const res of clients) res.destroy()
    server.closeAllConnections()
    await new Promise(r => server.close(r))
    assert.deepEqual(errors, [], 'No browser/server exceptions')
    assert.deepEqual(requests.filter(r => r.method !== 'GET'), [], 'All HTTP is GET-only; no resume/model/tool execution')
    t.diagnostic(`${requests.length} GET requests; ${syncCount} pushed sync frames; native Edge SSE, no browser state/network overrides`)
  })
  const url = `http://127.0.0.1:${server.address().port}/`
  await page.goto(url)
  await until(() => clients.size > 0, 'Native SSE did not connect')
  await page.locator('.tool-group-message').waitFor()
  assert.match(await page.evaluate(() => navigator.userAgent), /Edg\//)
  const modal = page.locator('.background-task-modal')
  const meta = label => modal.locator('.background-task-meta > div').filter({ has: page.locator('dt', { hasText: new RegExp(`^${label}$`) }) }).locator('dd')
  return { page, modal, tasks, requests, snapshot, meta,
    async sync() {
      await until(() => clients.size > 0, 'SSE disconnected')
      for (const res of clients) { res.write(`event: sync\ndata: ${JSON.stringify(snapshot())}\n\n`); syncCount++ }
    },
    async open(task = tasks[0]) {
      if (await modal.count()) {
        const item = modal.locator('.background-task-index-item').filter({ hasText: task.description })
        if (await item.count()) await item.click()
      } else if (task.status === 'running' || task.status === 'pending') {
        await page.locator('.background-task-section > .background-task-summary').click()
        if (tasks.filter(task => task.status === 'running' || task.status === 'pending')[0] !== task) {
          await modal.locator('.background-task-index-item').filter({ hasText: task.description }).click()
        }
      } else {
        const history = page.locator('.background-task-history')
        if (await history.getAttribute('open') === null) await history.locator('summary').click()
        await history.locator('.background-task-history-item').filter({ hasText: task.description }).click()
      }
      await modal.waitFor()
      await until(async () => await modal.locator('.background-task-detail-title strong').innerText() === task.description, `Wrong selected task: ${task.taskId}`)
    },
  }
}
function milliseconds(text) {
  if (/^\d+(?:\.\d+)?ms$/.test(text)) return Number(text.slice(0, -2))
  if (/^\d+(?:\.\d+)?s$/.test(text)) return Number(text.slice(0, -1)) * 1000
  assert.fail(`Expected a finite sub-minute duration, received ${JSON.stringify(text)}`)
}
async function elapsed(f) { return milliseconds(await f.meta('本轮耗时').innerText()) }
async function grows(f) {
  const first = await elapsed(f)
  await until(async () => await elapsed(f) > first, 'Running elapsed time did not tick without SSE/HTTP state refresh', 4000)
  const second = await elapsed(f)
  await until(async () => await elapsed(f) > second, 'Running elapsed time stopped after one tick', 4000)
  return [first, second, await elapsed(f)]
}
async function watchCentral(page) {
  await page.evaluate(() => {
    window.roundDomObserver?.disconnect()
    const nodes = [...document.querySelectorAll('.tool-group-message, .tool-group-message > .tool-group-shell > .tool-group-trigger, .tool-group-message > .tool-group-shell > .tool-group-purposes > .tool-group-purpose')]
    window.roundDomEvidence = { nodes, removed: false, header: document.querySelector('.tool-group-trigger').textContent,
      purposes: [...document.querySelectorAll('.tool-group-purpose')].map(el => el.textContent) }
    window.roundDomObserver = new MutationObserver(records => {
      if (nodes.some(node => !node.isConnected) || records.some(record => [...record.removedNodes].some(removed => nodes.some(node => removed === node || removed.contains?.(node))))) window.roundDomEvidence.removed = true
    })
    window.roundDomObserver.observe(document.body, { subtree: true, childList: true })
  })
}
async function preservedCentral(page) {
  const evidence = await page.evaluate(() => ({ removed: window.roundDomEvidence.removed,
    sameNodes: window.roundDomEvidence.nodes.every(node => node.isConnected),
    header: document.querySelector('.tool-group-trigger').textContent, oldHeader: window.roundDomEvidence.header,
    purposes: [...document.querySelectorAll('.tool-group-purpose')].map(el => el.textContent), oldPurposes: window.roundDomEvidence.purposes }))
  assert.equal(evidence.removed, false, 'Read-only task navigation/timing/SSE rebuilt a central group/header/purpose node')
  assert.equal(evidence.sameNodes, true)
  assert.equal(evidence.header, evidence.oldHeader)
  assert.deepEqual(evidence.purposes, ['DUPLICATE_PURPOSE', 'DUPLICATE_PURPOSE', 'LAST_PURPOSE'])
  assert.deepEqual(evidence.purposes, evidence.oldPurposes)
}
async function keyboardActivate(page, locator, key = 'Enter') {
  await locator.focus()
  assert.equal(await locator.evaluate(el => el === document.activeElement), true)
  await page.keyboard.press(key)
}

for (const generation of [1, 2, 11]) {
  test(`generation ${generation}: real clock grows repeatedly; server start survives reload; empty logs are not progress`, { timeout: 30000 }, async t => {
    const task = agent(`running-${generation}`, generation, { runHistory: generation === 11 ? Array.from({ length: 8 }, (_, i) => finishedRun(i + 3)) : generation === 2 ? [finishedRun(1)] : [] })
    const f = await fixture(t, [task])
    await f.open(); await watchCentral(f.page)
    assert.equal(await f.meta('轮次').innerText(), `第 ${generation} 轮`)
    assert.ok(Math.abs(await elapsed(f) - (Date.now() - Date.parse(task.startedAt))) < 2000, 'Clock must use server startedAt, not createdAt or modal-open time')
    const stateReads = f.requests.filter(r => r.path === '/api/state').length
    const samples = await grows(f)
    assert.equal(f.requests.filter(r => r.path === '/api/state').length, stateReads)
    const logs = f.modal.locator('details').filter({ has: f.page.getByText('辅助技术日志与最近步骤', { exact: true }) })
    assert.equal(await logs.getAttribute('open'), null, 'Technical logs must be auxiliary and collapsed')
    assert.equal(await logs.locator('section.background-task-progress-section').count(), 0, 'Empty currentAction/steps must not render a progress log')
    await logs.locator('summary').click()
    assert.match(await logs.innerText(), /未提供/)
    await logs.locator('summary').click()
    await f.sync(); await preservedCentral(f.page)
    await f.page.keyboard.press('Escape'); await f.modal.waitFor({ state: 'detached' })
    await f.page.reload(); await f.open()
    assert.ok(await elapsed(f) >= samples.at(-1) - 1000, 'Reload reset the run clock')
    assert.ok(Math.abs(await elapsed(f) - (Date.now() - Date.parse(task.startedAt))) < 2000)
    await grows(f)
    t.diagnostic(`generation ${generation}: timer samples ${samples.join(' < ')} ms; refresh used unchanged server start ${task.startedAt}`)
  })
}

for (const status of terminalStatuses) {
  test(`native SSE ${status}: freezes selected task, reopen/reload; resume only new generation grows`, { timeout: 35000 }, async t => {
    const task = agent(`transition-${status}`)
    const f = await fixture(t, [task, agent('other-running')])
    await f.open(); await watchCentral(f.page)
    const stateReads = f.requests.filter(r => r.path === '/api/state').length
    const frozen = 12340
    Object.assign(task, { status, completedAt: iso(Date.parse(task.startedAt) + frozen), durationMs: frozen,
      result: { status: status === 'completed' ? 'completed' : 'incomplete', content: `FINAL_${status}` } })
    await f.sync()
    await until(async () => await f.modal.locator('.background-task-detail-head .tool-result-modal-status').innerText() === ({ completed: '已完成', failed: '失败', killed: '已停止' })[status], 'Terminal SSE did not reach selected header')
    const frozenText = await f.meta('本轮耗时').innerText()
    assert.equal(milliseconds(frozenText), 12000)
    await sleep(2200)
    assert.equal(await f.meta('本轮耗时').innerText(), frozenText)
    assert.equal(f.requests.filter(r => r.path === '/api/state').length, stateReads, 'Transition must use SSE, not state reload')
    assert.equal(await f.modal.locator('.background-task-index-item.active').count(), 1)
    assert.match(await f.modal.locator('.background-task-index-item.active').innerText(), new RegExp(task.description))
    await preservedCentral(f.page)
    await f.page.keyboard.press('Escape'); await f.open(task)
    assert.equal(await f.meta('本轮耗时').innerText(), frozenText)
    await f.page.reload(); await f.open(task)
    assert.equal(await f.meta('本轮耗时').innerText(), frozenText)
    const archived = { runGeneration: task.runGeneration, status: task.status, startedAt: task.startedAt,
      completedAt: task.completedAt, durationMs: task.durationMs, result: task.result }
    const archivedJson = JSON.stringify(archived)
    Object.assign(task, { runGeneration: 2, status: 'running', startedAt: iso(Date.now() - 1500), runHistory: [archived] })
    delete task.completedAt; delete task.durationMs; delete task.result
    await f.sync()
    await until(async () => await f.meta('轮次').innerText() === '第 2 轮', 'Resume SSE did not select new current generation')
    assert.ok(await elapsed(f) < 6000, 'Resume inherited prior generation/task creation clock')
    const archivedButton = f.modal.getByRole('navigation', { name: '代理轮次选择', exact: true }).getByRole('button', { name: /^第 1 轮/ })
    assert.ok((await archivedButton.innerText()).endsWith(`本轮耗时 ${frozenText}`))
    await grows(f)
    assert.ok((await archivedButton.innerText()).endsWith(`本轮耗时 ${frozenText}`), 'Prior terminal generation must remain frozen in the actual DOM while resumed current generation grows')
    assert.equal(JSON.stringify(task.runHistory[0]), archivedJson, 'Fixture archive facts are immutable across resume')
    t.diagnostic(`Frozen ${status}=${frozenText}; resumed generation2 grows while archive1 DOM remains ${frozenText}. Resume is a server fixture transition, not POST resume/model execution.`)
  })
}

const unknownCases = [
  ['legacy-created-only', { startedAt: undefined }],
  ['missing-run-start', { runGeneration: 2, startedAt: undefined }],
  ['invalid-start', { startedAt: 'not-a-date' }],
  ['numeric-start', { startedAt: 12345 }],
  ['future-start', { startedAt: iso(Date.now() + 86400000) }],
  ['pending', { status: 'pending' }],
  ['terminal-missing-facts', { status: 'completed', completedAt: undefined, durationMs: undefined }],
  ['terminal-invalid-end', { status: 'failed', completedAt: 'invalid', durationMs: 1000 }],
  ['terminal-negative', { ...finishedRun(1, 'killed'), durationMs: -1 }],
  ['terminal-mismatch', { ...finishedRun(1), durationMs: 999 }],
  ['terminal-string-duration', { ...finishedRun(1), durationMs: '2200' }],
  ['terminal-before-start', { ...finishedRun(1), completedAt: iso(Date.now() - 86400000), durationMs: 0 }],
]
test('legacy/malformed timing remains unknown, while consistent zero duration is valid and frozen', { timeout: 30000 }, async t => {
  const tasks = unknownCases.map(([id, extra]) => agent(id, 1, extra))
  const zero = agent('valid-zero', 1, finishedRun(1, 'completed', 0)); tasks.push(zero)
  const f = await fixture(t, tasks)
  await f.open(tasks[0]); await watchCentral(f.page)
  for (const task of tasks) {
    await f.open(task)
    assert.equal(await f.meta('本轮耗时').innerText(), task === zero ? '0ms' : '未提供', `${task.taskId}: never fabricate a duration from old creation or invalid facts`)
  }
  await sleep(1500)
  assert.equal(await f.meta('本轮耗时').innerText(), '0ms')
  await f.open(tasks[0]); await sleep(1100)
  assert.equal(await f.meta('本轮耗时').innerText(), '未提供')
  await f.sync(); await preservedCentral(f.page)
  t.diagnostic(`${unknownCases.length} unknown cases + consistent 0ms exercised through real App task selection`)
})

test('generation 11 retains all eight distinct archives (3..10), not the obsolete three-round limit', { timeout: 15000 }, async t => {
  const task = agent('eight-archives', 11, { runHistory: Array.from({ length: 8 }, (_, i) => finishedRun(i + 3, terminalStatuses[i % 3])) })
  const f = await fixture(t, [task]); await f.open()
  const nav = f.modal.getByRole('navigation', { name: '代理轮次选择', exact: true })
  assert.equal(await nav.getByRole('button').count(), 9)
  const labels = await nav.getByRole('button').allTextContents()
  assert.deepEqual(labels.map(text => Number(text.match(/第\s*(\d+)\s*轮/)[1])), [11, 10, 9, 8, 7, 6, 5, 4, 3])
  for (const run of task.runHistory) {
    const label = labels.find(text => new RegExp(`^第 ${run.runGeneration} 轮`).test(text))
    const actual = milliseconds(label.split('本轮耗时 ')[1])
    assert.ok(Math.abs(actual - run.durationMs) <= 500, `${run.runGeneration}: historical duration must use its own persisted facts`)
  }
  await sleep(1300)
  assert.deepEqual(await nav.getByRole('button').allTextContents(), labels, 'All eight historical durations stay frozen')
  assert.doesNotMatch(await f.modal.innerText(), /最近\s*3\s*轮/)
  t.diagnostic('All nine real buttons: current11 + history10..3; historical completed/failed/killed values 4.2s..11.2s are independently correct and frozen.')
})

test('OBS09 mixed running/terminal task navigation, main+N preserved, 390px independent scroll and keyboard close', { timeout: 30000 }, async t => {
  const longResult = Array.from({ length: 80 }, (_, i) => `SAVED_REPORT_LINE_${i} ${'report words '.repeat(8)}`).join('\n')
  const tasks = [agent('first-running'), agent('second-running', 2), agent('done', 11, { ...finishedRun(11), result: { status: 'completed', content: longResult }, runHistory: Array.from({ length: 8 }, (_, i) => finishedRun(i + 3)) }),
    agent('failed', 2, finishedRun(2, 'failed')), agent('killed', 2, finishedRun(2, 'killed')), terminalTask()]
  const f = await fixture(t, tasks)
  const summary = f.page.locator('.background-task-section > .background-task-summary')
  const summaryText = await summary.innerText()
  assert.match(summaryText, /Task first-running/)
  assert.equal(await summary.locator('.background-task-more').innerText(), '+1')
  await f.open(); await watchCentral(f.page)
  assert.equal(await f.modal.locator('.background-task-modal-count').innerText(), '6')
  assert.equal(await f.modal.locator('.background-task-index-item').count(), 6)
  for (const task of tasks) {
    await f.open(task)
    assert.equal(await f.modal.locator('.background-task-index-item.active').count(), 1)
    assert.match(await f.modal.locator('.background-task-index-item.active').innerText(), new RegExp(task.description))
    assert.equal(await summary.innerText(), summaryText, 'Selected detail must not change compact main+N summary')
  }
  await f.modal.locator('.terminal-output-reader').waitFor()
  await until(() => f.requests.some(r => r.path === '/api/terminal-output'), 'Terminal history absent from allBackgroundTasks reader navigation')
  await f.open(tasks[2])
  const reader = f.modal.locator('.agent-content-reader')
  await until(async () => (await reader.innerText()).includes('SAVED_REPORT_LINE_79'), 'Saved long report must load before scroll/layout acceptance')
  const delivery = f.modal.locator('details').filter({ has: f.page.getByText('消息交付与辅助信息', { exact: true }) })
  assert.equal(await delivery.getAttribute('open'), null, 'Delivery is collapsed auxiliary information, not a second main column')
  assert.equal(await f.modal.locator('.background-task-agent-grid').count(), 0, 'No obsolete two-column report grid')
  const widths = await reader.evaluate(el => ({ reader: el.getBoundingClientRect().width, parent: el.parentElement.getBoundingClientRect().width }))
  assert.ok(Math.abs(widths.reader - widths.parent) <= 2, `Report must occupy its available reading width: ${JSON.stringify(widths)}`)
  await f.sync(); await preservedCentral(f.page)
  await f.page.setViewportSize({ width: 390, height: 844 }); await sleep(150)
  const geometry = await f.page.evaluate(() => {
    const modal = document.querySelector('.background-task-modal').getBoundingClientRect(), d = document.documentElement
    return { viewport: innerWidth, doc: d.scrollWidth, client: d.clientWidth, left: modal.left, right: modal.right, top: modal.top, bottom: modal.bottom }
  })
  const body = f.modal.locator('.background-task-detail-body')
  assert.equal(await body.evaluate(el => getComputedStyle(el).overflowY), 'auto')
  assert.ok(await body.evaluate(el => el.scrollHeight > el.clientHeight), 'Saved long report must actually overflow the independent detail scroller')
  const headBefore = await f.modal.locator('.tool-result-modal-head').boundingBox()
  await body.hover(); await f.page.mouse.wheel(0, 900)
  await until(async () => await body.evaluate(el => el.scrollTop) > 0, 'Real wheel did not scroll detail body')
  const headAfter = await f.modal.locator('.tool-result-modal-head').boundingBox()
  assert.equal(headAfter.y, headBefore.y, 'Scrolling moved close/navigation header')
  await keyboardActivate(f.page, f.modal.locator('.background-task-index-item').nth(1))
  await until(async () => await f.meta('轮次').innerText() === '第 2 轮', 'Keyboard Enter failed to select running generation 2')
  await keyboardActivate(f.page, f.modal.locator('.background-task-index-item').first(), 'Space')
  await until(async () => await f.meta('轮次').innerText() === '第 1 轮', 'Keyboard Space failed to select generation 1')
  await keyboardActivate(f.page, f.modal.getByRole('button', { name: '关闭', exact: true }))
  await f.modal.waitFor({ state: 'detached' })
  t.diagnostic(`390px geometry=${JSON.stringify(geometry)}; actual wheel body scroll + fixed close header; Enter/Space task selection and Enter Close`)
  assert.ok(geometry.doc <= geometry.client && geometry.left >= 0 && geometry.right <= 390 && geometry.top >= 0 && geometry.bottom <= 844, `390px overflow: ${JSON.stringify(geometry)}`)
})

test('integration gate: App AgentContentReader current task identity via native GET', { timeout: 18000 }, async t => {
  const tasks = [agent('reader-running', 2), agent('reader-failed', 11, { ...finishedRun(11, 'failed'), runHistory: Array.from({ length: 8 }, (_, i) => finishedRun(i + 3)) })]
  const f = await fixture(t, tasks); await f.open()
  const reader = f.modal.locator('.agent-content-reader')
  assert.equal(await reader.count(), 1, 'Latest built App must mount AgentContentReader; integration is now mandatory, not a conditional skip')
  await watchCentral(f.page)
  for (const task of tasks) {
    await f.open(task)
    const marker = `CONTENT_${task.taskId}_RUN_${task.runGeneration}_ONLY`
    await until(async () => (await reader.innerText()).includes(marker), `Reader identity did not follow ${task.taskId}/${task.runGeneration}`)
    const other = tasks.find(candidate => candidate !== task)
    assert.doesNotMatch(await reader.innerText(), new RegExp(`CONTENT_${other.taskId}_RUN_`))
    assert.ok(f.requests.some(r => r.path === '/api/agent-content' && r.query.sessionId === task.ownerSessionId && r.query.taskId === task.taskId && Number(r.query.runGeneration) === task.runGeneration))
  }
  await preservedCentral(f.page)
})

test('historical selected-run reader navigation; resume follows current only; evicted old selection never falls back', { timeout: 30000 }, async t => {
  const task = agent('reader-history', 11, { runHistory: Array.from({ length: 8 }, (_, i) => finishedRun(i + 3, terminalStatuses[i % 3])) })
  const f = await fixture(t, [task]); await f.open(); await watchCentral(f.page)
  const nav = f.modal.getByRole('navigation', { name: '代理轮次选择', exact: true })
  const reader = f.modal.locator('.agent-content-reader')
  const shown = generation => until(async () => (await reader.innerText()).includes(`CONTENT_${task.taskId}_RUN_${generation}_ONLY`), `Reader did not display requested generation ${generation}`)
  await shown(11)
  for (const generation of [3, 7, 10]) {
    await nav.getByRole('button', { name: new RegExp(`^第 ${generation} 轮`) }).click()
    await shown(generation)
    assert.equal(await nav.locator('[aria-pressed="true"]').count(), 1)
    assert.match(await nav.locator('[aria-pressed="true"]').innerText(), new RegExp(`^第 ${generation} 轮`))
    assert.doesNotMatch(await reader.innerText(), /CONTENT_reader-history_RUN_11_ONLY/)
  }
  // Retained selection stays old while a new server round starts; no direct Vue access.
  const oldLabel = await nav.getByRole('button', { name: /^第 10 轮/ }).innerText()
  const run11 = { runGeneration: 11, status: 'completed', startedAt: task.startedAt,
    completedAt: iso(Date.parse(task.startedAt) + 9000), durationMs: 9000, result: { status: 'completed', content: 'RUN11_FINAL' } }
  Object.assign(task, { runGeneration: 12, startedAt: iso(Date.now() - 1800), runHistory: [...task.runHistory.slice(1), run11] })
  await f.sync(); await shown(10)
  await sleep(1300)
  assert.equal(await nav.getByRole('button', { name: /^第 10 轮/ }).innerText(), oldLabel)
  assert.match(await nav.locator('[aria-pressed="true"]').innerText(), /^第 10 轮/)
  await nav.getByRole('button', { name: /^当前第 12 轮/ }).click(); await shown(12)
  await grows(f)
  // Null/current selection follows generation13 automatically on SSE.
  Object.assign(task, { runGeneration: 13, startedAt: iso(Date.now() - 1700) })
  await f.sync(); await shown(13)
  assert.match(await nav.locator('[aria-pressed="true"]').innerText(), /^当前第 13 轮/)
  await nav.getByRole('button', { name: /^第 10 轮/ }).click(); await shown(10)
  const readsBefore = f.requests.filter(r => r.path === '/api/agent-content').length
  task.runHistory = task.runHistory.filter(run => run.runGeneration !== 10)
  await f.sync()
  await until(async () => (await f.modal.innerText()).includes('该轮次记录已清理'), 'Evicted historical selection must be explicitly unavailable')
  assert.equal(await reader.count(), 0)
  await sleep(1200)
  assert.equal(f.requests.filter(r => r.path === '/api/agent-content').length, readsBefore, 'Eviction must not silently read current generation')
  await nav.getByRole('button', { name: /^当前第 13 轮/ }).click(); await shown(13)
  await preservedCentral(f.page)
  t.diagnostic('Historical 3/7/10 owner/task/run GET identities; old10 frozen through resume12; current follows13; evicted10 unmounts without current fallback; central group/header/duplicate purposes retained.')
})
