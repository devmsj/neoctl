import test from 'node:test'
import assert from 'node:assert/strict'
import { computed, effect, reactive, isReactive } from 'vue'
import { createRuntimeLines, indexRuntimeTasks } from '../src/runtime-lines.mjs'
import { runtimeActivitySignal } from '../src/tool-runtime-observation.mjs'

test('streaming preserves row membership and only invalidates changed fields', () => {
  const store=createRuntimeLines(), state=reactive({lines:store.lines})
  store.replace([{id:1,kind:'assistant',text:'a'},{id:2,kind:'tool',activity:{input:{content:'x'}}}])
  let structural=0, paints=0
  const ids=computed(()=>{structural++;return state.lines.map(l=>l.id)})
  effect(()=>{ids.value;state.lines[0]?.text;paints++})
  const row=state.lines[0]
  store.patch(1,{text:'ab'})
  assert.equal(state.lines[0],row);assert.equal(structural,1);assert.equal(paints,2)
  assert.equal(isReactive(state.lines[1].activity),false)
  assert.equal(store.append({id:'1',text:'duplicate'}),false)
  store.append({id:3,text:'new'});assert.equal(structural,2)
  store.replace([{id:1,kind:'assistant',text:'abc'},{id:2,kind:'tool',activity:{input:{content:'y'}}},{id:3,text:'new'}])
  assert.equal(structural,2);assert.equal(state.lines[0],row)
  store.replace([{id:3,text:'new'},{id:1,text:'latest'}]);assert.equal(state.lines.length,2);assert.equal(state.lines[1],row);assert.equal(row.kind,undefined);assert.equal(store.get(2),undefined)
})

test('task index preserves matching precedence, aliases and run generations',()=>{
 const tasks=[{kind:'terminal',sessionId:'s',runId:'alias',status:'running'}, {kind:'terminal',sessionId:'s',status:'completed'}, {taskId:'a',runGeneration:1,status:'completed'},{taskId:'a',runGeneration:2,status:'running'}]
 const index=indexRuntimeTasks(tasks)
 for(const line of [{toolName:'terminal_run',observation:{session_id:'s'}},{toolName:'terminal_control',activity:{input:{session_id:'alias'}}},{toolName:'subagent_run',observation:{task_id:'a',run_generation:2}},{toolName:'terminal_run',observation:{}},{toolName:'file_read'}]) assert.deepEqual(runtimeActivitySignal(line,index.forLine(line)),runtimeActivitySignal(line,tasks))
})
