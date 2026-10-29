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
    await page.evaluate(() => { window.__TAURI_INTERNALS__ = { invoke: async command => command.endsWith('|system_theme') ? matchMedia('(prefers-color-scheme: dark)').matches : false } })
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
    const menu = page.locator(desktop ? 'neo-window-chrome .menu' : '.sidebar-actions-menu')
    assert.deepEqual(await menu.getByRole('menuitem').allTextContents(), desktop
      ? ['回到对话', '会话管理', '全局配置', '切到夜间', '返回启动页', '检查核心与 Web 更新', '卸载 Neo Desktop']
      : ['回到对话', '新建会话', '会话管理', '全局配置', '显示控件', '切到夜间'])
    await menu.getByRole('menuitem', { name: '会话管理', exact: true }).click()
    await page.locator('.session-search').waitFor()
    await page.getByRole('button', { name: '应用菜单', exact: true }).click()
    await menu.getByRole('menuitem', { name: '回到对话', exact: true }).click()
    await page.locator('.composer textarea').waitFor()
    await page.emulateMedia({ colorScheme: 'light' })
    await page.getByRole('button', { name: '应用菜单', exact: true }).click()
    const cycle = page.locator(desktop ? 'neo-window-chrome [data-theme-cycle]' : '.sidebar-actions-menu [data-theme-cycle]')
    assert.equal(await cycle.count(), 1)
    assert.equal(await page.getByRole('menuitemradio').count(), 0)
    assert.equal(await cycle.innerText(), '切到夜间')
    await cycle.focus(); await page.keyboard.press('Enter')
    await page.waitForFunction(() => document.documentElement.dataset.appearanceMode === 'dark')
    assert.equal(await cycle.innerText(), '日夜跟随系统')
    await cycle.click()
    // No OS change after the click: entering system must immediately resolve its current value.
    await page.waitForFunction(() => document.documentElement.dataset.appearanceMode === 'system' && document.documentElement.dataset.theme === 'light')
    assert.equal(await cycle.innerText(), '切到白天')
    const savedRevision = revision
    for (const colorScheme of ['dark', 'light', 'dark']) {
      await page.emulateMedia({ colorScheme })
      await page.waitForFunction(mode => document.documentElement.dataset.theme === mode, colorScheme)
      assert.equal(await cycle.innerText(), '切到白天')
    }
    assert.equal(revision, savedRevision, 'OS changes do not write preferences')
    await page.reload(); await chrome()
    await page.waitForFunction(() => document.documentElement.dataset.appearanceMode === 'system' && document.documentElement.dataset.theme === 'dark')
    await page.getByRole('button', { name: '应用菜单', exact: true }).click()
    assert.equal(await cycle.innerText(), '切到白天')
    await cycle.click()
    await page.waitForFunction(() => document.documentElement.dataset.appearanceMode === 'light' && document.documentElement.dataset.theme === 'light')
    assert.equal(await cycle.innerText(), '切到夜间')
    await page.keyboard.press('Escape')
    await openGlobalSettings(page)
    await page.locator('[data-settings-page="appearance"]').click()
    await page.getByRole('button', { name: '设计外观', exact: true }).click()
    await page.getByLabel('外观名称', { exact: true }).fill('保留设计')
    const beforeDesignCycle = revision
    await page.getByRole('button', { name: '应用菜单', exact: true }).click()
    await cycle.click(); await page.waitForTimeout(150)
    assert.equal(config.mode, 'light'); assert.equal(revision, beforeDesignCycle)
    assert.equal(await page.getByLabel('外观名称', { exact: true }).inputValue(), '保留设计')
    await page.keyboard.press('Escape')
    await page.getByLabel('外观名称', { exact: true }).fill('')
    await page.getByRole('button', { name: '返回外观', exact: true }).click()
    await page.setViewportSize({ width: 390, height: 700 })
    await page.locator('.mobile-nav-menu > summary').click()
    const mobileCycle = page.locator('.mobile-nav-menu [data-theme-cycle]')
    assert.equal(await mobileCycle.count(), 1)
    for (const mode of ['dark', 'system', 'light']) {
      await mobileCycle.click()
      await page.waitForFunction(mode => document.documentElement.dataset.appearanceMode === mode, mode)
    }
    assert.notEqual(await page.locator('.mobile-nav-menu').getAttribute('open'), null)
    assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})
