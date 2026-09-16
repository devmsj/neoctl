import assert from 'node:assert/strict'
import { createObservabilityBrowser, observabilitySnapshot } from './observability-browser-fixture.mjs'
let snapshot=observabilitySnapshot(), payloads=[], expired=false
const fixture=await createObservabilityBrowser(()=>snapshot,async route=>{
  const pathname=new URL(route.request().url()).pathname
  if(!pathname.startsWith('/api/obs10-')) return false
  if(pathname.includes('slow')) await new Promise(r=>setTimeout(r,500))
  if(pathname.includes('missing') || (expired && pathname.includes('original0'))) {await route.fulfill({status:404,body:'missing'});return true}
  const index=pathname.includes('original1')?1:pathname.includes('original2')?2:pathname.includes('thumb')?3:0
  const data=payloads[index]
  if(pathname.includes('bad')) await route.fulfill({contentType:'image/png',body:'broken'})
  else await route.fulfill({contentType:data.mime,body:Buffer.from(data.base64,'base64'),headers:{'Cache-Control':'no-store'}})
  return true
})
const {page}=fixture
try {
  payloads=await page.evaluate(()=>['image/png','image/jpeg','image/webp','image/png'].map((mime,i)=>{
    const c=document.createElement('canvas');c.width=i===3?2:31+i;c.height=i===3?1:17+i;c.getContext('2d').fillRect(0,0,c.width,c.height)
    return {mime,base64:c.toDataURL(mime).split(',')[1]}
  }))
  const image=(id,src,available=true)=>({imageId:id,label:id,thumbnailSrc:'/api/obs10-thumb',originalSrc:src,available})
  const line=(id,size,images)=>({id,kind:'tool',toolName:'image_create',toolUseId:`call-${id}`,messageId:`message-${id}`,title:'图片',titleStatus:'success',text:`Generated ${images.length} images\nprovider: openai model: gpt-image-2 prompt: test mode: generate size: ${size} quality: high outputFormat: png background: auto returnedImages: ${images.length} duration: 1ms`,images,toolDisplay:{purpose:'图片目的',facts:[],previews:[]}})
  const main=line(1,'1024x1024',[image('png','/api/obs10-original0'),image('jpeg','/api/obs10-original1'),image('webp','/api/obs10-original2'),image('bad','/api/obs10-bad'),image('missing','/api/obs10-missing'),image('unavailable','/api/obs10-never',false),{imageId:'thumbnail-only',thumbnailSrc:'/api/obs10-thumb',available:true}])
  const auto=line(2,'auto',[image('auto','/api/obs10-original1')])
  snapshot=observabilitySnapshot({lines:[main,auto]})
  await page.addInitScript(()=>{
    window.EventSource=class { constructor(){window.obs10Events=this;this.listeners={}} addEventListener(name,fn){this.listeners[name]=fn} close(){} }
    window.obs10Sync=s=>window.obs10Events.listeners.sync({data:JSON.stringify(s)})
  })
  await page.reload()
  const open=async(index=0)=>{await page.locator('.image2-result-shell .image2-detail-button').nth(index).click();await page.locator('[data-original-dimensions="0"]').waitFor()}
  const rows=()=>page.locator('[data-original-dimensions]')
  await open()
  await page.getByText('31 × 17',{exact:true}).waitFor()
  assert.match(await rows().nth(0).innerText(),/请求尺寸\s+1024x1024[\s\S]*实际尺寸\s+31 × 17/)
  assert.match(await rows().nth(0).innerText(),/实际尺寸与请求尺寸不同/)
  await page.getByText('32 × 18',{exact:true}).waitFor();await page.getByText('33 × 19',{exact:true}).waitFor()
  for(const i of [3,4,6]) {await page.waitForFunction(i=>document.querySelector(`[data-original-dimensions="${i}"]`)?.textContent.includes('未知'),i)}
  assert.match(await rows().nth(5).innerText(),/不可获取/)
  assert.equal(fixture.requests.some(r=>r.url.includes('obs10-never')),false)
  await page.keyboard.press('Escape')
  const preview=page.locator('.image2-result-shell .image-preview-trigger').first()
  assert.match(await preview.getAttribute('data-preview-src'),/obs10-original0/)
  assert.match(await preview.locator('img').getAttribute('src'),/obs10-thumb/)
  await preview.click();await page.locator('.image-preview-modal').waitFor();await page.keyboard.press('Escape')
  const downloadEvent=page.waitForEvent('download');await page.locator('.image2-result-shell .image-download').first().click();const download=await downloadEvent;assert.ok(download.suggestedFilename())
  await open(1);await page.getByText('32 × 18',{exact:true}).waitFor();assert.match(await rows().first().innerText(),/auto（自动策略）/);assert.doesNotMatch(await rows().first().innerText(),/与请求尺寸不同/)
  await page.keyboard.press('Escape')
  expired=true;await open();await page.waitForFunction(()=>document.querySelector('[data-original-dimensions="0"]')?.textContent.includes('未知'));assert.doesNotMatch(await rows().first().innerText(),/31 × 17/)
  await page.keyboard.press('Escape')
  // Keep call IDs identical while changing session and URL during an old pending decode.
  snapshot=observabilitySnapshot({lines:[line(1,'1024x1024',[image('slow','/api/obs10-slow')])]})
  await page.evaluate(s=>window.obs10Sync(s),snapshot);await open()
  snapshot=observabilitySnapshot({session:{sessionId:'other-session',title:'Other'},lines:[line(1,'auto',[image('new','/api/obs10-original2')])]})
  await page.keyboard.press('Escape')
  await page.locator('.nav button').first().click() // Real UI session change; do not bypass binding guard.
  await page.waitForTimeout(150)
  await open()
  await page.getByText('33 × 19',{exact:true}).waitFor();await page.waitForTimeout(650)
  assert.doesNotMatch(await rows().first().innerText(),/31 × 17/)
  assert.deepEqual(fixture.errors,[])
  assert.equal(fixture.requests.some(r=>r.method!=='GET'),false)
  console.log('OBS10 actual App Edge PASS: requested/actual, auto, PNG/JPEG/WebP, thumbnail-only unknown, bad/404/unavailable, expired reopen, cross-session late isolation, preview/download preserved')
} finally {await fixture.close()}
