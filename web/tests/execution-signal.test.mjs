import test from 'node:test'
import assert from 'node:assert/strict'
import { executionSignal, waitDotStyle } from '../src/execution-signal.mjs'
test('signal follows the selected observation rather than historical/current tool rotation', () => {
 const status={phase:'running_tools',currentTool:{name:'plan_update'}}
 assert.deepEqual(executionSignal(status,'',false,{toolName:'terminal_control'}),{mode:'tools',tools:['terminal_control']})
 assert.deepEqual(executionSignal(status,'',false,{kind:'thinking'}),{mode:'tools',tools:['thinking']})
 assert.deepEqual(executionSignal(status),{mode:'tools',tools:['plan_update']})
 assert.deepEqual(executionSignal({phase:'calling_model',modelOutput:{kind:'text'}}),{mode:'working',tools:[]})
})
test('waiting, paused, loading and compaction preserve explicit status precedence',()=>{
 const old={toolName:'file_read'}
 assert.equal(executionSignal({phase:'calling_model'},'',false,old).mode,'waiting')
 assert.equal(executionSignal({phase:'compacting'},'',false,old).mode,'compacting')
 assert.equal(executionSignal({phase:'calling_model'},'paused',false,old).mode,'paused')
 assert.equal(executionSignal({},'',true,old).mode,'loading')
 assert.ok(waitDotStyle(8,180000)['--rest'] > waitDotStyle(8,0)['--rest'])
})
