import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createObservabilityBrowser, observabilitySnapshot } from './observability-browser-fixture.mjs'

test('compact composer preserves metrics and actions across desktop widths', async () => {
  const fixture = await createObservabilityBrowser(observabilitySnapshot())
  try {
    const { page } = fixture
    for (const width of [1912, 1474, 1132, 1000]) {
      await page.setViewportSize({ width, height: 948 })
      const metrics = page.locator('.composer-metrics')
      await metrics.waitFor()
      assert.deepEqual(await metrics.locator('.metric-chip em').allTextContents(), ['模型', '上下文', '输入', '输出'])
      for (const label of ['快速模式', '压缩会话']) assert.equal(await metrics.getByRole('button', { name: label, exact: true }).isVisible(), true)
      const layout = await page.locator('.composer-footer').evaluate(el => {
        const r = el.getBoundingClientRect()
        return { height: r.height, overflow: el.scrollWidth > el.clientWidth + 1, boxes: [...el.querySelectorAll('.metric-chip')].map(chip => ({ border: getComputedStyle(chip).borderTopWidth, shadow: getComputedStyle(chip).boxShadow })) }
      })
      console.log(JSON.stringify({ width, ...layout }))
      {
        assert.equal(layout.overflow, false)
        for (const box of layout.boxes) { assert.equal(box.border, '0px'); assert.equal(box.shadow, 'none') }
        if (width >= 1474) assert.ok(layout.height <= 32)
      }
      const cwd = page.locator('.composer-cwd')
      assert.equal(await cwd.isVisible(), true)
      assert.equal(await page.locator('.composer-actions button').count(), 2)
      if (width === 1474) await page.locator('.composer').screenshot({ path: join(tmpdir(), 'neo-compact-composer.png') })
    }
    await page.setViewportSize({ width: 390, height: 948 })
    await page.locator('.mobile-session-options > summary').click()
    assert.equal(await page.locator('.mobile-session-options').getAttribute('open'), '')
    assert.equal(await page.locator('.composer').evaluate(el => el.scrollWidth > el.clientWidth + 1), false)
    assert.deepEqual(fixture.errors, [])
  } finally { await fixture.close() }
})
