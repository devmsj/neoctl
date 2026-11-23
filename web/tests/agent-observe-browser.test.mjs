// Built, unmodified App + real Edge + native SSE: switching the observed agent in place.
// Run: npm --prefix web run build && node --test web/tests/agent-observe-browser.test.mjs
// The fixture speaks the runtime protocol (sync/delta, ?observe=); only test data is mutated.
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { createServer } from 'node:http'
import { readFile, mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { extname, join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { observabilitySnapshot } from './observability-browser-fixture.mjs'
const require = createRequire(import.meta.url)
let playwright
for (const location of [process.env.PLAYWRIGHT_CORE_PATH, '../../desktop/.cache/ui-test/node_modules/playwright-core', join(tmpdir(), 'neoctl-observability-tests/node_modules/playwright-core'), 'playwright-core'].filter(Boolean)) {
  try { playwright = require(location); break } catch {}
}
assert.ok(playwright, 'Set PLAYWRIGHT_CORE_PATH to installed playwright-core')
const browser = await playwright.chromium.launch({ channel: 'msedge', headless: true })
after(() => browser.close())
const dist = fileURLToPath(new URL('../dist/', import.meta.url))
const shots = process.env.OBSERVE_SCREENSHOTS
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function until(fn, message, timeout = 8000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { if (await fn()) return; await sleep(20) }
  assert.fail(message)
}

const agentTask = (taskId, status, description) => ({ kind: 'agent', taskId, agentId: `${taskId}-agent`, agentType: 'general-purpose', description, status, runGeneration: 1,
  createdAt: new Date().toISOString(), startedAt: new Date().toISOString(), progress: { totalToolUseCount: 3 }, pendingMessageCount: 0 })
const metrics = (model, input, window) => ({ model, estimatedInputTokens: input, estimatedChars: input * 4, messageCount: 4, toolCount: 20, contextWindowTokens: window, contextUsageRatio: input / window })
const lines = (prefix, count) => Array.from({ length: count }, (_, i) => ({ id: i + 1, kind: i % 2 ? 'assistant' : 'user', text: `${prefix}_LINE_${i + 1}` }))

const terminalTask = (owner, runId, status, description) => ({ kind: 'terminal', taskId: `terminal:${runId}`, type: '终端', ownerSessionId: owner, sessionId: runId, status, description, command: description,
  createdAt: new Date().toISOString(), ...(status === 'running' ? {} : { completedAt: new Date().toISOString(), exitCode: 0 }) })

// terminals: per view ('' = main), the background terminals owned by that agent.
async function fixture(t, { tasks = [agentTask('task-a', 'running', '检查样式实现'), agentTask('task-b', 'completed', '核对测试覆盖')], terminals = {} } = {}) {
  const clients = new Set(), requests = [], errors = []
  const views = {
    '': { lines: lines('MAIN', 30), model: 'main-model', metrics: metrics('main-model', 200000, 1000000), usage: { inputTokens: 485000, outputTokens: 0 }, busy: false },
    'task-a': { lines: lines('CHILD_A', 12), model: 'child-model-a', metrics: metrics('child-model-a', 30000, 200000), usage: { inputTokens: 30000, outputTokens: 1200 }, busy: true },
    'task-b': { lines: lines('CHILD_B', 6), model: 'child-model-b', metrics: metrics('child-model-b', 9000, 200000), usage: { inputTokens: 9000, outputTokens: 400 }, busy: false },
  }
  const snapshot = (observe) => {
    const view = views[observe] ?? views['']
    const task = tasks.find(task => task.taskId === observe)
    return observabilitySnapshot({ session: { sessionId: 'S', title: 'Observe' }, lines: view.lines, busy: view.busy,
      status: { phase: view.busy ? 'calling_model' : 'ready', streamedOutputTokens: 0, metrics: view.metrics, usage: view.usage, activityTick: 1 },
      modelSettings: { model: view.model }, runControl: { state: view.busy ? 'running' : 'idle', canPause: !observe && view.busy, canResume: false },
      backgroundTasks: [...tasks.filter(task => task.status === 'running'), ...(terminals['']?.filter(item => item.status === 'running') ?? [])],
      agentTaskHistory: tasks.filter(task => task.status !== 'running'), backgroundTaskCount: tasks.filter(task => task.status === 'running').length,
      terminalTaskHistory: terminals['']?.filter(item => item.status !== 'running') ?? [],
      ...(task ? { observing: { taskId: task.taskId, agentId: task.agentId, agentType: task.agentType, description: task.description, status: task.status },
        observedBackgroundTasks: terminals[task.taskId]?.filter(item => item.status === 'running') ?? [],
        observedTerminalTaskHistory: terminals[task.taskId]?.filter(item => item.status !== 'running') ?? [] } : {}) })
  }
  const json = (res, value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)) }
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost'), observe = url.searchParams.get('observe') || ''
      if (url.pathname.startsWith('/api/') || url.pathname === '/events') {
        requests.push({ method: req.method, path: url.pathname, observe, params: Object.fromEntries(url.searchParams) })
        if (req.method !== 'GET') { json(res, { error: observe ? '观察子代理时为只读' : 'no mutation in this fixture' }, observe ? 409 : 405); return }
        if (url.pathname === '/events') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
          // Unknown tasks fall back to the main view (as the runtime does).
          const effective = views[observe] && tasks.some(task => task.taskId === observe) ? observe : ''
          res.write(`event: sync\ndata: ${JSON.stringify(snapshot(effective))}\n\n`)
          const client = { observe: effective, res }; clients.add(client); res.on('close', () => clients.delete(client)); return
        }
        if (url.pathname === '/api/state') { json(res, snapshot(views[observe] ? observe : '')); return }
        if (url.pathname === '/api/auth/status') { json(res, { isolation: false, user: null }); return }
        if (url.pathname === '/api/sessions') { json(res, { sessions: [{ sessionId: 'S', title: 'Observe', updatedAt: new Date().toISOString() }] }); return }
        json(res, {}); return
      }
      const path = resolve(dist, url.pathname === '/' ? 'index.html' : '.' + url.pathname)
      if (!path.startsWith(resolve(dist) + sep)) { res.writeHead(403); res.end(); return }
      res.setHeader('Content-Type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }[extname(path)] || 'application/octet-stream')
      res.end(await readFile(path))
    } catch (error) { errors.push(`fixture: ${error.stack}`); if (!res.headersSent) json(res, {}, 500); else res.end() }
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage(); page.setDefaultTimeout(8000)
  page.on('pageerror', e => errors.push(e.stack || e.message))
  t.after(async () => {
    await context.close()
    for (const c of clients) c.res.destroy()
    server.closeAllConnections(); await new Promise(r => server.close(r))
    assert.deepEqual(errors, [])
  })
  await page.goto(`http://127.0.0.1:${server.address().port}/`)
  await until(() => clients.size > 0, 'No native SSE connection')
  await page.getByText('MAIN_LINE_30', { exact: true }).waitFor()
  return { page, clients, requests, views,
    push(observe, event, data) { for (const c of clients) if (c.observe === observe) c.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`) },
    sync(observe = '') { this.push(observe, 'sync', snapshot(observe)) },
  }
}
const switchButton = page => page.locator('.agent-switch-button')
const metricsText = page => page.locator('#composer-session-metrics').innerText()
async function pick(page, name) {
  await switchButton(page).first().click()
  await page.locator('.agent-switch-menu').waitFor()
  await page.locator('.agent-switch-menu button').filter({ hasText: name }).click()
}

test('switch entry exists only when subagents exist', { timeout: 30000 }, async t => {
  const { page } = await fixture(t, { tasks: [] })
  await sleep(200)
  assert.equal(await switchButton(page).count(), 0)
})

test('observe a subagent in place: read-only, same status row, live stream, smooth switch, back to main keeps the draft', { timeout: 60000 }, async t => {
  const f = await fixture(t), { page } = f
  if (shots) await mkdir(shots, { recursive: true })
  const composer = page.locator('form.composer textarea')
  await composer.fill('MAIN_DRAFT_KEEP')
  assert.equal(await switchButton(page).count(), 1, 'one icon-only entry next to timing/tools')
  assert.equal((await switchButton(page).innerText()).trim(), '', 'icon only')
  assert.match(await metricsText(page), /main-model/)
  const activeNode = () => switchButton(page).locator('.agent-tree-icon').getAttribute('data-active')
  assert.equal(await activeNode(), 'main', 'the icon shows the main agent is in view')

  // Menu lists main + both subagents; status is an icon, not text.
  await switchButton(page).click()
  const menu = page.locator('.agent-switch-menu')
  await menu.waitFor()
  const menuText = await menu.innerText()
  assert.match(menuText, /主代理[\s\S]*检查样式实现[\s\S]*核对测试覆盖/)
  assert.doesNotMatch(menuText, /当前|运行中|已完成/)
  assert.equal(await menu.locator('button').nth(1).locator('.loading-ring, .task-status-icon').count() > 0, true, 'running status icon')
  assert.equal(await menu.locator('button').nth(2).locator('.task-state-check').count(), 1, 'completed status icon')
  const zoom = async name => { await sleep(250); const b = await switchButton(page).boundingBox(); await page.screenshot({ path: join(shots, name), clip: { x: b.x - 40, y: b.y - 150, width: 380, height: 200 } }) }
  if (shots) { await zoom('menu-main-zoom.png'); await page.screenshot({ path: join(shots, 'menu-desktop.png') }) }
  await page.keyboard.press('Escape')
  await until(async () => await menu.count() === 0, 'Escape closes the menu')

  // Switch: frame pacing is sampled across the transition.
  await page.evaluate(() => { window.__frames = []; let last = performance.now(); const tick = now => { window.__frames.push(now - last); last = now; if (window.__frames.length < 90) requestAnimationFrame(tick) }; requestAnimationFrame(tick) })
  const started = Date.now()
  await pick(page, '检查样式实现')
  await page.getByText('CHILD_A_LINE_12', { exact: true }).waitFor()
  const switchMs = Date.now() - started
  assert.equal(await page.getByText('MAIN_LINE_30', { exact: true }).count(), 0, 'views never mix')
  assert.equal(await activeNode(), 'sub', 'the icon shows a subagent is in view')
  assert.match(await switchButton(page).getAttribute('class'), /observing/)
  assert.equal(await composer.isVisible(), false, 'no input box while observing')
  assert.equal(await page.locator('form.composer .composer-actions').isVisible(), false)
  const observed = await metricsText(page)
  assert.match(observed, /child-model-a/); assert.match(observed, /上下文/); assert.match(observed, /输入/); assert.match(observed, /输出/)
  assert.ok(f.requests.some(r => r.path === '/events' && r.observe === 'task-a'), 'observed view streams through ?observe=')
  await until(async () => (await page.locator('.transcript').getAttribute('class')).match(/agent-view-(switching|entering)/) === null, 'switch animation settles')
  const frames = await page.evaluate(() => window.__frames)
  const longFrames = frames.filter(ms => ms > 50)
  if (shots) {
    await page.screenshot({ path: join(shots, 'observing-desktop.png') })
    await switchButton(page).click(); await menu.waitFor(); await zoom('menu-sub-zoom.png')
    await page.keyboard.press('Escape'); await until(async () => await menu.count() === 0, 'closed')
  }

  // Read-only: model/context chips do not open editors.
  assert.equal(await page.locator('.model-chip').evaluate(el => getComputedStyle(el).opacity), '1', 'same status row, not dimmed')
  await page.locator('.model-chip').click()
  await sleep(150)
  assert.equal(await page.locator('.model-modal, [aria-label="选择模型"][role="dialog"]').count(), 0)

  // Live child output streams through the same line model.
  f.push('task-a', 'delta', { sessionId: 'S', operations: [{ type: 'line.append', line: { id: 13, kind: 'assistant', text: 'ChildStreamLive', live: true } }] })
  await page.getByText('ChildStreamLive').waitFor()
  f.push('task-a', 'delta', { sessionId: 'S', operations: [{ type: 'line.text.append', id: 13, text: ' and more' }] })
  await page.getByText('ChildStreamLive and more').waitFor()
  // A stray main-view snapshot (e.g. a late /api/state) never replaces the observed view.
  assert.equal(await page.getByText('CHILD_A_LINE_1', { exact: true }).count(), 1)

  // Another subagent, then back to main.
  await pick(page, '核对测试覆盖')
  await page.getByText('CHILD_B_LINE_6', { exact: true }).waitFor()
  assert.equal(await page.getByText('ChildStreamLive').count(), 0)
  assert.match(await metricsText(page), /child-model-b/)
  await pick(page, '主代理')
  await page.getByText('MAIN_LINE_30', { exact: true }).waitFor()
  assert.equal(await composer.isVisible(), true)
  assert.equal(await composer.inputValue(), 'MAIN_DRAFT_KEEP', 'draft survives observation')
  assert.match(await metricsText(page), /main-model/)
  assert.equal(f.requests.filter(r => r.method !== 'GET').length, 0, 'observation never writes')

  // Narrow viewport: entry and menu stay inside the screen.
  await page.setViewportSize({ width: 390, height: 844 }); await sleep(150)
  await switchButton(page).click(); await menu.waitFor()
  const box = await menu.boundingBox()
  assert.ok(box.x >= 0 && box.x + box.width <= 390 && box.y >= 0, `menu inside 390px viewport: ${JSON.stringify(box)}`)
  if (shots) await page.screenshot({ path: join(shots, 'menu-narrow.png') })
  console.log(JSON.stringify({ switchMs, frames: frames.length, longFrames, maxFrame: Math.max(...frames).toFixed(1) }))
  assert.ok(longFrames.length <= 2, `switch should not jank: ${JSON.stringify(longFrames)}`)
})

test('streaming never interrupts the agent menu: one stable entry, rows keep their order, menu stays on the entry', { timeout: 60000 }, async t => {
  // task-b runs, task-a is done: the list is [b, a]; b finishing would reorder it to [a, b].
  const tasks = [agentTask('task-a', 'completed', '检查样式实现'), agentTask('task-b', 'running', '核对测试覆盖')]
  const f = await fixture(t, { tasks }), { page } = f
  await switchButton(page).evaluate(el => { window.__agentSwitch = el })
  await switchButton(page).click()
  const menu = page.locator('.agent-switch-menu')
  await menu.waitFor()
  const rows = () => menu.locator('button .agent-switch-name').allInnerTexts()
  assert.deepEqual(await rows(), ['主代理', '核对测试覆盖', '检查样式实现'])
  await menu.locator('button').nth(1).hover()

  // The main run starts streaming (status row changes branch), output arrives, the subagent finishes, the run ends.
  f.views[''].busy = true; f.sync('')
  await page.locator('.message-loading .execution-signal').waitFor()
  for (let i = 0; i < 20; i++) {
    f.push('', 'delta', { sessionId: 'S', operations: [{ type: 'line.append', line: { id: 100 + i, kind: 'assistant', text: `MAIN_STREAM_${i}` } }] })
    await sleep(25)
  }
  await page.getByText('MAIN_STREAM_19', { exact: true }).waitFor()
  tasks[1].status = 'completed'; f.sync('')
  await until(async () => await menu.locator('button').nth(1).locator('.task-state-check').count() === 1, 'status updates in place')
  f.views[''].busy = false; f.sync('')
  await sleep(200)

  assert.equal(await menu.isVisible(), true, 'menu still open')
  assert.equal(await page.evaluate(() => window.__agentSwitch.isConnected && document.querySelectorAll('.agent-switch-button').length === 1), true, 'the entry was never re-created')
  assert.deepEqual(await rows(), ['主代理', '核对测试覆盖', '检查样式实现'], 'rows keep their order while open')
  const [menuBox, buttonBox] = [await menu.boundingBox(), await switchButton(page).boundingBox()]
  assert.ok(Math.abs(menuBox.y + menuBox.height + 6 - buttonBox.y) <= 2, `menu stays on the entry: ${JSON.stringify({ menuBox, buttonBox })}`)
  if (shots) await page.screenshot({ path: join(shots, 'menu-after-stream.png') })

  // The row clicked after all that still switches the view.
  await menu.locator('button').filter({ hasText: '核对测试覆盖' }).click()
  await page.getByText('CHILD_B_LINE_6', { exact: true }).waitFor()
  await until(async () => await menu.count() === 0, 'picking closes the menu')
})

test('background tasks list only the viewed agent\'s own work: no subagents; observing shows the subagent\'s terminals', { timeout: 60000 }, async t => {
  const f = await fixture(t, { terminals: {
    '': [terminalTask('S', 'run-main', 'running', 'MAIN_DEV_SERVER'), terminalTask('S', 'run-main-done', 'exited', 'MAIN_BUILD_DONE')],
    'task-a': [terminalTask('task-a-agent', 'run-child', 'running', 'CHILD_WATCHER'), terminalTask('task-a-agent', 'run-child-done', 'exited', 'CHILD_TESTS_DONE')],
  } }), { page } = f
  const panel = page.locator('.right-panel')
  const panelText = () => panel.locator('.background-task-section').innerText()
  const historyItems = async () => {
    const summary = panel.locator('.background-task-history summary')
    if (!await summary.count()) return []
    if (await panel.locator('.background-task-history').getAttribute('open') === null) await summary.click()
    return panel.locator('.background-task-history-item strong').allInnerTexts()
  }

  // Main view: its own terminals only; running and finished subagents are not background tasks.
  await panel.locator('.background-task-summary').filter({ hasText: 'MAIN_DEV_SERVER' }).waitFor()
  let text = await panelText()
  assert.doesNotMatch(text, /检查样式实现|核对测试覆盖/, 'subagents are reached via the agent switch, not listed')
  assert.equal(await panel.locator('.background-task-count').innerText(), '1', 'count excludes subagents')
  assert.deepEqual(await historyItems(), ['MAIN_BUILD_DONE'])

  // Observing a subagent: the panel follows the viewed agent.
  await pick(page, '检查样式实现')
  await page.getByText('CHILD_A_LINE_12', { exact: true }).waitFor()
  await panel.locator('.background-task-summary').filter({ hasText: 'CHILD_WATCHER' }).waitFor()
  text = await panelText()
  assert.doesNotMatch(text, /MAIN_DEV_SERVER|MAIN_BUILD_DONE/, "the owner's terminals are not the subagent's")
  assert.deepEqual(await historyItems(), ['CHILD_TESTS_DONE'])

  // Its terminal detail reads output as the subagent (owner = agent id).
  await panel.locator('.background-task-summary').filter({ hasText: 'CHILD_WATCHER' }).first().click()
  await page.locator('.background-task-detail').waitFor()
  await until(() => f.requests.some(r => r.path === '/api/terminal-output' && r.params.sessionId === 'task-a-agent' && r.params.runId === 'run-child'), 'subagent terminal output is requested with the agent as owner')
  const index = await page.locator('.background-task-index-item strong').allInnerTexts()
  assert.deepEqual(index.sort(), ['CHILD_TESTS_DONE', 'CHILD_WATCHER'], "the detail's task index is the subagent's own")

  await page.locator('.background-task-modal .tool-result-modal-close').click()
  await page.locator('.background-task-detail').waitFor({ state: 'detached' })

  // A subagent with no terminals shows an empty panel.
  await pick(page, '核对测试覆盖')
  await page.getByText('CHILD_B_LINE_6', { exact: true }).waitFor()
  assert.equal(await panel.locator('.background-task-summary').count(), 0)
  assert.equal(await panel.locator('.background-task-count').count(), 0)

  await pick(page, '主代理')
  await page.getByText('MAIN_LINE_30', { exact: true }).waitFor()
  await panel.locator('.background-task-summary').filter({ hasText: 'MAIN_DEV_SERVER' }).waitFor()
})

test('an observing connection whose task is gone falls back to the main agent', { timeout: 30000 }, async t => {
  const f = await fixture(t), { page } = f
  await pick(page, '检查样式实现')
  await page.getByText('CHILD_A_LINE_12', { exact: true }).waitFor()
  // The runtime ends observer streams on session refresh; the reconnect lands on the main view.
  f.views['task-a'] = undefined
  for (const c of f.clients) c.res.destroy()
  await page.getByText('MAIN_LINE_30', { exact: true }).waitFor({ timeout: 10000 })
  assert.equal(await page.locator('form.composer textarea').isVisible(), true)
})
