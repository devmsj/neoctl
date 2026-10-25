import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createObservabilityBrowser, observabilitySnapshot } from './observability-browser-fixture.mjs'

for (const isolation of [false, true]) test(`context chrome: icons, compaction details, themes, mobile (isolation=${isolation})`, async () => {
  const tool = { name: 'file_read', description: 'Read a local file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } }, mode: 'inherit', available: true, effectiveEnabled: true }
  const fixture = await createObservabilityBrowser(observabilitySnapshot({ lines: [
    { id: 1, kind: 'meta', text: 'compacted', compaction: { current: true, summary: '保留目标与实施记录。', continuationState: '目标：统一轻量图标与信息层级。\n\nconst next = "review";\n' + '续接内容。'.repeat(300), createdAt: new Date().toISOString(), modelDriven: true, newWindowMessages: 3, preservedUserMessages: 2, charsFreed: 24000, imageCount: 2 } }
  ] }), async route => {
    const path = new URL(route.request().url()).pathname
    const payload = path === '/api/auth/status' ? { isolation, user: isolation ? { id: 'test', role: 'user' } : null }
      : path === '/api/runtime-context' ? { protocolVersion: 2, revision: 1, prompt: { sections: [{ id: 'system' }] }, tools: [tool] }
      : path === '/api/session-prompt' ? { content: '使用中文回答。修改后运行相关测试。', revision: 'test-1', mode: 'append', effectiveContent: '系统：完成用户任务。\n工具：按实际能力使用。', override: true }
      : path === '/api/session-tools' ? { items: [tool] }
      : path === '/api/session-plugins' ? { items: [{ id: 'files', name: '文件工具', tools: ['file_read'], mode: 'inherit', globallyEnabled: true, effectiveEnabled: true }] } : null
    if (payload) { await route.fulfill({ json: payload }); return true }
  })
  try {
    const { page } = fixture
    const bar = page.locator('.runtime-context-bar').first()
    await bar.getByRole('button', { name: '工具 1', exact: true }).waitFor()
    assert.equal(await bar.getByRole('button', { name: /系统提示词/ }).count(), isolation ? 0 : 1)
    assert.deepEqual(await bar.locator('.runtime-context-bar-actions button').allTextContents(), isolation ? ['1', '1'] : ['1', '1', '1'])
    const compact = page.locator('.compaction-context-bar')
    for (const theme of ['light', 'dark']) for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 950 })
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme)
      await page.mouse.move(0, 0)
      await page.waitForTimeout(180) // let hover/colour transitions settle after resizing
      for (const el of [bar, compact]) {
        await el.scrollIntoViewIfNeeded()
        const style = await el.evaluate(el => ({ shadow: getComputedStyle(el).boxShadow, background: getComputedStyle(el).backgroundColor, border: getComputedStyle(el).borderTopWidth, overflow: el.scrollWidth > el.clientWidth + 1, height: el.getBoundingClientRect().height }))
        assert.equal(style.shadow, 'none'); assert.equal(style.background, 'rgba(0, 0, 0, 0)'); assert.equal(style.border, '0px'); assert.equal(style.overflow, false); assert.ok(style.height <= 50, JSON.stringify(style))
      }
      assert.equal(await page.locator('.message.context-compaction .message-marker').count(), 0)
      await page.screenshot({ path: join(tmpdir(), `neo-context-${isolation}-${theme}-${width}.png`) })
      await compact.click()
      const modal = page.getByRole('dialog', { name: '压缩上下文详情', exact: true })
      await modal.waitFor()
      assert.equal(await modal.getByRole('button', { name: '关闭', exact: true }).evaluate(el => el === document.activeElement), true)
      assert.ok(await modal.evaluate(el => el.scrollWidth <= el.clientWidth + 1))
      assert.equal(await modal.locator('pre').evaluate(el => getComputedStyle(el).boxShadow), 'none')
      await page.screenshot({ path: join(tmpdir(), `neo-compaction-${isolation}-${theme}-${width}.png`) })
      await page.keyboard.press('Shift+Tab')
      assert.equal(await modal.locator('pre').evaluate(el => el === document.activeElement), true)
      await page.keyboard.press('Escape')
      assert.equal(await compact.evaluate(el => el === document.activeElement), true)
    }
    await page.setViewportSize({ width: 1440, height: 1000 })
    const trigger = bar.getByRole('button', { name: '工具 1', exact: true })
    await trigger.click()
    const modal = page.getByRole('dialog', { name: '运行上下文', exact: true })
    for (const theme of ['light', 'dark']) for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 950 })
      await page.evaluate(t => document.documentElement.dataset.theme = t, theme)
      const select = modal.getByRole('button', { name: 'file_read状态' })
      await select.click()
      const menu = modal.getByRole('listbox')
      await menu.waitFor()
      const menuBox = await menu.evaluate(el => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, bottom: r.bottom, width: innerWidth, height: innerHeight } })
      assert.ok(menuBox.left >= 0 && menuBox.right <= menuBox.width && menuBox.bottom <= menuBox.height, JSON.stringify(menuBox))
      assert.equal(await menu.getByRole('option').count(), 3)
      await page.screenshot({ path: join(tmpdir(), `neo-context-select-${theme}-${width}.png`) })
      await page.keyboard.press('ArrowDown')
      await page.keyboard.press('Escape')
      assert.equal(await select.evaluate(el => el === document.activeElement), true)
    }
    await modal.locator('.runtime-tool-detail-button').click()
    const toolDetail = page.getByRole('dialog', { name: 'file_read', exact: true })
    await toolDetail.waitFor()
    assert.equal(await toolDetail.locator('.runtime-context-kicker').count(), 0)
    assert.doesNotMatch(await toolDetail.innerText(), /兼容模式/)
    await page.keyboard.press('Escape')
    assert.equal(await modal.locator('.runtime-tool-detail-button').evaluate(el => el === document.activeElement), true)
    await page.keyboard.press('Escape')
    assert.equal(await trigger.evaluate(el => el === document.activeElement), true)
    if (!isolation) {
      await bar.getByRole('button', { name: /系统提示词/ }).click()
      const editor = modal.locator('.prompt-config-editor')
      await editor.getByRole('textbox', { name: '会话指令' }).waitFor()
      assert.equal(await editor.locator('select, .neo-select').count(), 0)
      assert.equal(await editor.locator('.prompt-config-note, .prompt-source-labels').count(), 0)
      assert.equal(await editor.getByRole('textbox').getAttribute('placeholder'), null)
      assert.equal(await editor.locator('.prompt-readonly-heading').count(), 1)
      assert.equal(await editor.locator('.prompt-readonly-region textarea').count(), 0)
      assert.deepEqual(await editor.locator('.prompt-config-actions button').allTextContents(), ['', '', ''])
      for (const theme of ['light', 'dark']) for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 950 })
        await page.evaluate(t => document.documentElement.dataset.theme = t, theme)
        assert.ok(await modal.evaluate(el => el.scrollWidth <= el.clientWidth + 1))
        assert.equal(await editor.locator('textarea').evaluate(el => getComputedStyle(el).boxShadow), 'none')
        await page.screenshot({ path: join(tmpdir(), `neo-context-editor-${theme}-${width}.png`) })
      }
      await page.keyboard.press('Escape')
    }
    await page.setViewportSize({ width: 1440, height: 1000 })
    assert.equal((await page.locator('.compact-button:visible').textContent()).trim(), '')
    assert.equal(await page.locator('.compact-button:visible').getAttribute('aria-label'), '压缩会话')
    assert.deepEqual(fixture.errors, [])
    assert.ok(fixture.requests.every(r => r.method === 'GET'))
  } finally { await fixture.close() }
})
