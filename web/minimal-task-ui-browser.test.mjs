import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createObservabilityBrowser, observabilitySnapshot } from './observability-browser-fixture.mjs'
const part = text => ({ state: 'complete', text, reason: 'INTERNAL_PROTOCOL_TEXT', offset: 0, totalChars: text.length, hasMore: false })

test('minimal task card: report, parent messages, full width, no explanatory text; red cross only on failed tool, never group header', async () => {
  const task = { kind: 'agent', taskId: 'minimal-task', agentId: 'minimal-agent', description: '整理项目文档', status: 'completed', runGeneration: 1,
    createdAt: '2026-09-07T00:00:00Z', startedAt: '2026-09-07T00:00:00Z', completedAt: '2026-09-07T00:00:10Z', durationMs: 10000,
    progress: { totalToolUseCount: 80, currentAction: 'TECHNICAL_NOISE' }, pendingMessageCount: 1 }
  const lines = [1, 2].map(id => ({ id, kind: id === 1 ? 'error' : 'tool', toolName: 'file_read', toolUseId: `call-${id}`, messageId: `m-${id}`, titleStatus: id === 1 ? 'failure' : 'success', text: 'file content', toolDisplay: { purpose: '读取项目文档', facts: [], previews: [] } }))
  const fixture = await createObservabilityBrowser(observabilitySnapshot({ lines, agentTaskHistory: [task] }), async route => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/agent-content') {
      const base = { ownerSessionId: 'obs-session', taskId: task.taskId, runGeneration: 1, state: 'complete', reason: 'INTERNAL_PROTOCOL_TEXT', snapshotId: 'minimal-snapshot' }
      const view = url.searchParams.get('view')
      if (view === 'delegation') await route.fulfill({ json: { ...base, delegation: { scope: 'task', prompt: part('整理项目文档') } } })
      else if (view === 'report') await route.fulfill({ json: { ...base, report: { source: 'task.result', taskStatus: 'completed', reportStatus: 'completed', content: part('# 已完成\n\n文档已整理，测试通过。\n\n- 修正启动命令\n- 补齐使用示例'), error: { state: 'missing', text: '', reason: 'INTERNAL_PROTOCOL_TEXT' } } } })
      else if (view === 'messages') await route.fulfill({ json: { ...base, messages: { content: part(JSON.stringify([{ id: 'msg1', text: '请保留原有目录结构。', status: 'delivered' }, { id: 'msg2', text: '再检查一次示例命令。', status: 'queued' }])) } } })
      else throw Error('Compact card must not fetch process')
      return true
    }
    if (url.pathname === '/api/tool-call-detail') {
      await route.fulfill({ json: { sessionId: 'obs-session', toolUseId: url.searchParams.get('toolUseId'), messageId: url.searchParams.get('messageId'), toolName: 'file_read', input: part('{"path":"README.md"}'), result: part(''), error: part('Permission denied') } }); return true
    }
  })
  try {
    const { page } = fixture
    await page.locator('.tool-group-trigger').first().waitFor()
    assert.equal(await page.locator('.tool-group-trigger .tool-result-failure-mark').count(), 0)
    await page.locator('.tool-group-trigger').first().click()
    assert.equal(await page.locator('.tool-result-title-row .image2-detail-button').count(), 0)
    assert.equal(await page.locator('.tool-title-trigger').count(), 0)
    assert.equal(await page.locator('.tool-result-title-row .tool-result-failure-mark').count(), 1)
    await page.locator('.tool-result-name').first().click()
    assert.equal(await page.locator('.tool-result-modal').count(), 0)
    assert.ok(!fixture.requests.some(r => r.url.includes('/api/tool-call-detail')))
    // Open the existing background task entry, not component internals.
    await page.locator('.background-task-history > summary').click()
    await page.locator('.background-task-history-item').first().click()
    await page.locator('.agent-parent-message h1').waitFor()
    assert.equal(await page.locator('.agent-reader-tabs button').count(), 0)
    const body = await page.locator('.background-task-modal').innerText()
    for (const noise of ['只读', '脱敏', '快照', '字符', 'INTERNAL_PROTOCOL_TEXT', 'TECHNICAL_NOISE', 'PID', '辅助']) assert.ok(!body.includes(noise), noise)
    const widths = await page.locator('.agent-parent-message .markdown').last().evaluate(el => ({ content: el.getBoundingClientRect().width, reader: el.closest('.agent-content-reader').getBoundingClientRect().width }))
    assert.ok(widths.content >= widths.reader * .95)
    await page.screenshot({ path: join(tmpdir(), 'neo-minimal-report.png') })
    await page.getByText('请保留原有目录结构。', { exact: true }).waitFor()
    await page.getByText('再检查一次示例命令。', { exact: true }).waitFor()
    assert.doesNotMatch(await page.locator('.agent-parent-messages').innerText(), /已送达|待送达/)
    assert.equal(await page.locator('.agent-reader-toolbar .reader-actions').count(), 0)
    await page.screenshot({ path: join(tmpdir(), 'neo-minimal-messages.png') })
    await page.setViewportSize({ width: 430, height: 850 })
    const overflow = await page.locator('.background-task-modal').evaluate(el => el.scrollWidth > el.clientWidth + 1)
    assert.equal(overflow, false)
    assert.deepEqual(fixture.errors, [])
    assert.ok(fixture.requests.filter(r => /agent-content|tool-call-detail/.test(r.url)).every(r => r.method === 'GET'))
  } finally { await fixture.close() }
})
