import test from 'node:test'
import assert from 'node:assert/strict'
import { createRenderer, defineComponent, computed, nextTick, ref } from 'vue'
import { createRuntimeLines } from '../src/runtime-lines.mjs'
import { useToolObservation } from '../src/use-tool-observation.mjs'
const renderer=createRenderer({createElement:()=>({}),createText:()=>({}),createComment:()=>({}),setText(){},setElementText(){},parentNode(){},nextSibling(){},insert(){},remove(){},patchProp(){}})
test('observation content subscriptions touch only changed rows and clean up on session change',async()=>{
 const store=createRuntimeLines(),session=ref('one');let signalReads=0,view
 store.replace(Array.from({length:100},(_,id)=>({id,kind:'tool',toolName:'file_write',activity:{phase:'generating',input:{content:'initial'}}})))
 const app=renderer.createApp(defineComponent({setup(){view=useToolObservation(computed(()=>store.lines),()=>session.value,()=>{signalReads++;return []});return()=>null}}))
 app.mount({});await nextTick();assert.equal(view.observed.value.id,99)
 signalReads=0;store.patch(99,{activity:{phase:'generating',input:{content:'changed'}}});await nextTick();await nextTick()
 assert.equal(signalReads,1);assert.equal(view.observed.value.activity.input.content,'changed')
 view.toggle(store.get(99));assert.equal(view.pinned.value,99)
 session.value='two';store.replace([]);store.append({id:1,kind:'thinking',text:'next'});await nextTick();await nextTick()
 assert.equal(view.pinned.value,null);assert.equal(view.observed.value.id,1)
 const reads=signalReads;app.unmount();store.patch(1,{text:'unmounted'});await nextTick();assert.equal(signalReads,reads)
})
