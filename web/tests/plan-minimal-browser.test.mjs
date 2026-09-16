import test from 'node:test'
import assert from 'node:assert/strict'
import { createObservabilityBrowser, observabilitySnapshot } from './observability-browser-fixture.mjs'

test('plan has one title, count and steps without redundant labels or progress bar', async () => {
  const items = ['核对待提交变更及当前分支', '暂存并提交当前变更', '确认提交结果和工作区状态'].map(description => ({ description, status: 'completed' }))
  const f = await createObservabilityBrowser(observabilitySnapshot({ lines: [{ id: 1, kind: 'tool', toolName: 'plan_update', title: '任务计划', titleStatus: 'success', text: JSON.stringify({ title: '任务计划', items, completed: 3, total: 3, note: '不应重复展示说明' }), presentationLevel: 'primary' }] }))
  try {
    const card = f.page.locator('.plan-card')
    await card.waitFor()
    assert.equal(await card.locator('.plan-item').count(), 3)
    assert.equal(await card.locator('.plan-progress-label').innerText(), '3 / 3')
    assert.equal(await card.locator('.plan-kicker, .plan-progress-track, .plan-item-status, .plan-note').count(), 0)
    assert.equal(await card.locator('.plan-item-marker[aria-label="已完成"]').count(), 3)
    const text = await card.innerText()
    assert.doesNotMatch(text, /执行计划|已完成|说明/)
    assert.equal((text.match(/任务计划/g) || []).length, 1)
    assert.equal(await f.page.locator('.message-head').filter({ hasText: '任务计划' }).count(), 0)
    for (const item of items) assert.ok(text.includes(item.description))
    assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})
