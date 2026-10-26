import test from 'node:test'
import assert from 'node:assert/strict'
import { createObservabilityBrowser, observabilitySnapshot } from './observability-browser-fixture.mjs'

test('only successful completion lights clock rings and duration green in both themes', async () => {
  const snapshot = observabilitySnapshot({ status: { phase: 'ready', queryTiming: {
    version: 1, id: 'clock-query', kind: 'query', status: 'finished', outcome: 'completed', durationMs: 450000,
  } } })
  const ui = await createObservabilityBrowser(() => snapshot)
  try {
    const clock = ui.page.locator('.elapsed-clock')
    await clock.waitFor()
    assert.equal(await clock.locator('.elapsed-clock-value').innerText(), '7m 30s')
    for (const [theme, green] of [['light', 'rgb(100, 167, 128)'], ['dark', 'rgb(148, 203, 165)']]) {
      await ui.page.evaluate(value => document.documentElement.dataset.theme = value, theme)
      const colors = await clock.evaluate(el => ({
        rim: getComputedStyle(el.querySelector('.clock-rim')).stroke,
        well: getComputedStyle(el.querySelector('.clock-well')).stroke,
        value: getComputedStyle(el.querySelector('.elapsed-clock-value')).color,
        hand: getComputedStyle(el.querySelector('.clock-hand line')).stroke,
        tick: getComputedStyle(el.querySelector('.clock-ticks line:not(.major)')).stroke,
        major: getComputedStyle(el.querySelector('.clock-ticks .major')).stroke,
        pin: getComputedStyle(el.querySelector('.clock-pin')).fill,
      }))
      assert.deepEqual(colors, { rim: green, well: green, value: green, hand: green, tick: green, major: green, pin: green })
    }
    snapshot.status.queryTiming.outcome = 'model_error'
    await ui.page.reload()
    await clock.waitFor()
    assert.equal(await clock.evaluate(el => el.classList.contains('is-completed')), false)
    snapshot.status.queryTiming.status = 'running'
    snapshot.status.queryTiming.elapsedMs = 1200
    snapshot.busy = true
    snapshot.status.phase = 'calling_model'
    await ui.page.reload()
    await clock.waitFor()
    assert.equal(await clock.evaluate(el => el.classList.contains('is-completed')), false)
  } finally { await ui.close() }
})
