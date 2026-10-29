import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createObservabilityBrowser, observabilitySnapshot } from './observability-browser-fixture.mjs'

for (const title of ['检查项目文档', '检查项目文档与启动命令以及移动端布局'.repeat(12), '']) {
  test(`mobile session title: ${title ? title.length : 'empty'}`, async () => {
    const fixture = await createObservabilityBrowser(observabilitySnapshot({ session: { sessionId: 'obs-session', title } }))
    try {
      const { page } = fixture
      for (const width of [820, 541, 390, 320]) {
        await page.setViewportSize({ width, height: 948 })
        if (!title) { assert.equal(await page.locator('.mobile-session-title').count(), 0); continue }
        const heading = page.locator('.mobile-session-title')
        await heading.waitFor()
        assert.equal(await heading.textContent(), title)
        assert.equal(await heading.getAttribute('data-tooltip'), title)
        const h = await heading.boundingBox()
        const menu = await page.locator('.mobile-nav-menu > summary').boundingBox()
        assert.equal(await page.locator('.mobile-theme-toggle').count(), 0)
        assert.ok(h.x > menu.x + menu.width && h.x + h.width < width - 12)
        assert.ok(Math.abs(h.x + h.width / 2 - width / 2) < 2)
        assert.ok(h.height <= 24)
        const rail = await page.locator('.topbar').evaluate(el => ({height:el.getBoundingClientRect().height,background:getComputedStyle(el).backgroundColor,border:getComputedStyle(el).borderBottomWidth}))
        assert.equal(rail.height,48); assert.equal(rail.background,'rgba(0, 0, 0, 0)'); assert.equal(rail.border,'0px')
        assert.equal(await heading.evaluate(el=>getComputedStyle(el).textAlign),'left')
        assert.equal(await page.locator('.mobile-nav-menu > summary').evaluate(el=>getComputedStyle(el).borderTopWidth),'0px')
        const create = await page.locator('.topbar .new-session-button').boundingBox()
        assert.ok(create.x >= h.x+h.width && create.x+create.width <= width-9)
        assert.ok(Math.abs(menu.y+menu.height/2-(h.y+h.height/2))<1)
        assert.ok(Math.abs(create.y-menu.y)<1)
        assert.equal(await heading.evaluate(el => getComputedStyle(el).textOverflow), 'ellipsis')
        if (title.length > 100) assert.ok(await heading.evaluate(el => el.scrollWidth > el.clientWidth))
        await page.locator('.mobile-nav-menu > summary').click()
        await heading.click()
        assert.equal(await page.locator('.mobile-nav-menu').getAttribute('open'), null)
      }
      await page.setViewportSize({ width: 1440, height: 948 })
      assert.equal(await page.locator('.mobile-session-title').isVisible(), false)
      assert.deepEqual(fixture.errors, [])
    } finally { await fixture.close() }
  })
}
