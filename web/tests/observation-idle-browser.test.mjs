import assert from 'node:assert/strict'
import { createObservabilityBrowser, observabilitySnapshot } from './observability-browser-fixture.mjs'
let snapshot=observabilitySnapshot({lines:[{id:1,kind:'tool',toolName:'file_read',text:'first',activity:{phase:'completed',input:{path:'test.txt'}},observation:{kind:'text',text:'first'},titleStatus:'success'}]})
const fixture=await createObservabilityBrowser(()=>snapshot)
const {page}=fixture
try {
 await page.addInitScript(()=>{
  window.EventSource=class{constructor(){window.idleEvents=this;this.listeners={}}addEventListener(k,fn){this.listeners[k]=fn}close(){}}
  window.idleSync=s=>window.idleEvents.listeners.sync({data:JSON.stringify(s)})
 })
 await page.reload()
 const main=page.locator('.tool-observation.is-main')
 await main.waitFor()
 await page.waitForTimeout(3500);assert.equal(await main.isVisible(),true)
 await page.waitForTimeout(2300);assert.equal(await main.isVisible(),false)
 snapshot=observabilitySnapshot({lines:[{...snapshot.lines[0],text:'new content',observation:{kind:'text',text:'new content'}}]})
 await page.evaluate(s=>window.idleSync(s),snapshot);await main.waitFor()
 assert.equal(await main.isVisible(),true)
 assert.deepEqual(fixture.errors,[])
 console.log('PASS observation idle: visible before 5s, animated hide after idle at bottom, reappears on new content')
}finally{await fixture.close()}
