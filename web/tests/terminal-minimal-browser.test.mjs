import test from 'node:test'
import assert from 'node:assert/strict'
import { createObservabilityBrowser, observabilitySnapshot } from './observability-browser-fixture.mjs'

test('terminal automatically loads every page, no action buttons, no empty stderr, raw text', async () => {
  const text = 'password=example-value\n' + '原文\n'.repeat(24000)
  const bytes = Buffer.from(text)
  const task = { kind: 'terminal', sessionId: 'run-1', ownerSessionId: 'obs-session', description: '查看输出', status: 'exited', command: 'example', createdAt: '2026-09-07T00:00:00Z' }
  const f = await createObservabilityBrowser(observabilitySnapshot({ terminalTaskHistory: [task] }), async route => {
    const u = new URL(route.request().url())
    if (u.pathname !== '/api/terminal-output') return false
    const stream = u.searchParams.get('stream'), offset = Number(u.searchParams.get('offset'))
    const source = stream === 'stdout' ? bytes : Buffer.alloc(0)
    let end = Math.min(source.length, offset + 6000)
    while (end < source.length && (source[end] & 0xc0) === 0x80) end--
    await route.fulfill({ json: { sessionId: 'obs-session', runId: task.sessionId, stream, offset, nextOffset: end, text: source.subarray(offset, end).toString(), endOfStoredOutput: end === source.length,
      record: { lifecycle: 'terminal', availability: 'available', expiresAt: null, streams: { stdout: { storedBytes: bytes.length }, stderr: { storedBytes: 0 } } } } })
    return true
  })
  try {
    const { page } = f
    await page.locator('.background-task-history > summary').click()
    await page.locator('.background-task-history-item').first().click()
    await page.waitForFunction(length => document.querySelector('.terminal-output-reader pre')?.textContent.length === length, text.length)
    assert.equal(await page.locator('.terminal-output-reader pre').count(), 1)
    assert.equal(await page.locator('.terminal-output-reader button').count(), 0)
    assert.equal(await page.locator('.terminal-output-reader pre').textContent(), text)
    assert.ok(!await page.locator('.background-task-modal').getByText('输出已过期').count())
    assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})
