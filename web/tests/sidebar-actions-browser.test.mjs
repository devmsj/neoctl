import { openGlobalSettings } from './settings-navigation.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createObservabilityBrowser, observabilitySnapshot } from './observability-browser-fixture.mjs'
import { emptyAppearance } from '../shared/appearance.mjs'

for (const desktop of [false, true]) test(`sidebar footer reserves its own track and theme persists (desktop=${desktop})`, async () => {
  let config = emptyAppearance(), revision = 0
  config.mode = 'light'
  const f = await createObservabilityBrowser(observabilitySnapshot(), async route => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/appearance') {
      if (route.request().method() === 'PUT') { config = route.request().postDataJSON().config; revision++ }
      await route.fulfill({ json: { config, revision: String(revision) } }); return true
    }
    if (url.pathname === '/api/sessions') {
      const page = Number(url.searchParams.get('page') || 1), size = Number(url.searchParams.get('pageSize') || 10)
      await route.fulfill({ json: { sessions: Array.from({ length: size }, (_, i) => ({ sessionId: `s${(page-1)*size+i}`, title: `会话 ${(page-1)*size+i}`, updatedAt: new Date().toISOString() })), page, total: 100, totalPages: Math.ceil(100/size) } }); return true
    }
    return false
  }, { viewport: { width: 974, height: 677 } })
  const { page } = f
  async function chrome() {
    if (!desktop) return
    await page.evaluate(() => { window.__TAURI_INTERNALS__ = { invoke: async () => false } })
    await page.addScriptTag({ path: fileURLToPath(new URL('../../desktop/ui/window-chrome.js', import.meta.url)) })
  }
  try {
    await chrome()
    await page.locator('.quick-session').first().waitFor()
    assert.equal(await page.locator('.brand-row, .celestial-theme-toggle').count(), 0)
    for (const [width, height] of [[974,677],[1180,760],[860,420],[821,560]]) {
      await page.setViewportSize({ width, height })
      const bounds = await page.evaluate(() => {
        const list = document.querySelector('.quick-scroll').getBoundingClientRect(), footer = document.querySelector('.sidebar-footer').getBoundingClientRect(), nav = document.querySelector('.quick-head').getBoundingClientRect()
        return { listBottom: list.bottom, footerTop: footer.top, navTop: nav.top, mask: getComputedStyle(document.querySelector('.quick-scroll')).maskImage }
      })
      assert.ok(bounds.listBottom <= bounds.footerTop, JSON.stringify(bounds))
      assert.ok(bounds.navTop <= (desktop ? 36 : 0) + 14)
      assert.notEqual(bounds.mask, 'none')
      const actions = await page.locator('.quick-head').evaluate(el => {
        const head = el.getBoundingClientRect()
        const buttons = [...el.querySelectorAll('button')].map(button => {
          const rect = button.getBoundingClientRect()
          return { left: rect.left, right: rect.right, text: button.textContent.trim(), label: button.getAttribute('aria-label') }
        })
        return { left: head.left, right: head.right, headingRight: head.left, buttons }
      })
      assert.deepEqual(actions.buttons.map(b => b.label), ['搜索最近会话', '会话管理', '新建会话'])
      assert.ok(actions.buttons.every(b => !b.text && b.left >= actions.headingRight && b.right <= actions.right), JSON.stringify(actions))
      if (desktop) {
        const app = await page.locator('neo-window-chrome .app').boundingBox()
        assert.ok(bounds.listBottom < app.y)
      }
      await page.locator('.quick-scroll').evaluate(el => { el.scrollTop = el.scrollHeight })
    }
    await page.setViewportSize({ width: 974, height: 677 })
    assert.equal(await page.locator('.sidebar-top').count(), 0)
    if (desktop) {
      const geometry = await page.evaluate(() => {
        const s = document.querySelector('neo-window-chrome').shadowRoot
        return { gear: s.querySelector('[data-settings-action]').getBoundingClientRect().right, min: s.querySelector('[data-window=minimize]').getBoundingClientRect().left, drag: s.querySelector('.drag').getBoundingClientRect().right }
      })
      assert.ok(geometry.gear <= geometry.min && geometry.drag <= geometry.gear - 32)
    }
    await openGlobalSettings(page)
    await page.locator('.settings-page').waitFor()
    if (!desktop) assert.equal(await page.locator('.sidebar-actions-menu').count(), 0)
    await page.getByRole('button', { name: '应用菜单', exact: true }).click()
    await page.getByRole('menuitem', { name: '切换到夜间', exact: true }).click()
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark')
    assert.equal(config.mode, 'dark')
    await page.reload(); await chrome()
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark')
    await page.getByRole('button', { name: '应用菜单', exact: true }).click()
    await page.getByRole('menuitem', { name: '切换到白天', exact: true }).click()
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light')
    await page.setViewportSize({ width: 390, height: 700 })
    await page.locator('.mobile-nav-menu > summary').click()
    await page.locator('.mobile-nav-menu').getByRole('button', { name: '切换到夜间', exact: true }).click()
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark')
    assert.equal(await page.locator('.mobile-nav-menu').getAttribute('open'), null)
    assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})
