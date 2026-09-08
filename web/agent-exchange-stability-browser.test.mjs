// Uses the already-built real App; never compiles or mutates production code.
// Run after building web/dist: node --test web/agent-exchange-stability-browser.test.mjs
// Browser/dependency overrides are the same as observability-browser-fixture.mjs.
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { createObservabilityBrowser, observabilitySnapshot } from './observability-browser-fixture.mjs'

const readerSelector = '.agent-parent-messages'
const messageSelector = '.agent-parent-message'
const task = (taskId = 'stable-task', overrides = {}) => ({
  kind: 'agent', taskId, agentId: taskId, description: `Exchange ${taskId}`,
  status: 'running', runGeneration: 1, runHistory: [], progress: {}, ...overrides,
})
const part = text => ({ state: 'complete', text, reason: '', offset: 0, totalChars: text.length, hasMore: false })
const label = (id, generation, revision, view) => `${id}/run-${generation}/${revision}/${view}`

async function until(predicate, message, timeout = 10000) {
  const deadline = Date.now() + timeout
  while (!await predicate()) {
    assert.ok(Date.now() < deadline, message)
    await delay(20)
  }
}

async function createFixture(tasks) {
  let currentTasks = tasks
  const state = { revision: 'saved', failure: null, holds: [], reads: [], routeErrors: [], aborted: [] }
  const snapshot = () => observabilitySnapshot({ agentTaskHistory: currentTasks })
  const fixture = await createObservabilityBrowser(snapshot, async route => {
    const url = new URL(route.request().url())
    if (url.pathname !== '/api/agent-content') return false
    const request = {
      taskId: url.searchParams.get('taskId'), runGeneration: Number(url.searchParams.get('runGeneration')),
      ownerSessionId: url.searchParams.get('sessionId'), view: url.searchParams.get('view'),
    }
    state.reads.push(request)
    const text = label(request.taskId, request.runGeneration, state.revision, request.view)
    const content = request.view === 'delegation' ? { delegation: { scope: 'task', prompt: part(text) } }
      : request.view === 'messages' ? { messages: { content: part(JSON.stringify([{ id: 'stable-message', text }])) } }
        : { report: { content: part(text), reportStatus: 'completed' } }
    const response = state.failure?.(request) ? { status: 503, json: { error: 'temporary fixture failure' } }
      : { json: { ...request, state: 'complete', snapshotId: `${text}/snapshot`, ...content } }
    const hold = state.holds.find(item => !item.started && item.match(request))
    if (hold) {
      hold.started = true
      hold.request = request
      await hold.promise
    }
    try { await route.fulfill(response) }
    catch (error) {
      // A held obsolete request is expected to have been aborted by the real reader.
      if (!hold || !/closed|handled|invalid interception|aborted/i.test(error.message)) state.routeErrors.push(error.message)
    } finally { if (hold) hold.finished = true }
    return true
  })
  const { page } = fixture
  page.on('requestfailed', request => {
    if (new URL(request.url()).pathname === '/api/agent-content') state.aborted.push(request.url())
  })
  try {
    // Only the transport is replaced. Every update enters App's production sync
    // listener and applySync, including its replacement of backgroundTaskDetail.
    await page.addInitScript(() => {
      window.EventSource = class extends EventTarget {
        constructor(url) {
          super()
          this.url = url
          this.readyState = 1
          window.exchangeEvents = this
          queueMicrotask(() => this.dispatchEvent(new Event('open')))
        }
        close() { this.readyState = 2 }
      }
      window.exchangeSync = payload => {
        const source = window.exchangeEvents
        if (!source || source.readyState !== 1) throw new Error('No live fixture EventSource')
        source.dispatchEvent(new MessageEvent('sync', { data: JSON.stringify(payload) }))
      }
    })
    await page.reload()
    await page.waitForFunction(() => !!window.exchangeEvents)
    await page.locator('.background-task-history > summary').click()
  } catch (error) { await fixture.close(); throw error }

  return {
    ...fixture, state,
    count: (view, taskId, generation) => state.reads.filter(r => (!view || r.view === view)
      && (!taskId || r.taskId === taskId) && (generation === undefined || r.runGeneration === generation)).length,
    async open(taskId = tasks[0].taskId) {
      await page.locator('.background-task-history-item').filter({ hasText: `Exchange ${taskId}` }).click()
    },
    async sync(nextTasks) {
      currentTasks = nextTasks
      await page.evaluate(payload => window.exchangeSync(payload), snapshot())
      // App coalesces later snapshots on RAF; flush two frames + Vue's microtask
      // before asserting counts, so a broken watcher cannot escape the assertion.
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    },
    hold(match) {
      const hold = { match, started: false, finished: false }
      hold.promise = new Promise(resolve => { hold.release = resolve })
      state.holds.push(hold)
      return hold
    },
    async close() {
      for (const hold of state.holds) hold.release()
      await fixture.close()
    },
  }
}

