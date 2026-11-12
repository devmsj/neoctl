import test from 'node:test'
import assert from 'node:assert/strict'
import { createTranscriptHistory } from '../src/transcript-history.mjs'
const tail = [{ id: 1, text: 'latest', historyOffset: 200 }]
const metadata = { before: 200, hasMore: true, epoch: 'e' }
const page = { sessionId: 's', before: 100, hasMore: true, epoch: 'e', lines: [{ id: 'history:200:0', text: 'older', historyOffset: 100 }] }

test('prefetch is deduplicated, not visible until consumed, survives SSE snapshots', async () => {
  let calls = 0
  const history = createTranscriptHistory({ fetchPage: async () => { calls++; return page } })
  assert.deepEqual(history.sync('s', metadata, tail), tail)
  await Promise.all([history.prefetch(), history.prefetch()]); assert.equal(calls, 1)
  assert.deepEqual(history.sync('s', metadata, tail), tail)
  assert.deepEqual(await history.take(), page.lines)
  assert.deepEqual(history.sync('s', metadata, tail), [...page.lines, ...tail])
})

test('old requests cannot insert into a different session, requests abort on reset', async () => {
  let resolve, signal
  const history = createTranscriptHistory({ fetchPage: options => { signal = options.signal; return new Promise(r => { resolve = r }) } })
  history.sync('s', metadata, tail)
  const pending = history.take()
  history.sync('other', { ...metadata, epoch: 'other' }, [])
  assert.equal(signal.aborted, true)
  resolve(page); assert.deepEqual(await pending, [])
  assert.deepEqual(history.sync('other', { ...metadata, epoch: 'other' }, []), [])
})

test('failed pages retain cursor and are retryable; reset epoch discards stale prefix', async () => {
  let calls = 0
  const history = createTranscriptHistory({ fetchPage: async () => { if (!calls++) throw new Error('offline'); return page } })
  history.sync('s', metadata, tail)
  assert.deepEqual(await history.take(), []); assert.equal(history.state.error, 'offline'); assert.equal(history.state.hasMore, true)
  assert.deepEqual(await history.take(), page.lines)
  assert.deepEqual(history.sync('s', { ...metadata, epoch: 'reset' }, tail), tail)
})


test('rebuilt snapshot starts at its own cursor rather than skipping the intervening history', async () => {
  const cursors = []
  const history = createTranscriptHistory({ fetchPage: async ({ before }) => {
    cursors.push(before)
    return { ...page, before: before - 100 }
  } })
  history.sync('s', metadata, tail); await history.take()
  history.sync('s', { ...metadata, before: 400 }, tail); await history.take()
  assert.deepEqual(cursors, [200, 400])
})
