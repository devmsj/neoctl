import test from 'node:test'
import assert from 'node:assert/strict'
import { effect, reactive } from 'vue'
import { stableComputed } from '../src/stable-view.mjs'

test('a state sync that replaces data without changing the view does not re-trigger the column', () => {
  const state = reactive({ tasks: [{ id: 'a', status: 'running', output: 'line 1' }] })
  const view = stableComputed(() => ({ count: state.tasks.length, items: state.tasks.map(({ id, status }) => ({ id, status })) }))
  let renders = 0
  effect(() => { view.value; renders++ })
  const first = view.value
  assert.equal(renders, 1)

  // Streaming sync: new array/objects, only a field the column does not show changed.
  state.tasks = [{ id: 'a', status: 'running', output: 'line 1\nline 2' }]
  assert.equal(view.value, first, 'same object while the view content is unchanged')
  assert.equal(renders, 1, 'dependents (the right panel render) are not re-triggered')

  // A visible change still flows through.
  state.tasks = [{ id: 'a', status: 'completed', output: 'done' }]
  assert.notEqual(view.value, first)
  assert.deepEqual(view.value.items, [{ id: 'a', status: 'completed' }])
  assert.equal(renders, 2)
})

test('null views (hidden cards) are stable and can reappear', () => {
  const state = reactive({ quota: null })
  const view = stableComputed(() => state.quota ? { percent: state.quota.percent } : null)
  let renders = 0
  effect(() => { view.value; renders++ })
  state.quota = null
  assert.equal(view.value, null); assert.equal(renders, 1)
  state.quota = { percent: 40, fetchedAt: 1 }
  assert.deepEqual(view.value, { percent: 40 }); assert.equal(renders, 2)
  const shown = view.value
  state.quota = { percent: 40, fetchedAt: 2 }
  assert.equal(view.value, shown); assert.equal(renders, 2)
})
