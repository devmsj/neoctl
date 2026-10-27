import test from 'node:test'
import assert from 'node:assert/strict'
import { reactive } from 'vue'
import { createTranscriptLookup } from '../src/transcript-lookup.mjs'

function setup(lines) {
  const state = reactive({ lines })
  return { state, lookup: createTranscriptLookup(() => state.lines) }
}

test('user grouping preserves order, fallback, and reactive image/file edits', () => {
  const { state, lookup } = setup([
    { id: 1, kind: 'user', messageId: 'a', text: 'caption' },
    { id: 2, kind: 'user', messageId: 'b' },
    { id: 3, kind: 'user', messageId: 'a', image: { imageId: 'img_1' } },
    { id: 4, kind: 'assistant', messageId: 'a' },
    { id: 5, kind: 'user' },
  ])
  const group = lookup.userGroup(state.lines[0])
  assert.deepEqual(group.map(l => l.id), [1, 3])
  assert.equal(lookup.userGroup(state.lines[0]), group)
  state.lines[0].text = 'changed'
  assert.equal(lookup.userGroup(state.lines[0]), group)
  assert.equal(group[0].text, 'changed')
  state.lines[2].files = [{ name: 'file.txt' }]
  assert.equal(group[1].files[0].name, 'file.txt')
  assert.deepEqual(lookup.userGroup(state.lines[4]), [state.lines[4]])
  state.lines[2] = { ...state.lines[2], messageId: 'b' }
  assert.deepEqual(lookup.userGroup(state.lines[0]).map(l => l.id), [1])
  state.lines.push({ id: 6, kind: 'user', messageId: 'a' })
  assert.deepEqual(lookup.userGroup(state.lines[0]).map(l => l.id), [1, 6])
  state.lines = [{ id: 7, kind: 'user', messageId: 'a' }]
  assert.deepEqual(lookup.userGroup(state.lines[0]).map(l => l.id), [7])
})

test('tool images match parent with strict identity and update after patch', () => {
  const { state, lookup } = setup([
    { id: 1, toolUseId: 't' }, { id: 2, parentToolUseId: 't', image: {} },
    { id: 3, parentToolUseId: 'other', image: {} }, { id: 4, parentToolUseId: 't' },
  ])
  assert.deepEqual(lookup.toolImages(state.lines[0]).map(l => l.id), [2])
  state.lines[3].image = { url: '/image' }
  assert.deepEqual(lookup.toolImages(state.lines[0]).map(l => l.id), [2, 4])
  state.lines[1].parentToolUseId = 'other'
  assert.deepEqual(lookup.toolImages(state.lines[0]).map(l => l.id), [4])
})

test('resources preserve before-line boundary, first URL, and exclude live results', () => {
  const { state, lookup } = setup([
    { id: 0, kind: 'assistant' },
    { id: 1, resources: [{ url: '/a', label: 'first' }, null, { url: '' }, { url: 4 }] },
    { id: 2, kind: 'assistant' },
    { id: 3, live: true, resources: [{ url: '/b' }] },
    { id: 4, resources: [{ url: '/a', label: 'duplicate' }, { url: '/c' }] },
    { id: 5, kind: 'assistant' },
  ])
  const urls = line => lookup.resourcesBefore(line).map(r => r.url)
  assert.deepEqual(urls(state.lines[0]), [])
  assert.deepEqual(urls(state.lines[2]), ['/a'])
  assert.deepEqual(urls(state.lines[5]), ['/a', '/c'])
  const before = lookup.resourcesBefore(state.lines[2])
  state.lines[2].text = 'stream'
  assert.equal(lookup.resourcesBefore(state.lines[2]), before)
  assert.equal(lookup.resourcesBefore(state.lines[5])[0].label, 'first')
  state.lines[3].live = false
  assert.deepEqual(urls(state.lines[5]), ['/a', '/b', '/c'])
  state.lines[1].resources[0].url = '/changed'
  assert.deepEqual(urls(state.lines[2]), ['/changed'])
  assert.deepEqual(urls({ id: 'absent', kind: 'assistant' }), ['/changed', '/b', '/a', '/c'])
  assert.deepEqual(urls({ id: 5, kind: 'tool' }), [])
  state.lines = [{ id: 5, kind: 'assistant' }]
  assert.deepEqual(urls(state.lines[0]), [])
})

test('duplicate line IDs retain the first occurrence resource boundary', () => {
  const { state, lookup } = setup([
    { id: 1, kind: 'assistant' }, { id: 2, resources: [{ url: '/a' }] },
    { id: '1', kind: 'assistant' },
  ])
  assert.deepEqual(lookup.resourcesBefore(state.lines[2]), [])
})
