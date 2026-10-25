import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createObservabilityBrowser, observabilitySnapshot } from './observability-browser-fixture.mjs'

test('small desktop keeps composer actions and dialog controls reachable', async () => {
  const fixture = await createObservabilityBrowser(observabilitySnapshot({
    modelSettings: { model: 'gpt-6-astra', reasoning: { effort: 'high' } },
    status: { phase: 'ready', metrics: { contextUsageRatio: .027 }, usage: { inputTokens: 7000, outputTokens: 0 } },
  }))
  try {
    const { page } = fixture
    await page.evaluate(() => document.documentElement.dataset.neoDesktop = '')
    for (const theme of ['dark', 'light']) for (const width of [520, 640, 821, 888]) {
      await page.setViewportSize({ width, height: 420 })
      await page.evaluate(value => document.documentElement.dataset.theme = value, theme)
      await page.waitForTimeout(80)
      const layout = await page.locator('.composer').evaluate(el => {
        const rect = el.getBoundingClientRect()
        return { top: rect.top, bottom: rect.bottom, overflow: el.scrollWidth > el.clientWidth + 1,
          pageOverflow: document.documentElement.scrollWidth > innerWidth + 1,
          buttons: [...el.querySelectorAll('.composer-actions button')].map(button => button.getBoundingClientRect().toJSON()) }
      })
      assert.ok(layout.top >= 80 && layout.bottom <= 420, `${theme}/${width}: composer within window`)
      assert.equal(layout.overflow, false)
      assert.equal(layout.pageOverflow, false)
      for (const button of layout.buttons) assert.ok(button.bottom <= 420 && button.left >= 0 && button.right <= width)
      await page.getByRole('button', { name: '选择模型', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: '选择模型', exact: true })
      await dialog.waitFor()
      for (const name of ['取消', '保存模型设置']) {
        const button = dialog.getByRole('button', { name, exact: true })
        if (!await button.count()) continue
        await button.scrollIntoViewIfNeeded()
        const rect = await button.boundingBox()
        assert.ok(rect.y >= 0 && rect.y + rect.height <= 420)
      }
      const box = await page.getByRole('dialog', {name:'选择模型',exact:true}).boundingBox()
      assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= width + 1 && box.y + box.height <= 421)
      // Escape belongs to candidate selection until composition ends.
      const search = dialog.getByRole('searchbox')
      await search.focus()
      await search.dispatchEvent('compositionstart')
      await search.dispatchEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true })
      assert.equal(await dialog.isVisible(), true)
      await search.dispatchEvent('compositionend')
      await page.keyboard.press('Escape')
      await dialog.waitFor({state:'hidden'})
    }
    assert.deepEqual(fixture.errors, [])
  } finally { await fixture.close() }
})
