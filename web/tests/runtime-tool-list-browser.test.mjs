import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createObservabilityBrowser, observabilitySnapshot } from './observability-browser-fixture.mjs'

test('runtime tool list: unboxed names, single-border selects, spacing, long names and themes', async () => {
  const names = ['file_edit', 'file_write', 'terminal_run', 'terminal_control', 'file_list', 'file_read', 'file_search', 'web_search', 'image_inspect', 'plugin_with_an_unusually_long_name_to_check_narrow_layout']
  const tools = names.map((name, i) => ({ name, description: 'Tool details', inputSchema: { type: 'object' }, mode: 'inherit', available: i !== 9, effectiveEnabled: i !== 9, source: i === 9 ? 'plugin' : 'builtin', pluginName: i === 9 ? '测试插件' : undefined }))
  const fixture = await createObservabilityBrowser(observabilitySnapshot(), async route => {
    const path = new URL(route.request().url()).pathname
    const payload = path === '/api/runtime-context' ? { protocolVersion: 2, revision: 1, prompt: { sections: [] }, tools: tools.slice(0,9) }
      : path === '/api/session-tools' ? { items: tools } : null
    if (payload) { await route.fulfill({ json: payload }); return true }
  })
  try {
    const { page } = fixture
    await page.getByRole('button', { name: '工具 9', exact: true }).click()
    const modal = page.getByRole('dialog', { name: '运行上下文', exact: true })
    await modal.locator('.runtime-tool-detail-button').last().waitFor()
    for (const theme of ['dark', 'light']) for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 950 })
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme)
      await page.mouse.move(0, 0)
      await page.waitForTimeout(200)
      const rows = await modal.locator('.runtime-plugin-row').evaluateAll(els => els.map(el => {
        const button = el.querySelector('.runtime-tool-detail-button'), select = el.querySelector('.neo-select'), trigger = select.querySelector('button')
        const b = getComputedStyle(button), s = getComputedStyle(select), t = getComputedStyle(trigger)
        const r = el.getBoundingClientRect(), br = button.getBoundingClientRect(), sr = select.getBoundingClientRect()
        return { border: b.borderTopWidth, background: b.backgroundColor, padding: parseFloat(b.paddingLeft), shadow: b.boxShadow, selectBorder: s.borderTopWidth, selectColor: s.borderTopColor, expectedColor: s.getPropertyValue('--chrome-line-soft').trim(), triggerBorder: t.borderTopWidth, triggerShadow: t.boxShadow, gap: sr.left - br.right, aligned: Math.abs((br.top + br.bottom - sr.top - sr.bottom) / 2) < 1, inside: br.left >= r.left && sr.right <= r.right + 1, overflow: el.scrollWidth > el.clientWidth + 1 }
      }))
      for (const row of rows) {
        assert.equal(row.border, '0px'); assert.equal(row.background, 'rgba(0, 0, 0, 0)'); assert.ok(row.padding >= 8)
        assert.equal(row.shadow, 'none'); assert.equal(row.selectBorder, '1px'); assert.equal(row.triggerBorder, '0px'); assert.equal(row.triggerShadow, 'none')
        assert.ok(row.gap >= 16); assert.ok(row.aligned); assert.ok(row.inside); assert.equal(row.overflow, false)
      }
      assert.ok(await modal.evaluate(el => el.scrollWidth <= el.clientWidth + 1))
      assert.doesNotMatch(await modal.innerText(), /·/)
      await modal.locator('.runtime-context-modal-content').evaluate(el => el.scrollTop = 0)
      await page.screenshot({ path: join(tmpdir(), `neo-runtime-tools-${theme}-${width}.png`) })
      const trigger = modal.getByRole('button', { name: 'file_edit状态', exact: true })
      await trigger.click()
      const options = modal.getByRole('listbox')
      assert.equal(await options.getByRole('option').count(), 3)
      assert.ok((await options.getByRole('option').evaluateAll(els => els.every(el => getComputedStyle(el).borderTopWidth === '0px'))))
      await page.keyboard.press('Escape')
      assert.ok(await trigger.evaluate(el => document.activeElement === el))
    }
    assert.ok(await modal.locator('.runtime-tool-detail-button').last().isDisabled())
    assert.deepEqual(fixture.errors, [])
    assert.ok(fixture.requests.every(r => r.method === 'GET'))
  } finally { await fixture.close() }
})
