import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createObservabilityBrowser, observabilitySnapshot } from './observability-browser-fixture.mjs'

for (const quota of [false, true]) test(`mobile menu opens registered sidebar cards (quota=${quota})`, async () => {
  const fixture = await createObservabilityBrowser(observabilitySnapshot(), async route => {
    if (route.request().url().includes('/api/client-info')) {
      await route.fulfill({ json: { protocolVersion: 1, coreVersion: '0.2.36' } })
      return true
    }
    if (!route.request().url().includes('/api/cpa-quota')) return
    await route.fulfill({ json: { quotas: quota ? [{ account: 'test', remainingPercent: 75, usedPercent: 25 }] : [] } })
    return true
  })
  try {
    const { page } = fixture
    await page.locator('body > .core-version').waitFor()
    const desktopStyle = await page.locator('body > .core-version').evaluate(el => {
      const style = getComputedStyle(el)
      return Object.fromEntries(['color', 'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'padding', 'transform', 'backgroundColor'].map(key => [key, style[key]]))
    })
    for (const width of [820, 729, 586, 390]) {
      await page.setViewportSize({ width, height: 948 })
      await page.locator('.mobile-nav-menu > summary').click()
      await page.locator('.mobile-nav-menu nav').dispatchEvent('pointerdown', { pointerType: 'touch', bubbles: true, composed: true })
      assert.notEqual(await page.locator('.mobile-nav-menu').getAttribute('open'), null)
      await page.mouse.click(8, 400)
      assert.equal(await page.locator('.mobile-nav-menu').getAttribute('open'), null)
      await page.locator('.mobile-nav-menu > summary').click()
      await page.locator('.transcript').dispatchEvent('pointerdown', { pointerType: 'touch', bubbles: true, composed: true })
      assert.equal(await page.locator('.mobile-nav-menu').getAttribute('open'), null)
      await page.locator('.mobile-nav-menu > summary').click()
      const titles = await page.locator('.mobile-nav-menu nav button').allTextContents()
      assert.deepEqual(titles, ['回到对话', '新建会话', '会话管理', '全局配置', '显示控件', '切到夜间', '后台任务', ...(quota ? ['周额度'] : []), '服务端内存'])
      const menuBox = await page.locator('.mobile-nav-menu > summary').boundingBox()
      const dropdownBox = await page.locator('.mobile-nav-menu nav').boundingBox()
      assert.equal(await page.locator('.mobile-theme-toggle').count(), 0)
      assert.ok(menuBox.x < 24)
      assert.ok(dropdownBox.x >= 0 && dropdownBox.x < 24 && dropdownBox.x + dropdownBox.width <= width)
      assert.equal(await page.locator('.mobile-nav-menu nav > :last-child').innerText(), '内核版本 0.2.36')
      assert.equal(await page.locator('body > .core-version').isVisible(), false)
      assert.equal(await page.locator('.mobile-core-version').isVisible(), true)
      const styles = await page.evaluate(() => {
        const keys = ['color', 'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'padding', 'transform', 'backgroundColor']
        const read = el => Object.fromEntries(keys.map(key => [key, getComputedStyle(el)[key]]))
        return { mobile: read(document.querySelector('.mobile-core-version')), desktop: read(document.querySelector('body > .core-version')) }
      })
      // Narrow navigation intentionally uses the accent for its version entry.
      const accent = await page.evaluate(() => {
        const probe = document.createElement('span'); probe.style.color = 'var(--purple)'; document.body.append(probe)
        const color = getComputedStyle(probe).color; probe.remove(); return color
      })
      assert.equal(styles.mobile.color, accent)
      assert.deepEqual({ ...styles.mobile, color: desktopStyle.color }, desktopStyle)
      assert.equal(await page.locator('.mobile-core-version .core-version-spark').count(), 3)
      assert.ok(titles.includes('后台任务'))
      assert.ok(titles.includes('服务端内存'))
      assert.equal(titles.includes('周额度'), quota)
      await page.locator('.mobile-nav-menu > summary').click()
      for (const [id, title] of [['tasks', '后台任务'], ...(quota ? [['quota', '周额度']] : []), ['memory', '服务端内存']]) {
        await page.locator('.mobile-nav-menu > summary').click()
        await page.locator('.mobile-nav-menu nav').getByRole('button', { name: title, exact: true }).click()
        assert.equal(await page.locator('.mobile-nav-menu').getAttribute('open'), null)
        assert.equal(await page.locator(`.right-panel > [data-card="${id}"]`).isVisible(), true)
        assert.equal(await page.locator('.right-panel > section:visible').count(), 1)
        assert.equal(await page.locator('.right-panel').evaluate(el => el.scrollWidth > el.clientWidth + 1), false)
        const geometry = await page.locator('.right-panel').evaluate(el => {
          const card = [...el.querySelectorAll('section')].find(n => getComputedStyle(n).display !== 'none')
          const head = card.querySelector('.background-task-head, .quota-card-head, .memory-card-head').getBoundingClientRect()
          const close = el.querySelector('.mobile-card-close'), box = close.getBoundingClientRect()
          return { headerY:head.y+head.height/2, closeY:box.y+box.height/2, border:getComputedStyle(card).borderTopWidth, background:getComputedStyle(card).backgroundColor, closeBorder:getComputedStyle(close).borderTopWidth, height:el.getBoundingClientRect().height }
        })
        assert.ok(Math.abs(geometry.headerY-geometry.closeY)<=2)
        assert.equal(geometry.border,'0px'); assert.equal(geometry.background,'rgba(0, 0, 0, 0)'); assert.equal(geometry.closeBorder,'0px')
        if(id==='tasks')assert.ok(geometry.height<120)
        await page.getByRole('button', { name: '关闭卡片', exact: true }).click()
        assert.equal(await page.locator('.right-panel').isVisible(), false)
      }
    }
    assert.equal(await page.locator('.mobile-core-version').isVisible(), false)
    await page.setViewportSize({ width: 1440, height: 948 })
    assert.equal(await page.locator('body > .core-version').isVisible(), true)
    assert.equal(await page.locator('.right-panel > section:visible').count(), quota ? 3 : 2)
    assert.deepEqual(fixture.errors, [])
  } finally { await fixture.close() }
})
