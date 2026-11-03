import test from 'node:test'
import assert from 'node:assert/strict'
import { createObservabilityBrowser, observabilitySnapshot } from './observability-browser-fixture.mjs'

test('composer keeps model ID and usage in one compact row', async () => {
  const ui = await createObservabilityBrowser(observabilitySnapshot({ modelSettings: { model: 'gpt-6-astra', reasoning: { effort: 'high' } } }))
  try {
    const model = ui.page.locator('.composer-usage .model-chip')
    await model.waitFor()
    assert.equal(await model.innerText(), 'gpt-6-astra')
    assert.equal(await model.locator('em').count(), 0)
    for (const width of [1440, 980, 600, 390]) {
      await ui.page.setViewportSize({ width, height: 900 })
      const layout = await ui.page.locator('.composer-usage').evaluate(el => ({
        fits: el.scrollWidth <= el.clientWidth,
        items: [...el.children].map(item => ({
          y: item.getBoundingClientRect().top,
          width: item.getBoundingClientRect().width,
          separator: getComputedStyle(item, '::before').width,
        })),
      }))
      assert.equal(layout.items.length, 4)
      assert.ok(layout.fits, `row overflows at ${width}px`)
      assert.ok(layout.items.every(item => item.width > 0 && Math.abs(item.y - layout.items[0].y) < 1))
      assert.ok(layout.items.slice(1).every(item => item.separator === '1px'))
    }
    await model.click()
    await ui.page.getByRole('dialog', { name: '选择模型', exact: true }).waitFor({ timeout: 3000 })
  } finally { await ui.close() }
})

test('Claude first-packet input usage corrects the context meter while output keeps streaming', async () => {
  const snapshot = observabilitySnapshot({ modelSettings: { model: 'claude-haiku-5-5' } })
  snapshot.status = { ...snapshot.status, phase: 'calling_model', usage: { inputTokens: 25600 }, streamedOutputTokens: 1234, metrics: { model: 'claude-haiku-5-5', estimatedInputTokens: 1000, contextWindowTokens: 256000, contextUsageRatio: 1000 / 256000 } }
  const ui = await createObservabilityBrowser(snapshot)
  try {
    await ui.page.waitForFunction(() => document.querySelector('.composer-usage')?.textContent.includes('10.0%'))
    const text = await ui.page.locator('.composer-usage').innerText()
    assert.match(text, /输入\s*26k/i) // Existing compact formatter rounds values above 10k.
    assert.match(text, /1\.2k/i)
  } finally { await ui.close() }
})

test('composer shows unconfigured model placeholder without a label', async () => {
  const ui = await createObservabilityBrowser(observabilitySnapshot())
  try {
    const model = ui.page.locator('.composer-usage .model-chip')
    await model.waitFor()
    assert.equal(await model.innerText(), '模型未配置')
    assert.equal(await model.locator('em').count(), 0)
  } finally { await ui.close() }
})