async function waitForReport(f, taskId = 'stable-task', generation = 1, revision = 'saved') {
  await f.page.locator(readerSelector).getByText(label(taskId, generation, revision, 'report'), { exact: true }).waitFor()
  assert.equal(await f.page.locator(messageSelector).count(), 3)
}

async function rememberDOM(page) {
  await page.evaluate(({ readerSelector, messageSelector }) => {
    window.exchangeDOM?.observer.disconnect()
    const reader = document.querySelector(readerSelector)
    const articles = [...reader.querySelectorAll(messageSelector)]
    const markdown = articles.map(node => node.querySelector('.markdown'))
    const record = { reader, articles, markdown, removed: 0 }
    record.observer = new MutationObserver(records => {
      for (const mutation of records) for (const removed of mutation.removedNodes) {
        if ([...articles, ...markdown].some(node => node && (removed === node || removed.contains(node)))) record.removed++
      }
    })
    record.observer.observe(reader, { childList: true, subtree: true })
    window.exchangeDOM = record
  }, { readerSelector, messageSelector })
}

async function assertStableDOM(page) {
  const state = await page.evaluate(({ readerSelector, messageSelector }) => {
    const saved = window.exchangeDOM
    const articles = [...document.querySelectorAll(messageSelector)]
    return {
      sameReader: saved.reader === document.querySelector(readerSelector), removed: saved.removed,
      sameArticles: articles.length === saved.articles.length && articles.every((node, i) => node === saved.articles[i] && node.isConnected),
      sameMarkdown: saved.markdown.every((node, i) => node.isConnected && node === articles[i]?.querySelector('.markdown')),
    }
  }, { readerSelector, messageSelector })
  assert.deepEqual(state, { sameReader: true, removed: 0, sameArticles: true, sameMarkdown: true })
}

async function assertClearedDOM(page) {
  assert.equal(await page.locator(messageSelector).count(), 0)
  assert.deepEqual(await page.evaluate(readerSelector => ({
    // Identity changes must be handled inside the existing Reader, not hidden by a modal remount.
    sameReader: window.exchangeDOM.reader === document.querySelector(readerSelector),
    oldConnected: window.exchangeDOM.articles.some(node => node.isConnected),
  }), readerSelector), { sameReader: true, oldConnected: false })
}

function assertClean(f) {
  assert.deepEqual(f.errors, [])
  assert.deepEqual(f.state.routeErrors, [])
  assert.ok(f.requests.filter(r => new URL(r.url).pathname === '/api/agent-content').every(r => r.method === 'GET'))
}

test('exchange: repeated App sync with unchanged identity/status neither rereads nor replaces message DOM', { timeout: 20000 }, async () => {
  // Terminal status removes polling as a confounder: every extra GET is a sync regression.
  const initial = task('stable-task', { status: 'completed' })
  const f = await createFixture([initial])
  try {
    await f.open(); await waitForReport(f); await rememberDOM(f.page)
    assert.equal(f.count(), 3)
    for (let i = 1; i <= 8; i++) {
      await f.sync([{ ...initial, description: `Exchange stable-task sync-${i}`, output: `progress-${i}`,
        progress: { summary: `sync-${i}`, toolCount: i }, deliveredRetainedThisRun: i }])
      await until(async () => (await f.page.locator('.background-task-detail-title').innerText()).includes(`sync-${i}`), 'App did not apply sync')
      assert.equal(f.count(), 3, `unchanged identity/status sync ${i} started another content read`)
      await assertStableDOM(f.page)
    }
    assertClean(f)
  } finally { await f.close() }
})

