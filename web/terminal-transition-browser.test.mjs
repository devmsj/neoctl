// Real Edge + native HTTP/SSE App acceptance. No model, tool execution, or production edits.
// Run: npm --prefix web run build && node --test web/terminal-transition-browser.test.mjs
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
// Intentionally require Edge, not a Chromium fallback.
const browser = await playwright.chromium.launch({ channel: 'msedge', headless: true })
after(() => browser.close())
const dist = fileURLToPath(new URL('./dist/', import.meta.url))
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function until(predicate, message, timeout = 7000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { if (await predicate()) return; await sleep(25) }
  assert.fail(message)
}
function terminal(owner, runId = 'same-run', extra = {}) {
  return {
    kind: 'terminal', taskId: `terminal:${runId}`, sessionId: runId, ownerSessionId: owner,
    description: `${owner}:${runId}`, command: 'echo read-only-fixture', status: 'running',
    createdAt: Date.now() - 5000, shell: 'powershell', processId: 4242,
    ...extra,
  }
}
function saved(task, extra = {}) {
  return { task, stdout: `BEGIN_${task.ownerSessionId}_${task.sessionId}\n`, stderr: 'stderr\n',
    lifecycle: task.status === 'running' ? 'running' : 'terminal', truncated: false,
    expiresAt: task.status === 'running' ? null : Date.now() + 300000, ...extra }
}
function session(owner, entries) { return { owner, entries, overlap: false } }

