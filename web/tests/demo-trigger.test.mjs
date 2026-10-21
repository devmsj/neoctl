import assert from 'node:assert/strict'
import test from 'node:test'
import { createDemoTrigger } from '../src/demo-trigger.js'

test('only five consecutive eligible clicks in the same session trigger once', () => {
  const trigger = createDemoTrigger()
  for (let i = 0; i < 4; i++) assert.equal(trigger.click('one', true, i * 100), false)
  assert.equal(trigger.click('one', true, 400), true)
  assert.equal(trigger.click('one', true, 500), false)
})

test('time gap, ineligibility, explicit reset and session switches break the gesture', () => {
  const trigger = createDemoTrigger()
  for (let i = 0; i < 4; i++) trigger.click('one', true, i * 100)
  assert.equal(trigger.click('one', true, 2000), false)
  trigger.click('one', false, 2100)
  for (let i = 0; i < 4; i++) assert.equal(trigger.click('one', true, 2200 + i * 100), false)
  assert.equal(trigger.click('two', true, 2600), false)
  trigger.reset()
  assert.equal(trigger.click('two', true, 2700), false)
  assert.equal(trigger.click('', true, 2800), false)
})