test('exchange: running -> completed keeps old DOM while final report is delayed, then updates in place', { timeout: 20000 }, async () => {
  const initial = task()
  const f = await createFixture([initial])
  try {
    await f.open(); await waitForReport(f); await rememberDOM(f.page)
    f.state.revision = 'final'
    const gate = f.hold(r => r.view === 'report')
    await f.sync([{ ...initial, status: 'completed' }])
    await until(() => gate.started, 'completion did not request final report')
    await f.page.locator('.background-task-detail-head .tool-result-modal-status.status-completed').waitFor()
    assert.equal(f.count(), 6)
    await delay(200)
    await assertStableDOM(f.page)
    await waitForReport(f)
    assert.doesNotMatch(await f.page.locator(readerSelector).innerText(), /\/final\//, 'partial successful refresh leaked before report completed')
    gate.release()
    await waitForReport(f, 'stable-task', 1, 'final')
    await assertStableDOM(f.page)
    const after = f.count()
    await delay(3300)
    assert.equal(f.count(), after, 'completed task continued polling')
    assertClean(f)
  } finally { await f.close() }
})

test('exchange: failed periodic refresh preserves the entire last successful snapshot and polling recovers', { timeout: 25000 }, async () => {
  const f = await createFixture([task()])
  try {
    await f.open(); await waitForReport(f); await rememberDOM(f.page)
    const beforeText = await f.page.locator(messageSelector).allTextContents()
    f.state.revision = 'uncommitted'
    f.state.failure = r => r.view === 'report'
    await f.page.locator(`${readerSelector} .reader-error`).waitFor({ timeout: 10000 })
    assert.equal(f.count('report'), 2, 'failure must come from a real scheduled poll')
    assert.equal(f.count(), 6)
    assert.deepEqual(await f.page.locator(messageSelector).allTextContents(), beforeText, 'failed read committed partial delegation/messages or cleared saved report')
    await assertStableDOM(f.page)
    f.state.failure = null
    f.state.revision = 'recovered'
    await waitForReport(f, 'stable-task', 1, 'recovered')
    assert.equal(await f.page.locator(`${readerSelector} .reader-error`).count(), 0)
    assert.equal(f.count(), 9)
    await assertStableDOM(f.page)
    assertClean(f)
  } finally { await f.close() }
})

for (const identity of ['run', 'task']) {
  test(`exchange: changing ${identity} identity clears old DOM and rejects a late old request`, { timeout: 25000 }, async () => {
    const first = task()
    const second = task('other-task', { status: 'completed' })
    const f = await createFixture(identity === 'task' ? [first, second] : [first])
    try {
      await f.open(); await waitForReport(f); await rememberDOM(f.page)
      f.state.revision = 'obsolete'
      const stale = f.hold(r => r.taskId === first.taskId && r.runGeneration === 1 && r.view === 'messages')
      await until(() => stale.started, 'old identity poll did not reach held messages')
      await assertStableDOM(f.page)
      const nextId = identity === 'task' ? second.taskId : first.taskId
      const nextRun = identity === 'task' ? 1 : 2
      f.state.revision = 'new-identity'
      const next = f.hold(r => r.taskId === nextId && r.runGeneration === nextRun && r.view === 'delegation')
      if (identity === 'run') await f.sync([{ ...first, runGeneration: nextRun, status: 'completed', runHistory: [] }])
      else await f.page.locator('.background-task-index-item').filter({ hasText: 'Exchange other-task' }).click()
      await until(() => next.started, 'new identity did not request delegation')
      await assertClearedDOM(f.page)
      await until(() => f.state.aborted.some(raw => {
        const url = new URL(raw)
        return url.searchParams.get('taskId') === first.taskId && url.searchParams.get('runGeneration') === '1' && url.searchParams.get('view') === 'messages'
      }), 'identity switch did not abort the obsolete request')
      next.release()
      await waitForReport(f, nextId, nextRun, 'new-identity')
      await rememberDOM(f.page)
      const count = f.count()
      stale.release()
      await until(() => stale.finished, 'late old response was not attempted')
      await delay(200)
      await assertStableDOM(f.page)
      assert.equal(f.count(), count, 'obsolete read continued after the late response')
      assert.equal(f.count('report', first.taskId, 1), 1, 'aborted old messages read advanced to old report')
      assert.doesNotMatch(await f.page.locator(readerSelector).innerText(), /\/saved\/|\/obsolete\//)
      assertClean(f)
    } finally { await f.close() }
  })
}

test('exchange: closing task detail unmounts the reader and cancels its scheduled polling', { timeout: 15000 }, async () => {
  const f = await createFixture([task()])
  try {
    await f.open(); await waitForReport(f); await rememberDOM(f.page)
    const before = f.count()
    await f.page.locator('.background-task-modal .tool-result-modal-close').click()
    assert.equal(await f.page.locator(readerSelector).count(), 0)
    assert.equal(await f.page.evaluate(() => window.exchangeDOM.articles.some(node => node.isConnected)), false)
    await delay(3600)
    assert.equal(f.count(), before, 'unmounted reader still issued a scheduled poll')
    assertClean(f)
  } finally { await f.close() }
})
