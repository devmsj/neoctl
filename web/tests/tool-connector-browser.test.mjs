import assert from 'node:assert/strict'
import {createObservabilityBrowser,observabilitySnapshot} from './observability-browser-fixture.mjs'
let snapshot=observabilitySnapshot()
const fixture=await createObservabilityBrowser(()=>snapshot),{page}=fixture
try{
 await page.addInitScript(()=>{window.EventSource=class{constructor(){window.connectorEvents=this;this.listeners={}}addEventListener(n,f){this.listeners[n]=f}close(){}}})
 await page.reload();await page.waitForFunction(()=>window.connectorEvents?.listeners.sync)
 const tool=(id,connect)=>({id,kind:'tool',toolName:'file_read',connectPreviousTool:connect,titleStatus:'success',text:'text',activity:{phase:'completed',input:{path:'test.txt'}}})
 snapshot=observabilitySnapshot({lines:[tool(1,false),tool(2,true),tool(3,true)]})
 await page.evaluate(s=>window.connectorEvents.listeners.sync({data:JSON.stringify(s)}),snapshot)
 const route=page.locator('.tool-turn-route');await route.waitFor()
 assert.equal(await route.count(),1)
 const initial=await route.getAttribute('d');assert.ok(!/[CQAS]/i.test(initial));assert.equal((initial.match(/V/g)||[]).length,1);assert.equal((initial.match(/H/g)||[]).length,3)
 assert.equal(await route.getAttribute('stroke-linejoin'),'miter')
 assert.equal(await route.evaluate(e=>getComputedStyle(e).animationName),'tool-turn-extend')
 await page.locator('[data-line-id="1"]').evaluate(el=>{el.style.paddingBottom='80px'})
 await page.waitForTimeout(150)
 assert.notEqual(await route.getAttribute('d'),initial)
 assert.equal(await route.count(),1)
 assert.deepEqual(fixture.errors,[])
 console.log('PASS connector: orthogonal single trunk, unique branches, animation, remeasured after row-height change')
}finally{await fixture.close()}
