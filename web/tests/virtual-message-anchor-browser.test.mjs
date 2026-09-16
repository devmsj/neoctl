import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createObservabilityBrowser, observabilitySnapshot } from './observability-browser-fixture.mjs'

function history() {
  let id = 0
  const lines = []
  for (let round = 0; round < 90; round++) {
    lines.push({ id: ++id, kind: 'assistant', text: `Round ${round}\n\n` + '| 项目 | 结果 |\n| --- | --- |\n' + '| 检查 | 完成 |\n'.repeat(3 + round % 7) })
    for (let step = 0; step < 8; step++) {
      lines.push({ id: ++id, kind: 'tool', toolName: 'file_read', titleStatus: 'success', text: 'done',
        toolDisplay: { purpose: step < 2 ? `检查 ${round}-${step}` : '', facts: [], previews: [] } })
    }
  }
  lines.push({ id: ++id, kind: 'assistant', text: '已完成' })
  return lines
}

async function settle(page) {
  await page.waitForTimeout(350)
}

async function toggleAndMeasure(trigger) {
  return trigger.evaluate(async el => {
    const before = el.getBoundingClientRect().top
    const samples = []
    el.click()
    for (let frame = 0; frame < 24; frame++) {
      await new Promise(requestAnimationFrame)
      samples.push(el.isConnected ? el.getBoundingClientRect().top - before : null)
    }
    return { samples, expanded: el.getAttribute('aria-expanded') }
  })
}

for (const position of ['middle', 'bottom', 'narrow-bottom']) {
  test(`virtual tool group preserves its trigger on expand/collapse at ${position}`, async () => {
    const fixture = await createObservabilityBrowser(observabilitySnapshot({ lines: history() }))
    try {
      const { page } = fixture
      await page.locator('.tool-group-trigger').first().waitFor()
      await settle(page)
      if (position === 'narrow-bottom') {
        await page.setViewportSize({ width: 430, height: 850 })
        await settle(page)
      }
      // Visit measured history before returning; resetting all sizes must not discard it.
      for (const fraction of [0, .25, .5, .75, 1, position === 'middle' ? .5 : 1]) {
        await page.locator('.transcript').evaluate((el, fraction) => { el.scrollTop = (el.scrollHeight - el.clientHeight) * fraction }, fraction)
        await settle(page)
      }
      const index = await page.locator('.tool-group-trigger').evaluateAll(elements => {
        const scroller = document.querySelector('.transcript').getBoundingClientRect()
        return elements.findLastIndex(el => {
          const box = el.getBoundingClientRect()
          return box.top >= scroller.top + 30 && box.bottom <= scroller.bottom - 30
        })
      })
      assert.ok(index >= 0, 'a visible trigger exists')
      const trigger = page.locator('.tool-group-trigger').nth(index)
      await trigger.evaluate(el => { el.dataset.anchorTest = 'target' })
      const target = page.locator('[data-anchor-test="target"]')
      let maxDrift = 0
      for (const expected of ['true', 'false', 'true', 'false']) {
        const result = await toggleAndMeasure(target)
        assert.equal(result.expanded, expected)
        maxDrift = Math.max(maxDrift, ...result.samples.map(Math.abs))
        assert.ok(result.samples.every(delta => delta !== null && Math.abs(delta) <= 2), `trigger drift at ${position}: ${JSON.stringify(result.samples)}`)
      }
      const rapid = await target.evaluate(async el => {
        const before = el.getBoundingClientRect().top
        for (let i = 0; i < 8; i++) {
          el.click()
          await new Promise(requestAnimationFrame)
        }
        await new Promise(requestAnimationFrame)
        return { drift: el.getBoundingClientRect().top - before, expanded: el.getAttribute('aria-expanded') }
      })
      assert.equal(rapid.expanded, 'false')
      assert.ok(Math.abs(rapid.drift) <= 2, `rapid toggle drift: ${rapid.drift}`)
      console.log(`${position}: maximum trigger drift ${maxDrift}px`)
      assert.ok(await page.locator('.virtual-message-row').count() < 45, 'long history stays virtualized')
      assert.deepEqual(fixture.errors, [])
    } finally { await fixture.close() }
  })
}

