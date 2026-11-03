import test from 'node:test'
import assert from 'node:assert/strict'
import { createObservabilityBrowser, observabilitySnapshot } from './observability-browser-fixture.mjs'
import { emptyAppearance } from '../shared/appearance.mjs'

const efforts = ['none', 'low', 'medium', 'high', 'xhigh', 'max']
test('reasoning slider supports drag, keys, custom/empty/single tiers and preserves draft-only selection', async () => {
  const models = { standard: efforts, custom: ['gentle', 'ultra-v2'], single: ['only'], plain: [] }
  const snapshot = observabilitySnapshot({
    modelSettings: { model: 'standard', reasoning: { effort: 'high' } },
    catalog: { modelIds: Object.keys(models), modelReasoning: models, modelReasoningEnabled: { plain: false }, commands: [] },
  })
  const ui = await createObservabilityBrowser(snapshot, async route => {
    if (new URL(route.request().url()).pathname === '/api/appearance') { await route.fulfill({ json: { config: emptyAppearance(), revision: '0' } }); return true }
  })
  try {
    const p = ui.page
    await p.getByRole('button', { name: '选择模型', exact: true }).click()
    const slider = p.getByRole('slider', { name: '推理强度' })
    assert.equal(await slider.getAttribute('aria-valuetext'), 'high')
    const flow = p.locator('.effort-flow').first()
    const beforeFlow = await flow.evaluate(el => getComputedStyle(el).transform)
    await p.waitForTimeout(220)
    assert.notEqual(await flow.evaluate(el => getComputedStyle(el).transform), beforeFlow)
    assert.deepEqual(await flow.evaluate(el => { const m = new DOMMatrix(getComputedStyle(el).transform); return [m.a, m.b, m.c, m.d, m.f] }), [1, 0, 0, 1, 0])
    const idleRate = await flow.evaluate(el => el.getAnimations()[0].playbackRate)
    await slider.focus(); await slider.press('ArrowRight')
    assert.ok(Number(await p.locator('.reasoning-slider').evaluate(el => el.style.getPropertyValue('--effort-stretch'))) > 1)
    await p.waitForTimeout(1200)
    assert.equal(Number(await p.locator('.reasoning-slider').evaluate(el => el.style.getPropertyValue('--effort-stretch'))), 1)
    assert.equal(await slider.getAttribute('aria-valuetext'), 'xhigh')
    await slider.press('Home'); assert.equal(await slider.getAttribute('aria-valuetext'), 'none')
    await slider.press('End'); assert.equal(await slider.getAttribute('aria-valuetext'), 'max')
    await p.locator('.effort-labels').getByRole('button', { name: 'medium', exact: true }).click()
    assert.equal(await slider.getAttribute('aria-valuetext'), 'medium')
    const box = await slider.boundingBox()
    await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await p.mouse.down()
    await p.mouse.move(box.x + box.width - 10, box.y + box.height / 2, { steps: 8 })
    assert.ok(await p.locator('.reasoning-slider.is-dragging').count())
    await p.waitForTimeout(70)
    const fastRate = await flow.evaluate(el => el.getAnimations()[0].playbackRate)
    assert.ok(fastRate > idleRate + .2, `flow accelerated: ${idleRate} -> ${fastRate}`)
    assert.deepEqual(await flow.evaluate(el => { const m = new DOMMatrix(getComputedStyle(el).transform); return [m.a, m.b, m.c, m.d, m.f] }), [1, 0, 0, 1, 0])
    await p.mouse.up(); assert.equal(await slider.getAttribute('aria-valuetext'), 'max')
    await p.waitForTimeout(2400)
    assert.ok(Math.abs(await flow.evaluate(el => el.getAnimations()[0].playbackRate) - idleRate) < .03)
    assert.equal(await p.locator('.reasoning-slider.is-dragging').count(), 0)
    await p.getByRole('radio', { name: 'custom', exact: true }).check()
    assert.equal(await slider.getAttribute('aria-valuetext'), '请选择推理强度')
    await slider.focus(); await slider.press('End'); assert.equal(await slider.getAttribute('aria-valuetext'), 'ultra-v2')
    await p.getByRole('radio', { name: 'single', exact: true }).check()
    assert.ok(await slider.isDisabled())
    await p.locator('.effort-labels button').click(); assert.equal(await slider.getAttribute('aria-valuetext'), 'only')
    await p.getByRole('radio', { name: 'plain', exact: true }).check()
    assert.equal(await slider.count(), 0); assert.equal(await p.locator('.effort-value').textContent(), '不支持推理')
    await p.getByRole('radio', { name: 'standard', exact: true }).check()
    await p.setViewportSize({ width: 390, height: 844 })
    await p.locator('.effort-labels').getByRole('button', { name: 'high', exact: true }).click()
    assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    // Every tier keeps the same dialog/slider geometry, including both endpoints.
    for (const width of [1100, 390]) {
      await p.setViewportSize({ width, height: 844 })
      const initial = await p.locator('.reasoning-slider').boundingBox()
      const actions = await p.locator('.session-model-modal .context-window-actions').boundingBox()
      for (const effort of efforts) {
        await p.locator('.effort-labels').getByRole('button', { name: effort, exact: true }).click()
        await p.waitForTimeout(460)
        assert.deepEqual(await p.locator('.reasoning-slider').boundingBox(), initial)
        assert.deepEqual(await p.locator('.session-model-modal .context-window-actions').boundingBox(), actions)
        assert.equal(await p.locator('.reasoning-slider').getByText(effort, { exact: true }).count(), 1)
        assert.ok(await p.locator('.effort-scroll').evaluate(el => el.scrollWidth <= el.clientWidth))
        assert.ok(await p.locator('.session-model-modal').evaluate(el => el.scrollWidth <= el.clientWidth))
      }
    }
    await p.emulateMedia({ reducedMotion: 'reduce' })
    assert.equal(await p.locator('.effort-thumb').evaluate(el => getComputedStyle(el).transitionDuration), '0s')
    assert.equal(await flow.evaluate(el => getComputedStyle(el).animationName), 'none')
    await slider.focus(); await slider.press('Home')
    assert.equal(Number(await p.locator('.reasoning-slider').evaluate(el => el.style.getPropertyValue('--effort-stretch'))), 1)
    assert.deepEqual(ui.errors, [])
    assert.equal(ui.requests.filter(r => r.method === 'POST' && /model/.test(r.url)).length, 0)
  } finally { await ui.close() }
})
