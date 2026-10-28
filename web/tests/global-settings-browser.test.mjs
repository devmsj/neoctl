import { openGlobalSettings } from './settings-navigation.mjs'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createObservabilityBrowser, observabilitySnapshot } from './observability-browser-fixture.mjs'

test('global settings: scoped saves, draft preservation, aligned icon controls, themes and mobile', async () => {
  const writes = []
  let tools = ['file_read', 'terminal_run', 'file_write', 'web_search'].map(name => ({ name, configuredEnabled: true, source: 'builtin' }))
  let plugins = ['下载', '视频播放', '较长名称的测试插件', '小红书编辑器'].map((name, i) => ({ id: 'p' + i, name, tools: ['one'], configuredEnabled: true }))
  let failCpa = false
  const fixture = await createObservabilityBrowser(observabilitySnapshot(), async route => {
    const req = route.request(), url = new URL(req.url()), post = req.method() === 'POST'
    const data = post ? req.postDataJSON() : null
    if (post) writes.push({ path: url.pathname, data })
    let payload
    if (url.pathname === '/api/login') payload = post ? { ok: true } : { provider: url.searchParams.get('provider') || 'openai', providers: ['openai', 'anthropic'], fields: [{ key: 'model', label: 'Model' }], values: { model: 'test-model' } }
    if (url.pathname === '/api/cpa-quota') payload = { config: { url: 'http://localhost:8317', hasPassword: true }, quotas: [] }
    if (url.pathname === '/api/cpa-config') {
      if (failCpa) { await route.fulfill({ status: 500, json: { error: 'test failure' } }); return true }
      payload = { config: { hasPassword: true }, quotas: [] }
    }
    if (url.pathname === '/api/tools') payload = { items: tools }
    if (url.pathname === '/api/tools/global') { tools = tools.map(t => ({ ...t, configuredEnabled: data.overrides[t.name] })); payload = { state: { items: tools } } }
    if (url.pathname === '/api/plugins') payload = { items: plugins, installationSupported: true, locked: false }
    if (url.pathname === '/api/plugins/global') { plugins = plugins.map(p => ({ ...p, configuredEnabled: data.enabledIds.includes(p.id) })); payload = { enabledIds: data.enabledIds } }
    if (url.pathname === '/api/plugins/uninstall') { plugins = plugins.filter(p => p.id !== data.id); payload = { ok: true } }
    if (url.pathname === '/api/prompt-config') payload = { content: 'Test prompt', revision: 'test-revision' }
    if (payload) { await route.fulfill({ json: payload }); return true }
  })
  try {
    const { page } = fixture
    await openGlobalSettings(page)
    const root = page.locator('.settings-page'), model = root.locator('.settings-model-card'), cpa = root.locator('.settings-cpa-card'), tool = root.locator('.settings-tools-card'), plugin = root.locator('.settings-plugins-card')
    async function visit(name) {
      const back = root.getByRole('button', { name: '返回全局配置', exact: true })
      if (await back.count()) await back.click()
      await root.getByRole('button', { name, exact: true }).click()
      assert.equal(await root.locator('h2').innerText(), name)
      assert.equal(await root.locator('form').count(), 1)
    }
    await root.getByRole('button', { name: '模型', exact: true }).waitFor()
    assert.equal(await root.locator('form').count(), 0)
    assert.equal(await root.locator('.settings-prompt-entry').count(), 7)
    assert.equal(await root.locator('.page-head button').count(), 0)
    assert.equal(await root.getByRole('button', { name: '安装可信插件' }).count(), 0)
    assert.ok(!(await root.innerText()).includes('内置与插件工具默认开启'))
    assert.equal(await root.locator('form form').count(), 0)
    await visit('工具')
    await tool.getByRole('checkbox').first().uncheck()
    await visit('插件')
    await plugin.getByRole('checkbox').first().uncheck()
    await visit('CPA')
    await cpa.getByRole('textbox', { name: 'URL', exact: true }).fill('http://example.test:8317')
    // A provider switch must not reload the other persistence scopes.
    await visit('模型')
    await model.getByRole('button', { name: '供应商' }).click()
    await model.getByRole('option', { name: /Anthropic/i }).click()
    await page.waitForFunction(() => !document.querySelector('.settings-model-card .settings-save-button')?.disabled)
    assert.equal(await root.locator('h2').innerText(), '模型')
    await visit('工具')
    assert.equal(await tool.getByRole('checkbox').first().isChecked(), false)
    await visit('插件')
    assert.equal(await plugin.getByRole('checkbox').first().isChecked(), false)
    await visit('CPA')
    assert.equal(await cpa.getByRole('textbox', { name: 'URL', exact: true }).inputValue(), 'http://example.test:8317')
    await visit('模型')
    await model.getByRole('textbox').fill('new-model')
    await model.getByRole('textbox').press('Enter')
    await page.waitForFunction(() => document.querySelector('.toast')?.textContent === '模型配置已保存')
    assert.deepEqual(writes.map(w => w.path), ['/api/login'])
    await visit('CPA')
    await cpa.getByRole('textbox', { name: 'URL', exact: true }).press('Enter')
    await page.waitForFunction(() => document.querySelector('.toast')?.textContent === 'CPA 配置已保存')
    assert.equal(writes.at(-1).path, '/api/cpa-config')
    assert.equal(writes.at(-1).data.preservePassword, true)
    assert.equal(writes.at(-1).data.password, '')
    failCpa = true
    await cpa.getByRole('textbox', { name: 'URL', exact: true }).fill('http://draft.test')
    await cpa.getByRole('button', { name: '保存 CPA 配置', exact: true }).click()
    await page.waitForFunction(() => !document.querySelector('.settings-cpa-card .settings-save-button')?.disabled)
    assert.equal(await cpa.getByRole('textbox', { name: 'URL', exact: true }).inputValue(), 'http://draft.test')
    await visit('工具')
    await tool.getByRole('button', { name: '保存全局工具', exact: true }).click()
    await page.waitForFunction(() => !document.querySelector('.settings-tools-card .settings-save-button')?.disabled)
    assert.equal(writes.at(-1).path, '/api/tools/global')
    assert.equal(writes.at(-1).data.overrides.file_read, false)
    await visit('插件')
    await plugin.getByRole('button', { name: '保存全局插件', exact: true }).click()
    await page.waitForFunction(() => !document.querySelector('.settings-plugins-card .settings-save-button')?.disabled)
    assert.equal(writes.at(-1).path, '/api/plugins/global')
    assert.ok(!writes.at(-1).data.enabledIds.includes('p0'))
    for (const theme of ['light', 'dark']) for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 })
      await page.evaluate(t => document.documentElement.dataset.theme = t, theme)
      await page.mouse.move(0, 0)
      await page.waitForTimeout(200)
      await root.getByRole('button', { name: '返回全局配置', exact: true }).click()
      for (const entry of await root.locator('.settings-prompt-entry').all()) {
        const spacing = await entry.evaluate(el => { const r = el.getBoundingClientRect(), a = el.querySelector('strong').getBoundingClientRect(), b = el.querySelector('span').getBoundingClientRect(); return { left: a.left - r.left, right: r.right - b.right } })
        assert.ok(spacing.left >= 14 && spacing.right >= 14, JSON.stringify(spacing))
      }
      const buttons = []
      for (const name of ['模型', 'CPA', '工具', '插件']) {
        await visit(name)
        buttons.push(await root.locator('.settings-save-button').evaluate(el => { const s = getComputedStyle(el); return [el.textContent.trim(), s.width, s.height, s.borderRadius, s.boxShadow, s.backgroundColor] }))
        assert.ok(await root.evaluate(el => el.scrollWidth <= el.clientWidth + 1))
      }
      assert.equal(buttons.length, 4)
      assert.ok(buttons.every(b => b[0] === '' && JSON.stringify(b) === JSON.stringify(buttons[0])))
      const rows = await plugin.locator('.plugin-settings-row').evaluateAll(els => els.map(el => { const a = el.querySelector('.plugin-toggle').getBoundingClientRect(), b = el.querySelector('.plugin-uninstall').getBoundingClientRect(); return { toggleX: a.x, deleteX: b.x, gap: b.x - a.right, dy: Math.abs(a.y + a.height / 2 - b.y - b.height / 2) } }))
      assert.ok(rows.every(r => r.gap >= 0 && r.gap <= 12 && r.dy < 1), JSON.stringify(rows))
      assert.equal(rows[0].toggleX, rows[width === 1440 ? 2 : 1].toggleX)
      assert.equal(rows[0].deleteX, rows[width === 1440 ? 2 : 1].deleteX)
      assert.ok(await root.evaluate(el => el.scrollWidth <= el.clientWidth + 1))
      await plugin.scrollIntoViewIfNeeded()
      await page.screenshot({ path: join(tmpdir(), `neo-global-settings-${theme}-${width}.png`) })
    }
    page.once('dialog', dialog => dialog.dismiss())
    await plugin.getByRole('button', { name: '卸载 下载', exact: true }).click()
    assert.equal(writes.filter(w => w.path === '/api/plugins/uninstall').length, 0)
    page.once('dialog', dialog => dialog.accept())
    await plugin.getByRole('button', { name: '卸载 下载', exact: true }).click()
    await page.waitForFunction(() => document.querySelectorAll('.settings-plugins-card .plugin-settings-row').length === 3)
    assert.equal(writes.at(-1).path, '/api/plugins/uninstall')
    assert.deepEqual(writes.at(-1).data, { id: 'p0' })
    await root.getByRole('button', { name: '返回全局配置', exact: true }).click()
    await root.getByRole('button', { name: '提示词', exact: true }).click()
    await root.getByRole('textbox').waitFor()
    assert.equal(await root.locator('.settings-save-button').count(), 1)
    assert.equal(await root.getByRole('button', { name: '返回全局配置' }).count(), 1)
    assert.deepEqual(fixture.errors, [])
  } finally { await fixture.close() }
})
