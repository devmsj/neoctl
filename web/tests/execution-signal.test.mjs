import test from 'node:test'
import assert from 'node:assert/strict'
import { executionSignal, waitDotStyle } from '../src/execution-signal.mjs'
test('waiting is distinct from output and tools; only current turn tools are used', () => {
 const lines=[{kind:'tool',toolName:'old'},{kind:'user'},{kind:'tool',toolName:'file_read'},{kind:'tool',toolName:'file_read'}]
 assert.equal(executionSignal({phase:'calling_model'},lines).mode,'waiting')
 assert.deepEqual(executionSignal({phase:'running_tools',currentTool:{name:'file_edit'}},lines),{mode:'tools',tools:['file_edit','file_read']})
 assert.equal(executionSignal({phase:'calling_model',modelOutput:{kind:'text'}},[]).mode,'working')
 assert.equal(executionSignal({phase:'calling_model'},lines,'paused').mode,'paused')
 assert.ok(waitDotStyle(8,180000)['--rest'] > waitDotStyle(8,0)['--rest'])
})
