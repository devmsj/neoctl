import test from 'node:test'
import assert from 'node:assert/strict'
import {createObservabilityBrowser,observabilitySnapshot} from './observability-browser-fixture.mjs'
test('stable streaming rows render every input patch and text without replacing history',async()=>{
 const snapshot=observabilitySnapshot({busy:true,lines:[{id:1,kind:'tool',toolName:'file_write',toolUseId:'write',live:true,activity:{phase:'generating',input:{path:'a.ts',content:'first'}}}],status:{phase:'running_tools'},runControl:{state:'running',canPause:true}})
 const ui=await createObservabilityBrowser(snapshot)
 try{
 const p=ui.page;await p.addInitScript(()=>{window.EventSource=class{constructor(){window.stream=this;this.handlers={}}addEventListener(k,f){this.handlers[k]=f}close(){}}});await p.reload();await p.locator('.tool-observation').waitFor()
 const send=operations=>p.evaluate(operations=>window.stream.handlers.delta({data:JSON.stringify({sessionId:'obs-session',operations})}),operations)
 await send([{type:'line.activity.input',id:1,changes:[{op:'append',path:['content'],value:' second'}]}])
 await p.waitForFunction(()=>document.querySelector('.tool-observation')?.textContent==='first second')
 await send([{type:'line.patch',id:1,patch:{live:false,titleStatus:'success'}},{type:'line.append',line:{id:2,kind:'thinking',live:true,text:'thinking'}}])
 await send([{type:'line.text.append',id:2,text:' continued'}])
 await p.waitForFunction(()=>document.querySelector('.tool-observation')?.textContent.includes('thinking continued'))
 await send([{type:'line.patch',id:2,patch:{live:false}},{type:'line.append',line:{id:3,kind:'assistant',live:true,text:'visible'}}])
 await send([{type:'line.text.append',id:3,text:' reply'}])
 await p.waitForFunction(()=>document.querySelector('.message.assistant')?.textContent.includes('visible reply'))
 assert.deepEqual(ui.errors,[])
 }finally{await ui.close()}
})
