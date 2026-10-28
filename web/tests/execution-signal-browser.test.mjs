import test from 'node:test'
import assert from 'node:assert/strict'
import { createObservabilityBrowser, observabilitySnapshot } from './observability-browser-fixture.mjs'
test('square waiting signal, real tool icons and clock-only completion', async () => {
 const snapshot=observabilitySnapshot({busy:true,status:{phase:'calling_model',responseWaitStartedAt:Date.now()-90000,queryTiming:{version:1,id:'q',kind:'query',status:'running',elapsedMs:100000}}})
 const ui=await createObservabilityBrowser(()=>snapshot)
 try {
  const signal=ui.page.locator('.execution-signal');await signal.waitFor()
  const box=await signal.boundingBox();assert.equal(box.width,28);assert.equal(box.height,28)
  const clockBox=await ui.page.locator('.elapsed-clock').boundingBox()
  assert.ok(clockBox.x + clockBox.width < box.x, 'clock and duration precede the status signal')
  assert.equal(await signal.locator('circle').count(),9)
  assert.equal(await signal.textContent(),'')
  assert.ok(Number(await signal.locator('circle').first().evaluate(el=>el.style.getPropertyValue('--rest')))>.5)
  snapshot.status.phase='running_tools';snapshot.status.currentTool={name:'file_read'}
  await ui.page.reload();await ui.page.locator('.signal-tool').waitFor()
  snapshot.busy=false;snapshot.status.phase='ready';snapshot.status.queryTiming={version:1,id:'q',kind:'query',status:'finished',outcome:'completed',durationMs:110000}
  await ui.page.reload();await ui.page.locator('.elapsed-clock.is-completed').waitFor()
  assert.equal(await signal.count(),0);assert.equal(await ui.page.locator('.execution-signal-divider').count(),0)
  assert.equal(await ui.page.locator('.message-loading-label').count(),0)
  assert.deepEqual(ui.errors,[])
 } finally {await ui.close()}
})

test('flashing icon stays with the observation while new updates and pinned previews switch', async () => {
 const snapshot=observabilitySnapshot({busy:true,status:{phase:'running_tools',currentTool:{name:'plan_update'}},lines:[
  {id:1,kind:'user',text:'test'},
  {id:2,kind:'tool',toolName:'plan_update',activity:{phase:'completed',input:{items:[]}},titleStatus:'success'},
  {id:3,kind:'tool',toolName:'file_read',activity:{phase:'completed',input:{path:'fixture.txt'}},observation:{content:'selected read output'},titleStatus:'success'},
 ]})
 const ui=await createObservabilityBrowser(()=>snapshot)
 try {
  const p=ui.page
  await p.addInitScript(()=>{window.EventSource=class extends EventTarget{constructor(){super();window.signalEvents=this;queueMicrotask(()=>this.dispatchEvent(new Event('open')))}close(){}}})
  await p.reload()
  await p.locator('.tool-observation.is-main').getByText('selected read output',{exact:true}).waitFor()
  assert.equal(await p.locator('.execution-signal .signal-tool').getAttribute('aria-label'),'读取文件')
  await p.waitForTimeout(2700)
  assert.equal(await p.locator('.execution-signal .signal-tool').getAttribute('aria-label'),'读取文件','must not rotate to plan')
  snapshot.lines.push({id:4,kind:'thinking',text:'current thought',live:true})
  await p.evaluate(s=>window.signalEvents.dispatchEvent(new MessageEvent('sync',{data:JSON.stringify(s)})),snapshot)
  await p.locator('.tool-observation.is-main').getByText('current thought',{exact:true}).waitFor()
  assert.equal(await p.locator('.execution-signal .signal-tool').getAttribute('aria-label'),'思考')
  await p.locator('.thinking-activity-row').last().click()
  await p.locator('.tool-observation.is-pinned').getByText('current thought',{exact:true}).waitFor()
  assert.equal(await p.locator('.execution-signal .signal-tool').getAttribute('aria-label'),'思考')
  assert.deepEqual(ui.errors,[])
 }finally{await ui.close()}
})
