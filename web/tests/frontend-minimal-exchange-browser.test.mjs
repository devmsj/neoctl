import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createObservabilityBrowser, observabilitySnapshot } from './observability-browser-fixture.mjs'
const part = text => ({ state: 'complete', text, reason: '', offset: 0, totalChars: text.length, hasMore: false })

test('frontend-only: bidirectional content without run controls; file changes without stage chatter', async () => {
  const task = { kind: 'agent', taskId: 'exchange-task', agentId: 'child', description: '检查文档', status: 'completed', runGeneration: 2,
    runHistory: [{ runGeneration: 1, status: 'completed' }], progress: {} }
  const lines = [1, 2].map(id => ({ id, kind: id === 2 ? 'error' : 'tool', toolName: 'file_write', toolUseId: `write-${id}`, messageId: `m-${id}`, titleStatus: id === 2 ? 'failure' : 'success', text: 'write', toolError: id === 2 ? 'Permission denied' : undefined,
    toolDisplay: { purpose: '写入 inspect_roles.sql', previews: [{ kind: 'code', content: '+SELECT 1;' }] },
    toolStream: { message: '完成写入 1083 字节', steps: [{ status: 'unknown', message: '检查 inspect_roles.sql' }, { status: 'completed', message: '完成写入 1083 字节' }] } }))
  const fixture = await createObservabilityBrowser(observabilitySnapshot({ lines, agentTaskHistory: [task] }), async route => {
    const url = new URL(route.request().url())
    if (url.pathname !== '/api/agent-content') return
    const run = Number(url.searchParams.get('runGeneration'))
    const view = url.searchParams.get('view')
    const base = { ownerSessionId: 'obs-session', taskId: task.taskId, runGeneration: run, state: 'complete', reason: '', snapshotId: `${run}-${view}` }
    if (view === 'delegation') await route.fulfill({ json: { ...base, delegation: { scope: 'task', prompt: part('检查项目文档') } } })
    else if (view === 'messages') await route.fulfill({ json: { ...base, messages: { content: part(JSON.stringify([{ id: `m${run}`, text: run === 1 ? '保留原有目录' : '继续检查命令' }, { id: 'empty', text: '' }])) } } })
    else if (view === 'report') await route.fulfill({ json: { ...base, report: { content: part(run === 1 ? '目录已确认' : '命令已修正') } } })
    else throw Error('Unexpected view')
    return true
  })
  try {
    const { page } = fixture
    await page.locator('.tool-group-trigger').first().click()
    assert.doesNotMatch(await page.locator('.chat-scroll').count() ? await page.locator('.chat-scroll').innerText() : await page.locator('body').innerText(), /完成写入|阶段结果未提供/)
    await page.getByText('+SELECT 1;', { exact: true }).first().waitFor()
    await page.getByText('Permission denied', { exact: true }).waitFor()
    assert.equal(await page.locator('.tool-result-title-row .tool-result-failure-mark').count(), 1)
    await page.locator('.background-task-history > summary').click()
    await page.locator('.background-task-history-item').first().click()
    await page.getByText('命令已修正', { exact: true }).waitFor()
    assert.deepEqual(await page.locator('.agent-parent-message .markdown').allTextContents(), ['检查项目文档\n', '保留原有目录\n', '目录已确认\n', '继续检查命令\n', '命令已修正\n'])
    assert.deepEqual(await page.locator('.agent-parent-message header').allTextContents(), ['主代理 → 子代理', '主代理 → 子代理', '子代理 → 主代理', '主代理 → 子代理', '子代理 → 主代理'])
    assert.equal(await page.locator('.agent-run-tabs, .agent-reader-tabs, .reader-actions').count(), 0)
    assert.doesNotMatch(await page.locator('.background-task-modal').innerText(), /第\s*\d+\s*轮|未提供|已送达|待送达/)
    await page.setViewportSize({ width: 430, height: 850 })
    assert.equal(await page.locator('.background-task-modal').evaluate(el => el.scrollWidth > el.clientWidth + 1), false)
    assert.deepEqual(fixture.errors, [])
  } finally { await fixture.close() }
})