async function fixture(t, sessions) {
  const requests = [], errors = [], clients = new Set(), bindings = new Map()
  const state = { sessions, failNext: false, hold: null, deliveredSyncs: 0, newSessionNumber: 0 }
  const snapshot = owner => {
    const s = sessions[owner]
    assert.ok(s, `Unknown fixture owner ${owner}`)
    const running = s.entries.filter(e => e.task.status === 'running').map(e => e.task)
    const history = s.entries.filter(e => e.task.status !== 'running').map(e => e.task)
    return observabilitySnapshot({ session: { sessionId: owner, title: `Session ${owner}` },
      backgroundTasks: s.overlap ? [...running, ...history] : running,
      backgroundTaskCount: running.length, terminalTaskHistory: history })
  }
  const ownerFor = url => {
    const explicit = url.searchParams.get('sessionId')
    const tab = url.searchParams.get('tabId') || 'default'
    if (explicit) { bindings.set(tab, explicit); return explicit }
    if (!bindings.has(tab)) {
      const owner = Object.keys(sessions)[state.newSessionNumber++] || Object.keys(sessions)[0]
      bindings.set(tab, owner)
    }
    return bindings.get(tab)
  }
  const json = (res, value, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(value))
  }
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost')
      if (url.pathname.startsWith('/api/') || url.pathname === '/events') {
        requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams) })
        if (req.method !== 'GET') { json(res, { error: 'No mutations/models permitted in this fixture' }, 405); return }
        if (url.pathname === '/events') {
          const owner = ownerFor(url)
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
          res.write(`event: sync\ndata: ${JSON.stringify(snapshot(owner))}\n\n`)
          const client = { owner, res }
          clients.add(client)
          res.on('close', () => clients.delete(client))
          return
        }
        if (url.pathname === '/api/state') { json(res, snapshot(ownerFor(url))); return }
        if (url.pathname === '/api/sessions') {
          json(res, { sessions: Object.keys(sessions).map(owner => ({ sessionId: owner, title: `Session ${owner}`, updatedAt: new Date().toISOString() })) }); return
        }
        if (url.pathname === '/api/terminal-output') {
          const owner = url.searchParams.get('sessionId'), runId = url.searchParams.get('runId')
          const entry = sessions[owner]?.entries.find(e => e.task.sessionId === runId)
          if (!entry) { json(res, { error: 'Owner/run not found' }, 404); return }
          if (state.failNext) { state.failNext = false; json(res, {}, 503); return }
          const stream = url.searchParams.get('stream'), offset = Number(url.searchParams.get('offset'))
          assert.ok(['stdout', 'stderr'].includes(stream))
          assert.ok(Number.isSafeInteger(offset) && offset >= 0)
          const bytes = Buffer.from(entry[stream]), end = Math.min(bytes.length, offset + 65536)
          const expired = typeof entry.expiresAt === 'number' && Date.now() >= entry.expiresAt
          const record = { runId, ownerSessionId: owner, metadata: { startedAt: entry.task.createdAt, tty: false },
            lifecycle: entry.lifecycle, availability: expired ? 'expired' : 'available',
            truncated: entry.truncated, expiresAt: entry.expiresAt,
            exit: entry.lifecycle === 'running' ? null : { status: entry.task.status, exitCode: entry.task.exitCode ?? null,
              signal: entry.task.signal ?? null, terminationReason: entry.task.terminationReason, durationMs: entry.task.durationMs },
            streams: Object.fromEntries(['stdout', 'stderr'].map(s => [s, { storedBytes: Buffer.byteLength(entry[s]),
              observedBytes: Buffer.byteLength(entry[s]) + (entry.truncated ? 90000 : 0) }])) }
          const payload = { sessionId: owner, runId, stream, offset, nextOffset: end,
            text: expired ? null : bytes.subarray(offset, end).toString('utf8'), endOfStoredOutput: end === bytes.length, record }
          const hold = state.hold
          if (hold && hold.owner === owner && !hold.started) {
            hold.started = true
            await hold.gate
            hold.released = true
            hold.connectionClosed = res.destroyed
          }
          json(res, payload)
          if (hold?.released) hold.writeAttempted = true
          return
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
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, permissions: ['clipboard-read', 'clipboard-write'] })
  const page = await context.newPage()
  page.setDefaultTimeout(7000)
  page.on('pageerror', error => errors.push(error.stack || error.message))
  t.after(async () => {
    state.hold?.release()
    await context.close()
    for (const client of clients) client.res.destroy()
    server.closeAllConnections()
    await new Promise(r => server.close(r))
    assert.deepEqual(errors, [], 'No page/server exceptions')
    assert.deepEqual(requests.filter(r => r.method !== 'GET'), [], 'No model, terminal execution, or mutations')
  })
  const url = `http://127.0.0.1:${server.address().port}/`
  await page.goto(url)
  await until(() => clients.size > 0, 'Native SSE connection did not open')
  assert.match(await page.evaluate(() => navigator.userAgent), /Edg\//)
  const modal = page.locator('.background-task-modal')
  const reader = modal.locator('.terminal-output-reader')
  return { page, modal, reader, state, requests, url,
    async sync(owner) {
      await until(() => [...clients].some(c => c.owner === owner), `No scoped SSE client for ${owner}`)
      for (const client of clients) if (client.owner === owner) {
        client.res.write(`event: sync\ndata: ${JSON.stringify(snapshot(owner))}\n\n`)
        state.deliveredSyncs++
      }
    },
    async openActive() { await page.locator('.background-task-section > .background-task-summary').click(); await reader.waitFor() },
    async openHistory() {
      const details = page.locator('.background-task-history')
      if (!await details.getAttribute('open').then(v => v !== null)) await details.locator('summary').click()
      await details.locator('button').first().click(); await reader.waitFor()
    },
    async text(expected, stream = 0) {
      await until(async () => await reader.locator('pre').nth(stream).textContent().catch(() => '') === expected,
        `Output did not equal expected ${JSON.stringify(expected.slice(0, 100))}`)
    },
  }
}
async function keyboardActivate(page, locator, key = 'Enter') {
  await locator.focus()
  assert.equal(await locator.evaluate(el => el === document.activeElement), true)
  await page.keyboard.press(key)
}
async function watchModal(page) {
  // DOM-only evidence: detect removal/recreation even when the final modal looks identical.
  await page.evaluate(() => {
    const modal = document.querySelector('.background-task-modal')
    window.transitionEvidence = { removed: false, stale: false }
    window.transitionObserver?.disconnect()
    window.transitionObserver = new MutationObserver(records => {
      if (!modal.isConnected || records.some(r => [...r.removedNodes].some(n => n === modal || n.contains?.(modal)))) window.transitionEvidence.removed = true
    })
    window.transitionObserver.observe(document.body, { childList: true, subtree: true })
  })
}

