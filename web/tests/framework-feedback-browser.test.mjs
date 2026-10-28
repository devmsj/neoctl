import { openGlobalSettings } from './settings-navigation.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import { createObservabilityBrowser, observabilitySnapshot } from './observability-browser-fixture.mjs'

test('compact bottom entry opens paginated feedback subpage, handles errors and escapes content', async () => {
  let fail = false, empty = false
  const pages = []
  const f = await createObservabilityBrowser(observabilitySnapshot(), async route => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/login') { await route.fulfill({ json: { provider: 'openai', providers: [], fields: [], values: {} } }); return true }
    if (url.pathname !== '/api/framework-feedback') return false
    const page = Number(url.searchParams.get('page')); pages.push(page)
    if (fail) await route.fulfill({ status: 500, json: { error: 'failed' } })
    else await route.fulfill({ json: { page: empty ? 1 : page, pageSize: 10, total: empty ? 0 : 11, totalPages: empty ? 1 : 2,
      items: empty ? [] : Array.from({ length: page === 1 ? 10 : 1 }, (_, i) => ({ id: `${page}-${i}`, title: page === 2 ? '<img src=x onerror=alert(1)>' : `建议${i}`, body: '问题：卡顿\n复现：切换会话\n改进：及时同步', createdAt: '2026-10-21T00:00:00Z' })) } })
    return true
  })
  try {
    await openGlobalSettings(f.page)
    const entry = f.page.locator('.settings-prompt-entry').filter({ hasText: '框架改进建议' })
    await entry.waitFor()
    assert.equal((await f.page.locator('.settings-form > :last-child').innerText()).replace(/\s/g, ''), '框架改进建议›')
    assert.equal(pages.length, 0, 'main settings page must not load submissions')
    await entry.click()
    await f.page.locator('.feedback-item').first().waitFor()
    assert.equal(await f.page.locator('.feedback-item').count(), 10)
    assert.equal(await f.page.getByRole('button', { name: '上一页', exact: true }).isDisabled(), true)
    await f.page.getByRole('button', { name: '下一页', exact: true }).click()
    await f.page.waitForFunction(() => document.querySelector('.feedback-pagination')?.textContent.includes('2 / 2'))
    assert.equal(await f.page.locator('.feedback-item').count(), 1)
    assert.equal(await f.page.locator('.feedback-item img').count(), 0)
    assert.match(await f.page.locator('.feedback-item').innerText(), /<img src=x/)
    fail = true
    await f.page.getByRole('button', { name: '刷新', exact: true }).click()
    await f.page.getByRole('alert').filter({ hasText: '加载失败' }).waitFor()
    fail = false; empty = true
    await f.page.getByRole('button', { name: '刷新', exact: true }).click()
    await f.page.getByText('暂无建议', { exact: true }).waitFor()
    await f.page.getByRole('button', { name: '返回全局配置', exact: true }).click()
    await entry.waitFor()
    assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})
