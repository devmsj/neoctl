import test from 'node:test'
import assert from 'node:assert/strict'
import { createObservabilityBrowser, observabilitySnapshot } from './observability-browser-fixture.mjs'
test('paused clock has a play button on its right that continues without sending a draft', async () => {
 const snapshot=observabilitySnapshot({runControl:{state:'paused',canPause:false,canResume:true,timer:{elapsedMs:450000,running:false}}})
 let calls=0,release
 const ui=await createObservabilityBrowser(()=>snapshot,async route=>{
  if(new URL(route.request().url()).pathname!=='/api/run/continue')return false
  calls++;await new Promise(resolve=>{release=resolve});await route.fulfill({json:{ok:true}});return true
 })
 try {
  const button=ui.page.locator('.execution-resume');await button.waitFor()
  assert.equal(await button.locator('path').getAttribute('d'),'m6 4 10 6-10 6Z')
  const clock=await ui.page.locator('.elapsed-clock').boundingBox(),play=await button.boundingBox()
  assert.ok(clock.x+clock.width<play.x)
  await ui.page.getByRole('textbox',{name:'消息',exact:true}).fill('keep my draft')
  await button.click()
  assert.equal(await button.isDisabled(),true)
  await new Promise(resolve=>setTimeout(resolve,150));assert.equal(calls,1)
  release();await ui.page.waitForFunction(()=>!document.querySelector('.execution-resume').disabled)
  assert.equal(await ui.page.getByRole('textbox',{name:'消息',exact:true}).inputValue(),'keep my draft')
  assert.equal(ui.requests.filter(r=>new URL(r.url).pathname==='/api/submit').length,0)
  snapshot.runControl={state:'resuming',canResume:false}
  await ui.page.reload();await button.waitFor();assert.equal(await button.isDisabled(),true)
 } finally {release?.();await ui.close()}
})