for (const ending of [
  { name: 'completion', status: 'exited', exitCode: 0, signal: null, terminationReason: 'completed', label: '已退出' },
  { name: 'nonzero', status: 'exited', exitCode: 7, signal: null, terminationReason: 'failed', label: '已退出' },
  { name: 'active-stop', status: 'killed', exitCode: null, signal: 'SIGTERM', terminationReason: 'killed', label: '已停止' },
]) {
  test(`native SSE running -> history ${ending.name}; modal stays, identity dedup, reopen/reload`, { timeout: 40000 }, async t => {
    const entry = saved(terminal('A'))
    const f = await fixture(t, { A: session('A', [entry]) })
    const { page, reader, modal } = f
    await f.openActive(); await f.text(entry.stdout)
    await until(async () => /运行状态\s+运行中/.test(await reader.innerText()), 'Missing running facts')
    await watchModal(page)
    const stateReads = f.requests.filter(r => r.path === '/api/state').length
    Object.assign(entry.task, ending, { completedAt: new Date().toISOString(), durationMs: 1234 })
    entry.lifecycle = 'terminal'; entry.expiresAt = Date.now() + 300000
    entry.stdout += `END_${ending.name}\n`
    await f.sync('A')
    await until(async () => await modal.locator('.background-task-detail-head .tool-result-modal-status').innerText() === ending.label, 'SSE did not update task header')
    await f.text(entry.stdout)
    assert.equal(await modal.isVisible(), true)
    assert.equal(await page.evaluate(() => window.transitionEvidence.removed), false, 'SSE removed the open modal')
    assert.equal(f.requests.filter(r => r.path === '/api/state').length, stateReads, 'Transition must come from SSE, not a state reload')
    assert.equal(await modal.locator('.background-task-modal-count').innerText(), '1')
    assert.equal(await page.locator('.background-task-history-item').count(), 1)
    assert.equal(await page.locator('.background-task-section > .background-task-summary').count(), 0)
    assert.match(await reader.innerText(), new RegExp(`退出码\\s+${ending.exitCode ?? '未提供'}`))
    assert.match(await reader.innerText(), new RegExp(`终止原因\\s+${ending.terminationReason}`))
    if (ending.signal) assert.match(await reader.innerText(), /信号\s+SIGTERM/)
    for (let i = 0; i < 2; i++) {
      await f.sync('A'); await reader.getByRole('button', { name: '刷新输出', exact: true }).click()
      await f.text(entry.stdout)
    }
    // A valid overlap snapshot can contain the same identity in active/history during handover.
    f.state.sessions.A.overlap = true
    await f.sync('A'); await sleep(100)
    assert.equal(await modal.locator('.background-task-modal-count').innerText(), '1')
    assert.equal(await reader.count(), 1)
    f.state.sessions.A.overlap = false
    await f.sync('A')
    await page.keyboard.press('Escape'); await modal.waitFor({ state: 'detached' })
    await f.openHistory(); await f.text(entry.stdout)
    await page.keyboard.press('Escape')
    await page.reload(); await f.openHistory(); await f.text(entry.stdout)
    assert.equal(await page.locator('.background-task-history-item').count(), 1)
    assert.ok(f.state.deliveredSyncs >= 3)
  })
}

