import test from 'node:test'
import assert from 'node:assert/strict'
import { createObservabilityBrowser, observabilitySnapshot } from './observability-browser-fixture.mjs'
test('image edit observation renders prompt without argument JSON in live and pinned views',async()=>{
 const line={id:1,kind:'tool',toolName:'image_create',live:true,activity:{phase:'running',input:{mode:'edit',prompt:'保留人物\n  调整背景光照',imageRefs:['img_1'],quality:'high'}},text:'{"mode":"edit","imageRefs":["img_1"]}',toolStream:{output:'{"status":"running"}'}}
 const ui=await createObservabilityBrowser(observabilitySnapshot({busy:true,lines:[line]}))
 try{
  const panel=ui.page.locator('.tool-observation.is-main');await panel.waitFor()
  assert.equal(await panel.locator('pre').textContent(),line.activity.input.prompt)
  assert.doesNotMatch(await panel.textContent(),/imageRefs|img_1|status|quality|\{/)
  await ui.page.locator('.tool-activity-row').click()
  const pinned=ui.page.locator('.tool-observation.is-pinned');await pinned.waitFor()
  assert.equal(await pinned.locator('pre').textContent(),line.activity.input.prompt)
  assert.deepEqual(ui.errors,[])
 }finally{await ui.close()}
})