for (const nested of [false, true]) {
  test(`agent process expansion preserves ${nested ? 'nested' : 'standalone'} header`, async () => {
    const lines = history()
    lines.push({ id: 2000, kind: 'tool', toolName: 'subagent_run', text: 'done',
      toolDisplay: { purpose: '检查项目', facts: [], previews: [] },
      toolStream: { steps: Array.from({ length: 30 }, (_, i) => ({ key: String(i), toolName: 'file_read', toolLabel: '读取文件', message: `步骤 ${i}`, status: 'completed' })) } })
    if (nested) lines.push({ id: 2001, kind: 'tool', toolName: 'file_read', text: 'done' })
    lines.push({ id: 2002, kind: 'assistant', text: '完成' })
    const fixture = await createObservabilityBrowser(observabilitySnapshot({ lines }))
    try {
      const { page } = fixture
      await page.locator('.tool-group-trigger').first().waitFor()
      await settle(page)
      await page.locator('.transcript').evaluate(el => { el.scrollTop = el.scrollHeight })
      await settle(page)
      if (nested) {
        await page.locator('.tool-group-message > .tool-group-shell > .tool-group-trigger').last().click()
        await settle(page)
      }
      const trigger = page.locator('.tool-result-detail-row .tool-group-trigger').last()
      await trigger.scrollIntoViewIfNeeded()
      await settle(page)
      for (let i = 0; i < 4; i++) {
        const result = await toggleAndMeasure(trigger)
        assert.equal(result.expanded, i % 2 === 0 ? 'true' : 'false')
        assert.ok(result.samples.every(delta => delta !== null && Math.abs(delta) <= 2), `agent drift: ${JSON.stringify(result.samples)}`)
      }
      assert.deepEqual(fixture.errors, [])
    } finally { await fixture.close() }
  })
}

test('manual expansion keeps normal append/stream following and history reading intact', async () => {
  const snapshot = observabilitySnapshot({ lines: history() })
  const fixture = await createObservabilityBrowser(snapshot)
  try {
    const { page } = fixture
    // Deterministic server events through the same EventSource listeners as production.
    await page.addInitScript(() => {
      window.EventSource = class extends EventTarget {
        constructor() { super(); window.testEvents = this }
        close() {}
      }
    })
    await page.reload()
    await page.waitForFunction(() => Boolean(window.testEvents))
    await settle(page)
    const scroller = page.locator('.transcript')
    await scroller.evaluate(el => { el.scrollTop = el.scrollHeight })
    await settle(page)
    const trigger = page.locator('.tool-group-trigger').last()
    await toggleAndMeasure(trigger)
    await toggleAndMeasure(trigger)
    assert.ok(await scroller.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop) <= 2, 'toggle cycle returns to its original position')
    const sendSnapshot = () => page.evaluate(snapshot => {
      window.testEvents.dispatchEvent(new MessageEvent('sync', { data: JSON.stringify(snapshot) }))
    }, snapshot)
    snapshot.lines.push({ id: 3000, kind: 'assistant', text: '新回复', live: true })
    await sendSnapshot()
    await settle(page)
    const distanceFromEnd = () => scroller.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)
    // Virtualizer follows the final row; the transcript's bottom padding need not be scrolled away.
    const bottomPadding = await scroller.evaluate(el => parseFloat(getComputedStyle(el).paddingBottom))
    assert.ok(await distanceFromEnd() <= bottomPadding + 2, `new messages follow at the bottom after toggling: ${await distanceFromEnd()}px`)
    snapshot.lines.at(-1).text += '\n\n流式回复'.repeat(20)
    await sendSnapshot()
    await settle(page)
    assert.ok(await distanceFromEnd() <= bottomPadding + 2, 'growing reply still follows at the bottom')
    await scroller.evaluate(el => { el.scrollTop -= 1400 })
    await settle(page)
    const before = await scroller.evaluate(el => el.scrollTop)
    snapshot.lines.at(-1).text += '\n\n继续回复'.repeat(20)
    await sendSnapshot()
    await settle(page)
    assert.ok(Math.abs(await scroller.evaluate(el => el.scrollTop) - before) <= 2, 'incoming content does not pull a reader out of history')
    assert.deepEqual(fixture.errors, [])
  } finally { await fixture.close() }
})
