import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createObservabilityBrowser, observabilitySnapshot } from './observability-browser-fixture.mjs'

for (const quota of [false, true]) test(`control visibility releases columns and preserves drafts (quota=${quota})`, async () => {
  const f = await createObservabilityBrowser(observabilitySnapshot(), async route => {
    if (!route.request().url().includes('/api/cpa-quota')) return
    await route.fulfill({ json: { quotas: quota ? [{ account: 'test', remainingPercent: 75, usedPercent: 25 }] : [] } }); return true
  })
  const { page } = f
  async function open() {
    await page.locator('.sidebar-actions-trigger:visible').click()
    await page.getByRole('menuitem', { name: '显示控件', exact: true }).click()
  }
  async function toggle(name) { await page.getByRole('checkbox', { name, exact: true }).click() }
  async function close() { await page.getByRole('button', { name: '关闭显示控件' }).click() }
  const box = selector => page.locator(selector).boundingBox()
  try {
    await page.locator('.composer textarea').waitFor()
    await page.locator('.composer textarea').fill('保留草稿\n第二行')
    const initial = await box('.chat-panel')
    const initialTranscript = await box('.transcript')
    await open()
    assert.equal(await page.getByRole('checkbox').count(), 5)
    await toggle('后台任务'); await toggle('内存')
    if (quota) {
      assert.equal(await page.locator('.right-panel').isVisible(), true)
      await toggle('额度')
    }
    await close()
    assert.equal(await page.locator('.right-panel').isVisible(), false)
    assert.ok((await box('.chat-panel')).width > initial.width + 100)
    assert.equal(await page.locator('.chat-grid').evaluate(el => getComputedStyle(el).columnGap), '0px')
    await open(); await toggle('会话列表'); await toggle('输入框'); await close()
    assert.equal(await page.locator('.sidebar').isVisible(), false)
    assert.equal(await page.locator('.composer').isVisible(), false)
    assert.ok((await box('.transcript')).height > initialTranscript.height + 100)
    assert.ok((await box('.workspace')).x < 2)
    assert.ok((await box('.chat-panel')).width > initial.width + 250)
    assert.equal(await page.locator('.composer textarea').inputValue(), '保留草稿\n第二行')
    await open(); await toggle('输入框'); await close()
    assert.equal(await page.locator('.composer textarea').inputValue(), '保留草稿\n第二行')
    await page.reload(); await page.locator('.shell').waitFor()
    assert.equal(await page.locator('.sidebar').isVisible(), false)
    assert.equal(await page.locator('.right-panel').isVisible(), false)
    for (const width of [390, 520, 820, 1180, 1440]) {
      await page.setViewportSize({ width, height: 760 })
      if (width <= 820) {
        await page.locator('.mobile-nav-menu > summary').click()
        assert.equal(await page.locator('.mobile-nav-menu nav').getByRole('button', { name: '后台任务', exact: true }).count(), 0)
        await page.locator('.mobile-nav-menu nav').getByRole('button', { name: '显示控件' }).click()
      } else await open()
      const p = await box('.control-visibility-panel')
      assert.ok(p.x >= 0 && p.x + p.width <= width)
      await close()
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    }
    await open(); await page.getByRole('button', { name: '全部显示', exact: true }).click(); await close()
    assert.equal(await page.locator('.sidebar').isVisible(), true)
    assert.equal(await page.locator('.right-panel').isVisible(), true)
    assert.equal(await page.locator('.composer').isVisible(), true)
    assert.deepEqual(f.errors, [])
    assert.equal(f.requests.some(r => r.method === 'POST'), false)
  } finally { await f.close() }
})

test('invalid preferences and cross-tab changes are safely normalized', async () => {
  const f = await createObservabilityBrowser(observabilitySnapshot())
  try {
    const { page } = f
    await page.locator('.composer').waitFor()
    await page.evaluate(() => localStorage.setItem('neoctl-web.controls.v1', '{invalid'))
    await page.reload(); await page.locator('.composer').waitFor()
    assert.equal(await page.locator('.sidebar').isVisible(), true)
    await page.evaluate(() => {
      localStorage.setItem('neoctl-web.controls.v1', JSON.stringify({ sessions: false, composer: 'false', unknown: false }))
      dispatchEvent(new StorageEvent('storage', { key: 'neoctl-web.controls.v1' }))
    })
    await page.locator('.sidebar').waitFor({ state: 'hidden' })
    assert.equal(await page.locator('.composer').isVisible(), true)
    await page.evaluate(() => { localStorage.removeItem('neoctl-web.controls.v1'); dispatchEvent(new StorageEvent('storage', { key: null })) })
    await page.locator('.sidebar').waitFor({ state: 'visible' })
    assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})

test('desktop layout control precedes settings and survives hidden columns', async () => {
  const f = await createObservabilityBrowser(observabilitySnapshot())
  const { page } = f
  try {
    await page.locator('.composer').waitFor()
    await page.evaluate(() => { window.__TAURI_INTERNALS__ = { invoke: async () => false } })
    await page.addScriptTag({ path: fileURLToPath(new URL('../../desktop/ui/window-chrome.js', import.meta.url)) })
    const layout = page.locator('neo-window-chrome [data-controls-action]')
    const gear = page.locator('neo-window-chrome [data-settings-action]')
    assert.ok((await layout.boundingBox()).x < (await gear.boundingBox()).x)
    await layout.click()
    await page.getByRole('checkbox', { name: '会话列表' }).click()
    await page.getByRole('button', { name: '关闭显示控件' }).click()
    await layout.click()
    assert.equal(await page.getByRole('checkbox', { name: '会话列表' }).getAttribute('aria-checked'), 'false')
    await page.keyboard.press('Escape')
    assert.equal(await page.getByRole('dialog', { name: '显示控件' }).count(), 0)
    assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})
