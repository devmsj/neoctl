import assert from 'node:assert/strict'
import test from 'node:test'
import { executionElapsedMs, formatDuration, receiveTimings, timingElapsedMs } from '../src/core-timing.mjs'

test('duration display uses whole seconds, including subsecond and minute boundaries', () => {
  for (const [ms, text] of [[0, ''], [999, ''], [1000, '1s'], [4700, '4s'],
    [9999, '9s'], [59999, '59s'], [60000, '1m 0s'], [119999, '1m 59s'], [120000, '2m 0s'],
    [-1, ''], [NaN, ''], [Infinity, '']]) {
    assert.equal(formatDuration(ms), text)
  }
  const record = { version: 1, id: 'q', status: 'finished', durationMs: 4700 }
  assert.equal(formatDuration(timingElapsedMs(record)), '4s')
  assert.equal(record.durationMs, 4700, 'formatting does not change core precision')
})

test('task clock freezes while paused and resumes from accumulated active time', () => {
  const control = { state: 'running', timer: { elapsedMs: 12500, running: true }, receivedAt: 500 }
  assert.equal(executionElapsedMs(control, 2500), 14500)
  assert.equal(executionElapsedMs(control, 0), 12500)
  assert.equal(executionElapsedMs(control, 90000, false), 12500)
  for (const state of ['paused', 'interrupted', 'resuming']) {
    assert.equal(executionElapsedMs({ ...control, state }, 90000), 12500)
  }
  assert.equal(executionElapsedMs({ ...control, timer: { elapsedMs: 12500, running: false } }, 90000), 12500)
  assert.equal(executionElapsedMs({ ...control, receivedAt: 90000 }, 91000), 13500)
  assert.equal(executionElapsedMs(undefined), undefined)
  assert.equal(executionElapsedMs({ timer: { elapsedMs: -1 } }), undefined)
})

const running = { version: 1, id: 'run', status: 'running', elapsedMs: 12000 }

test('running display uses core baseline plus local monotonic interpolation, never wall time', () => {
  const record = receiveTimings([{ ...running, startedAt: '1900-01-01T00:00:00.000Z' }], 500)[0]
  assert.equal(timingElapsedMs(record, 2500), 14000)
  assert.equal(timingElapsedMs(record, 0), 12000)
  assert.equal(timingElapsedMs(record, 9000, false), 12000)
  assert.equal(running.receivedAt, undefined)
})

test('reload and reconnect replace the presentation origin using a fresh core snapshot', () => {
  const before = receiveTimings([running], 500)[0]
  const after = receiveTimings([{ ...running, elapsedMs: 30000 }], 100)[0]
  assert.equal(timingElapsedMs(before, 1500), 13000)
  assert.equal(timingElapsedMs(after, 1100), 31000)
  assert.deepEqual(receiveTimings(undefined), [])
  assert.deepEqual(receiveTimings([]), [])
})

test('completed durations freeze; legacy, queued and interrupted records never invent a duration', () => {
  const record = receiveTimings([{ ...running, status: 'finished', durationMs: 12345 }], 500)[0]
  for (const connected of [true, false]) assert.equal(timingElapsedMs(record, 900000, connected), 12345)
  for (const status of ['queued', 'interrupted', 'unknown']) {
    assert.equal(timingElapsedMs({ ...running, status }, 500), undefined)
  }
  assert.equal(timingElapsedMs(undefined), undefined)
  assert.equal(timingElapsedMs({ status: 'running', startedAt: '2026-01-01' }), undefined)
  assert.equal(timingElapsedMs({ status: 'finished', durationMs: -1 }), undefined)
})
