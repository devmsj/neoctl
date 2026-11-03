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
    const root = p.locator('.reasoning-slider'), fill = p.locator('.effort-fill'), head = p.locator('.effort-head')
    const settled = () => p.waitForFunction(() => !document.querySelector('.effort-control').getAnimations({ subtree: true }).some(a => a instanceof CSSTransition), null, { timeout: 3000 })
    assert.equal(await slider.getAttribute('aria-valuetext'), 'high')
    assert.equal(await p.locator('.effort-track').count(), 1)
    // Colors come from appearance tokens, never fixed palette values.
    assert.equal(await head.evaluate(el => getComputedStyle(el).getPropertyValue('--effort-color').trim()), await head.evaluate(el => getComputedStyle(el).getPropertyValue('--chrome-accent').trim()))
    await p.evaluate(() => document.documentElement.style.setProperty('--appearance-accent', '#12ab34'))
    // Theme colors may transition; wait for the settled appearance color.
    const green = 'rgb(18, 171, 52)'
    await p.waitForFunction(green => getComputedStyle(document.querySelector('.effort-head')).borderTopColor === green && getComputedStyle(document.querySelector('.effort-labels button.selected')).color === green, green, { timeout: 3000 })
    assert.equal(await fill.evaluate(el => getComputedStyle(el).backgroundColor), green)
    assert.ok((await head.evaluate(el => getComputedStyle(el).boxShadow)).includes(green))
    await p.evaluate(() => document.documentElement.style.removeProperty('--appearance-accent'))
    // The sweep keeps running inside the fill and speeds up with deeper effort.
    const rate = () => p.locator('.effort-sheen').evaluate(el => el.getAnimations()[0].playbackRate)
    assert.equal(await p.locator('.effort-sheen').evaluate(el => el.getAnimations()[0].playState), 'running')
    const highRate = await rate()
    await slider.focus(); await slider.press('ArrowRight')
    assert.equal(await slider.getAttribute('aria-valuetext'), 'xhigh')
    await p.waitForTimeout(60); assert.ok(await rate() > highRate)
    assert.equal(await p.locator('.effort-tick.lit').count(), 5)
    await slider.press('Home'); assert.equal(await slider.getAttribute('aria-valuetext'), 'none')
    await p.waitForTimeout(60); assert.ok(await rate() < highRate)
    assert.equal(await p.locator('.effort-tick.lit').count(), 1)
    // Hover previews the target tier without changing the draft.
    await settled()
    const hoverBox = await slider.boundingBox()
    await p.mouse.move(hoverBox.x + hoverBox.width - 12, hoverBox.y + hoverBox.height / 2)
    assert.equal(await p.locator('.effort-ghost').count(), 1)
    assert.ok((await p.locator('.effort-preview').boundingBox()).width > (await fill.boundingBox()).width)
    assert.equal(await slider.getAttribute('aria-valuetext'), 'none')
    await p.mouse.move(hoverBox.x + hoverBox.width / 2, hoverBox.y - 80)
    assert.equal(await p.locator('.effort-ghost, .effort-preview').count(), 0)
    await slider.focus(); await slider.press('End'); assert.equal(await slider.getAttribute('aria-valuetext'), 'max')
    assert.equal(await root.evaluate(el => el.style.getPropertyValue('--effort-level')), '1.000')
    await p.locator('.effort-labels').getByRole('button', { name: 'medium', exact: true }).click()
    assert.equal(await slider.getAttribute('aria-valuetext'), 'medium')
    const box = await slider.boundingBox()
    await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await p.mouse.down()
    await p.mouse.move(box.x + box.width - 10, box.y + box.height / 2, { steps: 8 })
    assert.ok(await p.locator('.reasoning-slider.is-dragging').count())
    assert.ok(Number(await root.evaluate(el => el.style.getPropertyValue('--effort-level'))) > .6)
    await p.mouse.up(); assert.equal(await slider.getAttribute('aria-valuetext'), 'max')
    assert.equal(await p.locator('.reasoning-slider.is-dragging').count(), 0)
    await p.getByRole('radio', { name: 'custom', exact: true }).check()
    assert.equal(await slider.getAttribute('aria-valuetext'), '请选择推理强度')
    assert.equal(await head.evaluate(el => getComputedStyle(el).opacity), '0')
    assert.equal(await p.locator('.effort-tick.lit').count(), 0)
    await settled(); const emptyFill = await fill.boundingBox(); assert.ok(!emptyFill || emptyFill.width < 1)
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
      const initial = await root.boundingBox()
      const actions = await p.locator('.session-model-modal .context-window-actions').boundingBox()
      for (const effort of efforts) {
        await p.locator('.effort-labels').getByRole('button', { name: effort, exact: true }).click()
        await p.mouse.move(0, 0); await settled()
        assert.deepEqual(await root.boundingBox(), initial)
        assert.deepEqual(await p.locator('.session-model-modal .context-window-actions').boundingBox(), actions)
        assert.equal(await root.getByText(effort, { exact: true }).count(), 1)
        const label = await p.locator('.effort-labels button.selected').boundingBox(), center = label.x + label.width / 2
        const h = await head.boundingBox(), f = await fill.boundingBox()
        assert.ok(Math.abs(h.x + h.width / 2 - center) < 1.5, `${effort} head aligns with label`)
        assert.ok(Math.abs(f.x + f.width - center) < 1.5, `${effort} fill ends at the head`)
        assert.equal(await p.locator('.effort-tick.lit').count(), efforts.indexOf(effort) + 1)
        assert.ok(await p.locator('.effort-scroll').evaluate(el => el.scrollWidth <= el.clientWidth))
        assert.ok(await p.locator('.session-model-modal').evaluate(el => el.scrollWidth <= el.clientWidth))
      }
    }
    await p.emulateMedia({ reducedMotion: 'reduce' })
    assert.equal(await head.evaluate(el => getComputedStyle(el).transitionDuration), '0s')
    assert.equal(await head.evaluate(el => getComputedStyle(el).animationName), 'none')
    assert.equal(await p.locator('.effort-sheen').evaluate(el => getComputedStyle(el).animationName), 'none')
    await slider.focus(); await slider.press('Home'); assert.equal(await slider.getAttribute('aria-valuetext'), 'none')
    assert.deepEqual(ui.errors, [])
    assert.equal(ui.requests.filter(r => r.method === 'POST' && /model/.test(r.url)).length, 0)
  } finally { await ui.close() }
})
