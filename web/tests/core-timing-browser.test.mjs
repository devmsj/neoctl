// Production App with controlled transport snapshots. No model calls or tool execution.
import assert from 'node:assert/strict'
import { createObservabilityBrowser, observabilitySnapshot } from './observability-browser-fixture.mjs'

const query = { version: 1, id: 'q', runId: 'q', kind: 'query', status: 'running', elapsedMs: 12000 }
const tool = { ...query, id: 't', kind: 'tool', toolUseId: 'a', elapsedMs: 5000 }
let snapshot = observabilitySnapshot({ busy: true,
  status: { phase: 'running_tools', queryTiming: query, toolTimings: [tool] },
  lines: [{ id: 1, kind: 'tool', toolUseId: 'a', toolName: 'probe', title: '计时测试', text: 'probe', live: true,
    collapsible: true, previewStyle: 'summary', timing: tool }],
})
const fixture = await createObservabilityBrowser(() => snapshot)
try {
  const { page } = fixture
  await page.addInitScript(() => {
    window.EventSource = class extends EventTarget {
      constructor() { super(); window.timingEvents = this; queueMicrotask(() => this.dispatchEvent(new Event('open'))) }
      close() {}
    }
  })
  await page.reload()
  await page.waitForFunction(() => window.timingEvents && document.querySelector('.elapsed-pill'))
  const pill = page.locator('.elapsed-pill').first()
  const before = await pill.textContent()
  assert.match(before, /^\d+s$/, 'running timer shows integer seconds only')
  await page.waitForTimeout(1400)
  assert.notEqual(await pill.textContent(), before, 'running tool interpolates from core snapshot')
  assert.equal(await page.locator('.elapsed-clock').count(), 1)
  assert.equal(await page.locator('.message-loading-emblem').count(), 0, 'commented ornament is not rendered')

  const layout = await page.evaluate(() => {
    const clock = document.querySelector('.elapsed-clock').getBoundingClientRect()
    const label = document.querySelector('.message-loading-label').getBoundingClientRect()
    return { clockCenter: clock.y + clock.height / 2, labelCenter: label.y + label.height / 2, clockLeft: clock.left, labelRight: label.right }
  })
  assert(Math.abs(layout.clockCenter - layout.labelCenter) < 8, 'clock and status remain on the same row')
  assert(layout.labelRight <= layout.clockLeft, 'clock does not overlap the status')

  // Only genuine status changes trigger the preserved domino card flip.
  assert.equal(await page.locator('.dust-status-particles').count(), 0)
  assert.equal(await page.locator('.is-flipping').count(), 0)
  await page.evaluate(() => { window.savedLetters = document.querySelector('.flip-status-letters') })
  await page.waitForTimeout(1100)
  assert(await page.evaluate(() => window.savedLetters === document.querySelector('.flip-status-letters')), 'clock ticks do not restart flips')
  snapshot.status = { ...snapshot.status, currentTool: { name: 'probe', kind: 'test' } }
  await page.evaluate(value => window.timingEvents.dispatchEvent(new MessageEvent('sync', { data: JSON.stringify(value) })), snapshot)
  await page.waitForFunction(() => document.querySelectorAll('.is-flipping').length > 1)
  const facts = await page.locator('.flip-status-card').evaluateAll(nodes => nodes.map(node => {
    const animation = node.getAnimations()[0]
    return { duration: animation.effect.getTiming().duration, delay: animation.effect.getTiming().delay }
  }))
  assert.equal(facts[0].delay, 0)
  assert(facts.every((fact, i) => fact.duration === 360 && (!i || fact.delay > facts[i - 1].delay)))
  await page.waitForFunction(() => !document.querySelector('.is-flipping'))
  assert.equal(await page.locator('.flip-status-text').textContent(), await page.locator('.flip-status-text').getAttribute('aria-label'))

  snapshot.status.currentTool = { name: 'long_tool_name', kind: 'test' }
  await page.evaluate(value => window.timingEvents.dispatchEvent(new MessageEvent('sync', { data: JSON.stringify(value) })), snapshot)
  snapshot.status.currentTool = { name: 'custom_plugin', kind: 'test' }
  await page.evaluate(value => window.timingEvents.dispatchEvent(new MessageEvent('sync', { data: JSON.stringify(value) })), snapshot)
  await page.waitForFunction(() => document.querySelector('.flip-status-text')?.getAttribute('aria-label')?.includes('custom_plugin'))
  await page.waitForFunction(() => !document.querySelector('.is-flipping'))
  assert.equal(await page.locator('.flip-status-text').textContent(), await page.locator('.flip-status-text').getAttribute('aria-label'))

  await page.emulateMedia({ reducedMotion: 'reduce' })
  snapshot.status.currentTool = { name: 'reduced-motion', kind: 'test' }
  await page.evaluate(value => window.timingEvents.dispatchEvent(new MessageEvent('sync', { data: JSON.stringify(value) })), snapshot)
  await page.waitForFunction(() => document.querySelector('.flip-status-text')?.getAttribute('aria-label')?.includes('reduced-motion'))
  assert.equal(await page.locator('.flip-status-card').first().evaluate(node => getComputedStyle(node).animationName), 'none')
  assert.equal(await page.locator('.flip-status-back').first().evaluate(node => getComputedStyle(node).transform), 'none')
  await page.emulateMedia({ reducedMotion: 'no-preference' })

  // Provider-native tool headers are visible before any output tokens or tool execution.
  snapshot.status = { phase: 'calling_model', streamedOutputTokens: 0, queryTiming: query,
    modelOutput: { kind: 'tool_call', callId: 'early', name: 'custom_plugin' } }
  await page.evaluate(value => window.timingEvents.dispatchEvent(new MessageEvent('sync', { data: JSON.stringify(value) })), snapshot)
  await page.waitForFunction(() => document.querySelector('.flip-status-text')?.getAttribute('aria-label') === '正在准备调用 custom_plugin')
  await page.waitForFunction(() => !document.querySelector('.is-flipping'))
  await page.evaluate(() => { window.savedStatusLetters = document.querySelector('.flip-status-letters') })
  snapshot.status.streamedOutputTokens = 123
  await page.evaluate(value => window.timingEvents.dispatchEvent(new MessageEvent('sync', { data: JSON.stringify(value) })), snapshot)
  await page.waitForTimeout(100)
  assert.equal(await page.evaluate(() => window.savedStatusLetters === document.querySelector('.flip-status-letters')), true, 'argument token growth does not replay status animation')
  snapshot.status.modelOutput = { kind: 'text' }
  await page.evaluate(value => window.timingEvents.dispatchEvent(new MessageEvent('sync', { data: JSON.stringify(value) })), snapshot)
  await page.waitForFunction(() => document.querySelector('.flip-status-text')?.getAttribute('aria-label') === '正在生成回复')
  delete snapshot.status.modelOutput
  await page.evaluate(value => window.timingEvents.dispatchEvent(new MessageEvent('sync', { data: JSON.stringify(value) })), snapshot)
  await page.waitForFunction(() => document.querySelector('.flip-status-text')?.getAttribute('aria-label') === '正在调用模型')

  snapshot.status = { phase: 'ready', queryTiming: { ...query, status: 'finished', durationMs: 42000 },
    toolTimings: [{ ...tool, status: 'finished', durationMs: 17900 }] }
  snapshot.busy = false
  snapshot.lines[0] = { ...snapshot.lines[0], live: false, timing: snapshot.status.toolTimings[0] }
  await page.evaluate(value => window.timingEvents.dispatchEvent(new MessageEvent('sync', { data: JSON.stringify(value) })), snapshot)
  await page.waitForTimeout(100)
  const final = await pill.textContent()
  assert.equal(final, '17s', 'final duration also shows whole seconds')
  assert.equal(await page.locator('.message-loading-label').count(), 0, 'final clock has no redundant caption')
  assert.equal(await page.locator('.elapsed-clock').getAttribute('title'), null, 'no verbose tooltip')
  const compactSpacing = await page.locator('.elapsed-clock').evaluate(node => ({
    gap: getComputedStyle(node).columnGap,
    minWidth: getComputedStyle(node.querySelector('.elapsed-clock-value')).minWidth,
  }))
  assert.equal(compactSpacing.gap, '2px', 'clock and time have a compact gap')
  assert.equal(compactSpacing.minWidth, 'auto', 'time has no extra reserved width')
  const faceFill = () => page.locator('.clock-ticks .major').first().evaluate(node => getComputedStyle(node).stroke)
  const assertTransparentClock = async () => {
    const styles = await page.locator('.elapsed-clock').evaluate(node => {
      const face = node.querySelector('.elapsed-clock-face')
      return {
        background: getComputedStyle(node).backgroundColor,
        faceBackground: getComputedStyle(face).backgroundColor,
        shadow: getComputedStyle(face).boxShadow,
        rim: getComputedStyle(node.querySelector('.clock-rim')).fill,
        well: getComputedStyle(node.querySelector('.clock-well')).fill,
      }
    })
    assert.deepEqual(styles, { background: 'rgba(0, 0, 0, 0)', faceBackground: 'rgba(0, 0, 0, 0)', shadow: 'none', rim: 'none', well: 'none' })
  }
  await assertTransparentClock()
  const initialTheme = await page.evaluate(() => document.documentElement.dataset.theme)
  const initialFill = await faceFill()
  const handBeforeThemeChange = await page.locator('.clock-hand').evaluate(node => node.style.transform)
  await page.locator('.theme-toggle:visible').click()
  await page.waitForFunction(theme => document.documentElement.dataset.theme !== theme, initialTheme)
  assert.notEqual(await faceFill(), initialFill, 'clock strokes follow the real theme toggle')
  await assertTransparentClock()
  assert.equal(await page.locator('.clock-hand').evaluate(node => node.style.transform), handBeforeThemeChange, 'theme switch never resets elapsed time')
  await page.locator('.theme-toggle:visible').click()
  await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, initialTheme)
  assert.equal(await faceFill(), initialFill, 'clock palette restores when switching back')
  await page.waitForTimeout(1200)
  assert.equal(await pill.textContent(), final, 'final tool duration is frozen')
  await page.reload()
  await pill.waitFor()
  assert.equal(await pill.textContent(), final, 'refresh retains core final duration')

  // Exact geometry and minute rollover: no CSS animation invents its own time origin.
  for (const [ms, degrees] of [[15000, 90], [30000, 180], [59000, 354], [60000, 360], [61000, 366], [120000, 720]]) {
    snapshot.status.queryTiming = { ...query, status: 'finished', durationMs: ms }
    await page.evaluate(value => window.timingEvents.dispatchEvent(new MessageEvent('sync', { data: JSON.stringify(value) })), snapshot)
    await page.waitForTimeout(40)
    assert.equal(await page.locator('.clock-hand').evaluate(node => node.style.transform), `rotate(${degrees}deg)`)
  }
  await page.waitForTimeout(1100)
  assert.equal(await page.locator('.clock-hand').evaluate(node => node.style.transform), 'rotate(720deg)', 'finished clock freezes')

  snapshot.status = { phase: 'ready', queryTiming: { ...query, status: 'finished', durationMs: 999 },
    toolTimings: [{ ...tool, status: 'finished', durationMs: 999 }] }
  snapshot.lines[0].timing = snapshot.status.toolTimings[0]
  await page.evaluate(value => window.timingEvents.dispatchEvent(new MessageEvent('sync', { data: JSON.stringify(value) })), snapshot)
  await page.waitForTimeout(100)
  assert.equal(await page.locator('.elapsed-pill').count(), 0, 'subsecond completed tool has no badge')
  assert.equal(await page.locator('.message-loading-label').count(), 0, 'subsecond query has no empty final label')

  snapshot.busy = true
  snapshot.status = { phase: 'running_tools', queryTiming: { ...query, elapsedMs: 0 },
    toolTimings: [{ ...tool, elapsedMs: 0 }] }
  snapshot.lines[0] = { ...snapshot.lines[0], live: true, timing: snapshot.status.toolTimings[0] }
  await page.evaluate(value => window.timingEvents.dispatchEvent(new MessageEvent('sync', { data: JSON.stringify(value) })), snapshot)
  await page.waitForTimeout(100)
  assert.equal(await page.locator('.elapsed-pill').count(), 0, 'zero-second running tool has no badge')
  assert.equal(await page.locator('.elapsed-clock').count(), 0, 'zero-second clock is hidden')
  assert.doesNotMatch(await page.locator('.message-loading-label').last().textContent(), /已用时|0s/, 'no empty elapsed label')
  await page.waitForFunction(() => /^\d+s$/.test(document.querySelector('.elapsed-pill')?.textContent || ''))
  assert.equal(await page.locator('.elapsed-clock').count(), 1)
  assert.equal(await page.locator('.message-loading-emblem').count(), 0, 'commented ornament is not rendered')

  snapshot = { ...snapshot, busy: false, status: { phase: 'ready' }, lines: [{ ...snapshot.lines[0], live: false, timing: undefined }] }
  await page.evaluate(value => window.timingEvents.dispatchEvent(new MessageEvent('sync', { data: JSON.stringify(value) })), snapshot)
  await page.waitForTimeout(100)
  assert.equal(await page.locator('.elapsed-pill').count(), 0, 'legacy history has no fabricated timer')
  assert.deepEqual(fixture.errors, [])
  console.log('PASS: core baseline interpolation, final freeze, refresh, legacy unknown in production App')
} finally { await fixture.close() }
