import test from 'node:test'
import assert from 'node:assert/strict'
import { composerRunAction } from '../src/run-control.mjs'

for (const state of ['paused', 'interrupted']) {
  test(`${state}: empty composer continues, draft sends new instruction, deleting draft restores continue`, () => {
    const base = { control: { state, canResume: true }, running: false }
    assert.deepEqual(composerRunAction(base), { action: 'continue', label: '继续', disabled: false })
    assert.equal(composerRunAction({ ...base, hasDraft: true }).action, 'send')
    assert.equal(composerRunAction({ ...base, hasDraft: false }).action, 'continue')
    assert.equal(composerRunAction({ ...base, hasDraft: true, uploading: true }).disabled, true)
  })
}
test('running uses pause; drafts and queues preserve send actions', () => {
  const base = { running: true, control: { canPause: true } }
  assert.equal(composerRunAction(base).action, 'pause')
  assert.equal(composerRunAction({ ...base, hasDraft: true }).action, 'interrupt-send')
  assert.equal(composerRunAction({ ...base, queued: 'next' }).action, 'send-now')
})
test('accepted continuation blocks duplicate submissions, completed does not offer continue', () => {
  assert.deepEqual(composerRunAction({ control: { state: 'resuming' }, hasDraft: true }), {
    action: 'waiting', label: '已接收，等待旧请求取消', disabled: true,
  })
  assert.equal(composerRunAction({ running: false }).disabled, true)
  assert.equal(composerRunAction({ pending: true, control: { canResume: true } }).disabled, true)
})

test('desktop draft queues by default and queued-only composer keeps pause', () => {
 const base={running:true,queueByDefault:true,control:{canPause:true}}
 assert.equal(composerRunAction({...base,hasDraft:true}).action,'send')
 assert.equal(composerRunAction({...base,queued:'pending'}).action,'pause')
 assert.equal(composerRunAction({...base,hasDraft:true,uploading:true}).disabled,true)
})
