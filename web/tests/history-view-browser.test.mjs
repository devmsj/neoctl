// Run after npm run build. Read-only App regression; no model or tool execution.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createObservabilityBrowser, observabilitySnapshot } from './observability-browser-fixture.mjs'

for (const mode of [
  { name: 'non-isolated', isolation: false, user: null },
  { name: 'isolated user', isolation: true, user: { username: 'history-user', role: 'user' } },
  { name: 'isolated admin', isolation: true, user: { username: 'history-admin', role: 'admin' } },
]) {
  test(`${mode.name}: fixed rows ignores preferences and exposes no view modifier`, async () => {
    const snapshot = observabilitySnapshot({
      lines: [{ id: 'read', kind: 'tool', toolName: 'file_read', toolUseId: 'read-call', live: false,
        activity: { phase: 'completed', input: { path: 'example.txt' } }, observation: { content: 'example' } }],
    })
    const fixture = await createObservabilityBrowser(snapshot, async route => {
      const path = new URL(route.request().url()).pathname
      if (path === '/api/auth/status') {
        await route.fulfill({ json: { isolation: mode.isolation, user: mode.user } })
        return true
      }
      if (path === '/api/login') {
        await route.fulfill({ json: { provider: 'openai', providers: ['openai'], fields: [], values: {} } })
        return true
      }
    })
    try {
      const { page } = fixture
      for (const preference of [null, 'folded', 'rows', 'invalid']) {
        if (preference !== null) {
          await page.evaluate(value => localStorage.setItem('neo-tool-history-view', value), preference)
          await page.reload()
        }
        await page.locator('.rows-transcript .tool-activity-row').waitFor()
        assert.equal(await page.locator('.rows-history').count(), 1)
        assert.equal(await page.locator('.history-view-setting').count(), 0)
        assert.equal(await page.evaluate(() => localStorage.getItem('neo-tool-history-view')), preference)
      }
      if (!mode.isolation || mode.user.role === 'admin') {
        await page.locator('.sidebar .nav button').filter({ hasText: '模型配置' }).click()
        await page.locator('.settings-form').waitFor()
        for (const width of [1440, 390]) {
          await page.setViewportSize({ width, height: 1000 })
          assert.equal(await page.locator('.history-view-setting').count(), 0)
          assert.equal(await page.getByText('历史展示', { exact: true }).count(), 0)
          assert.equal(await page.getByText('折叠视图', { exact: true }).count(), 0)
        }
      }
      assert.deepEqual(fixture.errors, [])
    } finally {
      await fixture.close()
    }
  })
}
