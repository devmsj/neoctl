import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createObservabilityBrowser, observabilitySnapshot } from './observability-browser-fixture.mjs'

test('right panel stays single-column across desktop breakpoints', async () => {
  const fixture = await createObservabilityBrowser(observabilitySnapshot({ agentTaskHistory: [{ kind: 'agent', taskId: 'responsive-task', agentId: 'child', description: '检查项目文档与启动命令', status: 'completed', runGeneration: 1 }] }))
  try {
    const { page } = fixture
    await page.locator('.right-panel').waitFor()
    for (const width of [1912, 1440, 1181, 1180, 1132, 1000, 821]) {
      await page.setViewportSize({ width, height: 948 })
      const layout = await page.locator('.right-panel').evaluate(el => {
        const panel = el.getBoundingClientRect()
        const cards = [...el.children].filter(child => child.getBoundingClientRect().height > 0).map(child => {
          const r = child.getBoundingClientRect()
          return { x: r.x, y: r.y, width: r.width, bottom: r.bottom, overflow: child.scrollWidth > child.clientWidth + 1 }
        })
        return { width: panel.width, cards }
      })
      assert.ok(layout.cards.length >= 2, `${width}: task and memory cards`)
      for (const [index, card] of layout.cards.entries()) {
        assert.ok(card.width >= layout.width - 2, `${width}: full sidebar width`)
        assert.equal(card.overflow, false, `${width}: no card overflow`)
        if (index) assert.ok(card.y >= layout.cards[index - 1].bottom, `${width}: vertically stacked`)
      }
    }
    await page.setViewportSize({ width: 820, height: 948 })
    assert.equal(await page.locator('.right-panel').isVisible(), false)
    assert.deepEqual(fixture.errors, [])
  } finally { await fixture.close() }
})
