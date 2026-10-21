import assert from 'node:assert/strict'
import test from 'node:test'
import { createObservabilityBrowser, observabilitySnapshot } from './observability-browser-fixture.mjs'

test('pause/continue SVG actions and sending a new instruction after interruption', async () => {
  let current = observabilitySnapshot({ busy: true, status: { phase: 'calling_model' }, runControl: { state: 'running', canPause: true, canResume: false } })
  const posts = []
  const f = await createObservabilityBrowser(() => current, async route => {
    if (route.request().method() !== 'POST') return false
    posts.push({ path: new URL(route.request().url()).pathname, body: route.request().postDataJSON() })
    await route.fulfill({ json: { ok: true } })
    return true
  })
  try {
    await f.page.addInitScript(() => {
      window.__pauseEvents = []
      window.EventSource = class extends EventTarget {
        constructor() { super(); window.__pauseEvents.push(this); queueMicrotask(() => this.dispatchEvent(new Event('open'))) }
        close() { this.closed = true }
      }
    })
    await f.page.reload()
    const button = f.page.locator('.composer-action')
    await button.locator('[data-action="pause"]').waitFor()
    await button.click()
    assert.equal(posts.at(-1).path, '/api/run/pause')
    const sync = async value => {
      current = observabilitySnapshot(value)
      await f.page.evaluate(snapshot => window.__pauseEvents.filter(x => !x.closed).at(-1).dispatchEvent(new MessageEvent('sync', { data: JSON.stringify(snapshot) })), current)
    }
    const paused = { busy: false, status: { phase: 'ready', queryTiming: { version: 1, id: 'query', status: 'finished', durationMs: 12500 } }, runControl: { state: 'paused', canResume: true, canPause: false, timer: { elapsedMs: 12500, running: false } } }
    await sync(paused)
    await button.locator('[data-action="continue"]').waitFor()
    assert.equal(await button.isEnabled(), true)
    const row = f.page.locator('.message-loading-body')
    const label = row.locator('.message-loading-label')
    const clock = row.locator('.elapsed-clock')
    await f.page.waitForFunction(() => document.querySelector('.message-loading-label')?.textContent === '已暂停')
    assert.equal(await row.count(), 1, 'paused label and timer must not split into separate rows')
    assert.equal(await clock.innerText(), '12s')
    const a = await label.boundingBox(), b = await clock.boundingBox()
    assert.ok(a.x + a.width <= b.x, 'paused label must be left of timer')
    assert.ok(Math.abs((a.y + a.height / 2) - (b.y + b.height / 2)) < 4, 'label and timer stay on the same line')
    const hand = await clock.locator('.clock-hand').getAttribute('style')
    await f.page.waitForTimeout(1200)
    assert.equal(await clock.innerText(), '12s', 'paused clock must freeze')
    assert.equal(await clock.locator('.clock-hand').getAttribute('style'), hand)
    await sync({ busy: true, status: { phase: 'calling_model' }, runControl: { state: 'running', canResume: false, canPause: true, timer: { elapsedMs: 12500, running: true } } })
    await f.page.waitForTimeout(1200)
    assert.match(await clock.innerText(), /^1[3-9]s$/, 'continued clock must grow without resetting')
    await sync({ ...paused, runControl: { ...paused.runControl, timer: { elapsedMs: 0, running: false } } })
    await f.page.waitForFunction(() => document.querySelector('.message-loading-body .elapsed-clock-value')?.textContent === '0s')
    await sync(paused)
    const input = f.page.locator('.composer textarea')
    await input.fill('先解释原因，不要继续修改')
    await button.locator('[data-action="send"]').waitFor()
    assert.equal(posts.length, 1, 'typing must not resume execution')
    await button.click()
    assert.equal(posts.at(-1).path, '/api/submit')
    assert.equal(posts.at(-1).body.text, '先解释原因，不要继续修改')
    await sync({ busy: false, runControl: { state: 'interrupted', canResume: true, canPause: false } })
    await button.locator('[data-action="continue"]').waitFor()
    await button.click()
    assert.equal(posts.at(-1).path, '/api/run/continue')
    await sync({ busy: true, runControl: { state: 'resuming', canResume: false, canPause: false } })
    await button.locator('[data-action="waiting"]').waitFor()
    assert.equal(await button.isDisabled(), true)
    assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})