test('HTTP 503 retry and running clipboard is an exact saved snapshot, not full output', { timeout: 30000 }, async t => {
  const entry = saved(terminal('A'), { stdout: '\n  snapshot\n\tindent  \n' + 'x'.repeat(71000) + '\nEND\n\n' })
  const f = await fixture(t, { A: session('A', [entry]) })
  f.state.failNext = true
  await f.openActive()
  await f.reader.getByRole('alert').waitFor()
  assert.match(await f.reader.innerText(), /读取失败（503），可重试/)
  await keyboardActivate(f.page, f.reader.getByRole('button', { name: '重试读取', exact: true }))
  await f.reader.getByRole('button', { name: '复制当前快照', exact: true }).waitFor()
  assert.equal(await f.reader.getByRole('button', { name: '复制完整输出', exact: true }).count(), 0)
  await f.reader.getByRole('button', { name: '复制当前快照', exact: true }).click()
  await until(async () => (await f.page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n').includes('END\n\n'), 'Clipboard export did not finish')
  const copied = (await f.page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n')
  assert.equal(copied, `当前已保存输出快照（运行尚未结束）\n流内顺序保留；stdout/stderr 不代表已知跨流顺序。\n--- stdout ---\n${entry.stdout}\n--- stderr ---\n${entry.stderr}`)
  entry.stdout += 'AFTER_COPY_NOT_IN_SNAPSHOT\n'
  await f.reader.getByRole('button', { name: '加载全部已保留输出', exact: true }).click()
  await f.text(entry.stdout)
  assert.equal((await f.page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n'), copied)
})

test('truncated output labels, clipboard and download never claim full text', { timeout: 25000 }, async t => {
  const entry = saved(terminal('A', 'same-run', { status: 'exited', exitCode: 0, terminationReason: 'completed' }), { truncated: true, stdout: 'RETAINED_PREFIX_ONLY\n' })
  const f = await fixture(t, { A: session('A', [entry]) })
  await f.openHistory(); await f.text(entry.stdout)
  assert.match(await f.reader.innerText(), /仅可获取已保留前缀，不是全文/)
  assert.equal(await f.reader.getByRole('button', { name: /^(复制|下载)完整输出$/ }).count(), 0)
  await f.reader.getByRole('button', { name: '复制已保留输出（截断）', exact: true }).click()
  await until(async () => (await f.page.evaluate(() => navigator.clipboard.readText())).includes('RETAINED_PREFIX_ONLY'), 'Truncated clipboard not written')
  assert.match(await f.page.evaluate(() => navigator.clipboard.readText()), /^已保留输出（源已截断，不是完整输出）/)
  const pending = f.page.waitForEvent('download')
  await f.reader.getByRole('button', { name: '下载已保留输出（截断）', exact: true }).click()
  const download = await pending
  assert.match(download.suggestedFilename(), /-truncated\.txt$/)
  const text = await readFile(await download.path(), 'utf8')
  assert.match(text, /^已保留输出（源已截断，不是完整输出）/)
  assert.ok(text.includes(entry.stdout))
})

test('TTL automatically revokes displayed output and export without refresh or sync', { timeout: 20000 }, async t => {
  const entry = saved(terminal('A', 'same-run', { status: 'exited', exitCode: 7, terminationReason: 'failed', durationMs: 999 }))
  const f = await fixture(t, { A: session('A', [entry]) })
  // Short fixture TTL exercises the actual reader timer; do not replace Date/timers or click refresh.
  entry.expiresAt = Date.now() + 2200
  await f.openHistory(); await f.text(entry.stdout)
  const count = f.requests.filter(r => r.path === '/api/terminal-output').length
  await f.reader.getByRole('alert').waitFor()
  assert.match(await f.reader.innerText(), /输出已过期/)
  assert.equal(await f.reader.locator('pre').count(), 0)
  assert.equal(await f.reader.getByRole('button', { name: '复制完整输出', exact: true }).isDisabled(), true)
  assert.equal(await f.reader.getByRole('button', { name: '下载完整输出', exact: true }).isDisabled(), true)
  assert.equal(await f.reader.getByRole('button', { name: '加载全部已保留输出', exact: true }).isDisabled(), true)
  assert.match(await f.reader.innerText(), /退出码\s+7/)
  assert.match(await f.reader.innerText(), /终止原因\s+failed/)
  assert.ok(f.requests.filter(r => r.path === '/api/terminal-output').length > count, 'No automatic TTL HTTP check')
  assert.equal(f.state.deliveredSyncs, 0)
})

for (const navigation of ['new-session', 'session-switch']) {
  test(`${navigation}: real UI binding, same runId / different owner, late old HTTP isolated`, { timeout: 30000 }, async t => {
    const old = saved(terminal('A'), { stdout: 'SECRET_OLD_OWNER_A_ONLY\n' })
    const fresh = saved(terminal('B'), { stdout: 'NEW_OWNER_B_ONLY\n' })
    const f = await fixture(t, { A: session('A', [old]), B: session('B', [fresh]) })
    const hold = { owner: 'A', started: false, released: false }
    hold.gate = new Promise(r => { hold.release = r })
    f.state.hold = hold
    await f.openActive()
    await until(() => hold.started, 'Old-owner HTTP request never started')
    await f.reader.getByRole('status').waitFor()
    await f.page.keyboard.press('Escape')
    if (navigation === 'new-session') {
      await keyboardActivate(f.page, f.page.locator('.nav button').first())
    } else {
      await keyboardActivate(f.page, f.page.getByRole('button', { name: '会话管理', exact: true }).first())
      const row = f.page.locator('.session-card').filter({ hasText: 'Session B' })
      // Use the visible session card's actual Open button, never mutate sessionStorage or Vue state.
      await keyboardActivate(f.page, row.getByRole('button', { name: '打开', exact: true }))
    }
    await until(async () => await f.page.evaluate(() => sessionStorage.getItem('neoctl-web.sessionId')) === 'B', 'Real UI failed to bind owner B')
    await f.page.locator('.background-task-section > .background-task-summary').filter({ hasText: 'B:same-run' }).waitFor()
    await f.openActive(); await f.text(fresh.stdout)
    await f.page.evaluate(() => {
      window.lateOwnerLeak = false
      window.lateObserver = new MutationObserver(() => {
        if (document.querySelector('.background-task-modal')?.textContent.includes('SECRET_OLD_OWNER_A_ONLY')) window.lateOwnerLeak = true
      })
      window.lateObserver.observe(document.body, { subtree: true, childList: true, characterData: true })
    })
    hold.release()
    await until(() => hold.writeAttempted, 'Delayed old HTTP response was not released')
    await sleep(1250)
    await f.text(fresh.stdout)
    assert.equal(await f.page.evaluate(() => window.lateOwnerLeak), false)
    assert.doesNotMatch(await f.modal.innerText(), /SECRET_OLD_OWNER_A_ONLY/)
    assert.ok(f.requests.some(r => r.path === '/api/terminal-output' && r.query.sessionId === 'A' && r.query.runId === 'same-run'))
    assert.ok(f.requests.some(r => r.path === '/api/terminal-output' && r.query.sessionId === 'B' && r.query.runId === 'same-run'))
    t.diagnostic(`Delayed A response released after B rendered; old connection aborted=${hold.connectionClosed}. Native browser abort is accepted isolation, not a simulated callback.`)
  })
}

test('390px: long unbroken output/command do not overflow document; keyboard navigation and close', { timeout: 30000 }, async t => {
  const longCommand = 'node ' + 'VERY_LONG_UNBROKEN_COMMAND'.repeat(500)
  const first = saved(terminal('A', 'long', { command: longCommand }), { stdout: 'NO_SPACES'.repeat(9000) })
  const second = saved(terminal('A', 'next'), { stdout: 'KEYBOARD_SECOND_TASK\n' })
  const f = await fixture(t, { A: session('A', [first, second]) })
  await f.openActive()
  await f.reader.getByRole('button', { name: '加载全部已保留输出', exact: true }).click()
  await f.text(first.stdout)
  assert.equal(await f.modal.locator('.background-task-command').textContent(), longCommand)
  await f.page.setViewportSize({ width: 390, height: 844 })
  await sleep(100)
  const geometry = await f.page.evaluate(() => {
    const d = document.documentElement, b = document.body, m = document.querySelector('.background-task-modal').getBoundingClientRect()
    return { viewport: innerWidth, document: d.scrollWidth, client: d.clientWidth, body: b.scrollWidth, modal: { left: m.left, right: m.right, width: m.width } }
  })
  // Run keyboard acceptance even if geometry fails, so a layout defect cannot mask it.
  await keyboardActivate(f.page, f.modal.locator('.background-task-index-item').nth(1))
  await f.text(second.stdout)
  await f.page.keyboard.press('Shift+Tab')
  assert.equal(await f.modal.locator('.background-task-index-item').first().evaluate(el => el === document.activeElement), true, 'Task navigation is not in keyboard tab order')
  await f.page.keyboard.press('Space'); await f.text(first.stdout.slice(0, 65536))
  await keyboardActivate(f.page, f.modal.getByRole('button', { name: '关闭', exact: true }))
  await f.modal.waitFor({ state: 'detached' })
  t.diagnostic(`390px geometry: ${JSON.stringify(geometry)}`)
  t.diagnostic('Keyboard PASS: task buttons Enter / Shift+Tab / Space and Close Enter; Escape covered by transition cases.')
  assert.ok(geometry.document <= geometry.client && geometry.body <= geometry.viewport && geometry.modal.left >= 0 && geometry.modal.right <= 390,
    `390px document horizontal overflow: ${JSON.stringify(geometry)}`)
})
