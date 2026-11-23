import test from 'node:test'
import assert from 'node:assert/strict'
import { createObservabilityBrowser, observabilitySnapshot } from './observability-browser-fixture.mjs'

test('right panel is its own component: quota rotation, memory hover and task details still work', async () => {
  const now = new Date().toISOString()
  const task = { kind: 'agent', taskId: 'task_rp', agentId: 'agent_rp', description: 'Right panel task', status: 'running', createdAt: now, progress: {} }
  const done = { ...task, taskId: 'task_done', agentId: 'agent_done', description: 'Finished task', status: 'completed', completedAt: now }
  const snapshot = observabilitySnapshot({ backgroundTasks: [task], backgroundTaskCount: 1, agentTaskHistory: [done] })
  const f = await createObservabilityBrowser(snapshot, async route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/cpa-quota') { await route.fulfill({ json: { quotas: [{ account: 'alpha@example.com', remainingPercent: 80, resetAt: now }, { account: 'beta@example.com', remainingPercent: 35, resetAt: now }], config: { url: '', hasPassword: false } } }); return true }
    if (path === '/api/memory') { await route.fulfill({ json: { current: { at: now, rss: 209715200 }, history: [{ at: '2026-01-01T00:00:00Z', rss: 104857600 }, { at: '2026-01-01T00:01:00Z', rss: 157286400 }, { at: '2026-01-01T00:02:00Z', rss: 209715200 }], sampleMs: 60000 } }); return true }
    return false
  })
  try {
    const p = f.page, panel = p.locator('.right-panel')
    await panel.locator('.quota-card-controls').waitFor()
    // Quota rotation is emitted to App, which owns the index.
    const progress = panel.locator('.quota-progress')
    assert.equal(await progress.getAttribute('aria-valuenow'), '80')
    assert.equal(await panel.locator('.quota-card-controls small').innerText(), '1/2')
    await panel.getByRole('button', { name: '下一个凭据' }).click()
    assert.equal(await progress.getAttribute('aria-valuenow'), '35')
    assert.equal(await panel.locator('.quota-card-controls small').innerText(), '2/2')
    await panel.getByRole('button', { name: '上一个凭据' }).click()
    assert.equal(await panel.locator('.quota-card-controls small').innerText(), '1/2')
    // Memory hover is local state of the panel.
    assert.equal(await panel.locator('.memory-card-head strong').innerText(), '200 MB')
    const chart = panel.locator('.memory-chart'), box = await chart.boundingBox()
    await p.mouse.move(box.x + box.width - 2, box.y + box.height / 2)
    await panel.locator('.memory-tooltip').waitFor()
    assert.match(await panel.locator('.memory-tooltip strong').innerText(), /200 MB/)
    await p.mouse.move(box.x + 2, box.y + box.height / 2)
    assert.match(await panel.locator('.memory-tooltip strong').innerText(), /100 MB/)
    await p.mouse.move(0, 0); await panel.locator('.memory-tooltip').waitFor({ state: 'detached' })
    // Task entries resolve back to the live task object by key.
    await panel.locator('.background-task-summary').first().click()
    await p.locator('.background-task-detail').waitFor()
    assert.match(await p.locator('.background-task-detail').innerText(), /Right panel task/)
    await p.keyboard.press('Escape'); await p.locator('.background-task-detail').waitFor({ state: 'detached' })
    await panel.locator('summary').filter({ hasText: '最近结束' }).click()
    await panel.locator('.background-task-history-item').first().click()
    await p.locator('.background-task-detail').waitFor()
    assert.match(await p.locator('.background-task-detail').innerText(), /Finished task/)
    assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})
