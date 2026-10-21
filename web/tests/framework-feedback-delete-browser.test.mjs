import assert from 'node:assert/strict'
import test from 'node:test'
import { createObservabilityBrowser, observabilitySnapshot } from './observability-browser-fixture.mjs'

test('delete confirms, preserves failures, and returns from an empty final page', async () => {
  let records = Array.from({ length: 11 }, (_, i) => ({ id: String(i), title: `建议${i}`, body: '问题；复现；改进', createdAt: '2026-10-21T00:00:00Z' }))
  let fail = false, deletes = 0
  const f = await createObservabilityBrowser(observabilitySnapshot(), async route => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/login') { await route.fulfill({ json: { provider: 'openai', providers: [], fields: [], values: {} } }); return true }
    if (url.pathname === '/api/framework-feedback/delete') {
      deletes++
      if (fail) await route.fulfill({ json: { ok: false, error: 'delete failed' } })
      else { records = records.filter(x => x.id !== route.request().postDataJSON().id); await route.fulfill({ json: { ok: true, deleted: true } }) }
      return true
    }
    if (url.pathname !== '/api/framework-feedback') return false
    const totalPages = Math.max(1, Math.ceil(records.length / 10)), page = Math.min(Number(url.searchParams.get('page')), totalPages)
    await route.fulfill({ json: { items: records.slice((page - 1) * 10, page * 10), page, pageSize: 10, total: records.length, totalPages } })
    return true
  })
  try {
    await f.page.getByRole('button', { name: '模型配置', exact: true }).first().click()
    await f.page.locator('.settings-prompt-entry').filter({ hasText: '框架改进建议' }).click()
    await f.page.locator('.feedback-item').first().waitFor()
    await f.page.getByRole('button', { name: '下一页', exact: true }).click()
    await f.page.waitForFunction(() => document.querySelector('.feedback-pagination')?.textContent.includes('2 / 2'))
    await f.page.locator('.feedback-item').getByRole('button', { name: '删除', exact: true }).click()
    const dialog = f.page.getByRole('alertdialog', { name: '删除建议？' })
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    assert.equal(deletes, 0)
    fail = true
    await f.page.locator('.feedback-item').getByRole('button', { name: '删除', exact: true }).click()
    await dialog.getByRole('button', { name: '删除', exact: true }).click()
    await f.page.getByRole('alert').filter({ hasText: '删除失败' }).waitFor()
    assert.equal(await f.page.locator('.feedback-item').count(), 1, 'failed delete must retain record and retry button')
    fail = false
    await f.page.locator('.feedback-item').getByRole('button', { name: '删除', exact: true }).click()
    await dialog.getByRole('button', { name: '删除', exact: true }).click()
    await f.page.waitForFunction(() => document.querySelector('.feedback-pagination')?.textContent.includes('1 / 1'))
    assert.equal(await f.page.locator('.feedback-item').count(), 10)
    assert.equal(records.some(x => x.id === '10'), false)
    assert.equal(deletes, 2)
    assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})
