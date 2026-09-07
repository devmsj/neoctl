import test from 'node:test'
import assert from 'node:assert/strict'
import { acceptsPreview, canExportFull, contentText, contentUrl, defaultContentView, emptyContent, exportScope, mergeContent, mergeFragment } from './src/agent-content-reader.mjs'
const identity = { ownerSessionId: 'owner /+中', taskId: 'task-a', runGeneration: 2 }
const fragment = (text, offset = 0, totalChars = text.length, state = 'complete') => ({ text, offset, totalChars, state, reason: 'fixture', hasMore: offset + text.length < totalChars })
const item = (content, id = '0:0') => ({ id, kind: 'assistant', messageId: 'm1', content })
const page = (items = [], extra = {}) => ({ ...identity, state: 'complete', reason: 'fixture', snapshotId: 's1', items, refreshCursor: 'r1', ...extra })
const report = (content, extra = {}) => ({ ...identity, state: content.hasMore ? 'partial' : 'complete', reason: 'fixture', snapshotId: 's1', ...(content.hasMore ? { nextCursor: 'n1' } : {}), report: { content, source: 'runHistory', taskStatus: 'killed', reportStatus: 'incomplete', error: { state: 'complete', text: 'stopped', reason: '' } }, ...extra })

test('read-only URL has exact owner/run/view/paging fields; unknown legacy run rejected', () => {
  const url = new URL(contentUrl(identity, 'timeline', 'opaque+/=', true), 'http://localhost')
  assert.deepEqual(Object.fromEntries(url.searchParams), { sessionId: identity.ownerSessionId, taskId: identity.taskId, runGeneration: '2', view: 'timeline', pageChars: '16000', cursor: 'opaque+/=', refresh: 'true' })
  assert.throws(() => contentUrl({ ...identity, runGeneration: undefined }, 'report'))
  assert.throws(() => contentUrl(identity, 'context'))
  assert.throws(() => contentUrl(identity, 'report', 'r', true))
  assert.equal(defaultContentView('running'), 'timeline'); assert.equal(defaultContentView('failed'), 'report')
})
test('UTF16 fragments, retry, overlap, out of order gaps and conflicts', () => {
  let value = mergeFragment(null, fragment('甲😀', 0, 6))
  value = mergeFragment(value, fragment('甲😀', 0, 6))
  value = mergeFragment(value, fragment('乙丙丁', 3, 6))
  value = mergeFragment(value, fragment('😀乙', 1, 6))
  assert.equal(value.text, '甲😀乙丙丁'); assert.equal(value.hasMore, false)
  assert.throws(() => mergeFragment(null, fragment('x', 3, 4)), /缺页/)
  assert.throws(() => mergeFragment(value, fragment('错', 0, 6)), /冲突/)
  assert.throws(() => mergeFragment(value, fragment('x', 0, 7)), /改变/)
  assert.throws(() => mergeFragment(null, { ...fragment('x'), hasMore: true }), /范围/)
})
test('id + offset idempotence preserves 40 ordered records beyond old preview caps', () => {
  let value = emptyContent()
  for (let start = 0; start < 40; start += 10) {
    const p = page(Array.from({ length: 10 }, (_, n) => item(fragment(`body-${start + n}`), `${start + n}:0`)))
    value = mergeContent(value, p, identity, 'timeline', start ? 'next' : 'start')
    value = mergeContent(value, p, identity, 'timeline')
  }
  assert.equal(value.items.length, 40)
  assert.deepEqual(value.items.map(i => i.content.text), Array.from({ length: 40 }, (_, i) => `body-${i}`))
})
test('owner/task/run mismatches and unknown states are rejected', () => {
  for (const replacement of [{ ownerSessionId: 'other' }, { taskId: 'other' }, { runGeneration: 1 }, { state: 'success' }]) assert.throws(() => mergeContent(emptyContent(), page([], replacement), identity, 'timeline', 'start'))
})
test('next snapshot must match; drained refresh advances snapshot without duplicates; restart replaces', () => {
  let value = mergeContent(emptyContent(), page([item(fragment('old'))]), identity, 'timeline', 'start')
  assert.throws(() => mergeContent(value, page([], { snapshotId: 's2' }), identity, 'timeline'), /快照/)
  value = mergeContent(value, page([item(fragment('new'), '100:0')], { snapshotId: 's2', refreshCursor: 'r2' }), identity, 'timeline', 'refresh')
  assert.deepEqual(value.items.map(i => i.content.text), ['old', 'new'])
  value = mergeContent(value, page([item(fragment('replace'))], { snapshotId: 's3' }), identity, 'timeline', 'start')
  assert.deepEqual(value.items.map(i => i.content.text), ['replace'])
})
test('empty partial page is progress with cursor; pendingTail is not full export', () => {
  let value = mergeContent(emptyContent(), page([], { state: 'partial', nextCursor: 'scan2', refreshCursor: undefined }), identity, 'timeline', 'start')
  assert.equal(value.page.nextCursor, 'scan2'); assert.match(exportScope(value, 'timeline'), /非全文/)
  assert.throws(() => mergeContent(value, page(), identity, 'timeline', 'refresh'))
  value = mergeContent(value, page([], { pendingTail: true }), identity, 'timeline')
  assert.match(exportScope(value, 'timeline'), /非全文/)
  assert.throws(() => mergeContent(emptyContent(), page([], { state: 'partial', refreshCursor: undefined }), identity, 'timeline', 'start'), /游标/)
})
test('tool object, call id, failed result and unknown source status stay separate', () => {
  const tool = { ...item(fragment('{"path":"C:/真实对象"}')), kind: 'tool_use', toolUseId: 'call-1', toolName: 'file_read', status: 'invoked', object: { state: 'complete', text: 'C:/真实对象' } }
  const result = { ...item(fragment('permission denied'), '100:1'), kind: 'tool_result', toolUseId: 'call-1', toolName: 'file_read', status: 'failed', ok: false }
  const value = mergeContent(emptyContent(), page([tool, result]), identity, 'timeline', 'start')
  assert.match(contentText(value, 'timeline'), /C:\/真实对象/); assert.match(contentText(value, 'timeline'), /调用 ID：call-1/)
  assert.match(contentText(value, 'timeline'), /invoked/); assert.match(contentText(value, 'timeline'), /failed/)
  assert.throws(() => mergeContent(value, page([{ ...tool, toolUseId: 'different' }]), identity, 'timeline'), /身份冲突/)
})
test('task scope delegation only; report content is never substituted for missing archived run', () => {
  const p = { ...identity, state: 'complete', reason: '', snapshotId: 's1', delegation: { scope: 'task', prompt: fragment('task scope'), description: { state: 'missing', text: '' } } }
  const value = mergeContent(emptyContent(), p, identity, 'delegation', 'start')
  assert.match(exportScope(value, 'delegation'), /不是本轮续跑指令/)
  assert.throws(() => mergeContent(emptyContent(), { ...p, delegation: { ...p.delegation, scope: 'resume' } }, identity, 'delegation', 'start'), /scope/)
  const missing = mergeContent(emptyContent(), { ...identity, state: 'missing', reason: '淘汰' }, identity, 'report', 'start')
  assert.equal(contentText(missing, 'report'), ''); assert.equal(canExportFull(missing, 'report'), false)
})
test('paginated partial stopped report becomes saved full text, never completed report', () => {
  let value = mergeContent(emptyContent(), report(fragment('part', 0, 8)), identity, 'report', 'start')
  assert.match(exportScope(value, 'report'), /非全文/)
  value = mergeContent(value, report(fragment(' end', 4, 8)), identity, 'report')
  assert.equal(contentText(value, 'report'), 'part end')
  assert.match(exportScope(value, 'report'), /全文.*未完成/)
  assert.equal(value.page.report.taskStatus, 'killed')
})
test('truncated, missing and unavailable are not full; valid empty report is distinct', () => {
  for (const state of ['truncated', 'missing', 'unavailable']) {
    const value = mergeContent(emptyContent(), report(fragment('', 0, 0, state)), identity, 'report', 'start')
    assert.equal(canExportFull(value, 'report'), false); assert.match(exportScope(value, 'report'), /非全文/)
  }
  const empty = mergeContent(emptyContent(), report(fragment('')), identity, 'report', 'start')
  assert.equal(canExportFull(empty, 'report'), true); assert.match(exportScope(empty, 'report'), /已保存报告全文/)
})
test('visible preview requires explicit safe channel, known matching run, text and truncation fact', () => {
  const p = { text: 'safe', truncated: false, channel: 'visible', runGeneration: 2 }
  assert.equal(acceptsPreview(p, identity), true)
  for (const patch of [{ channel: undefined }, { channel: 'analysis' }, { channel: 'unknown' }, { runGeneration: 1 }, { text: undefined }, { truncated: undefined }]) assert.equal(acceptsPreview({ ...p, ...patch }, identity), false)
  assert.equal(acceptsPreview(p, { ...identity, taskId: '' }), false)
})
