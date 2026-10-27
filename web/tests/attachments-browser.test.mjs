import assert from 'node:assert/strict'
import { createObservabilityBrowser, observabilitySnapshot } from './observability-browser-fixture.mjs'
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
const files=[{kind:'file',name:'报告.txt',size:1234,mimeType:'text/plain',absolutePath:'C:\\report.txt',url:'/api/message-files/user1/0'}]
const snapshot=observabilitySnapshot({lines:[
  {id:1,kind:'user',text:'检查附件',messageId:'user1',files},
  {id:2,kind:'user',text:'图片说明\n\n[img#1]',messageId:'user2',image:{imageId:'image_stable',label:'[img#1]',mimeType:'image/png',src:'/api/images/by-id/image_stable',available:true,sizeBytes:68}},
  {id:3,kind:'tool',toolName:'expose_downloads',text:'ready',resources:[{kind:'download',label:'成品.txt',downloadName:'成品.txt',sizeBytes:2048,url:'/api/download-test',reference:'neo://download/test'}]},
  {id:4,kind:'assistant',text:'[成品](neo://download/test) · [网站](https://example.com)',format:'markdown'},
]})
const fixture=await createObservabilityBrowser(()=>snapshot,async route=>{
 const url=new URL(route.request().url())
 if(url.pathname.startsWith('/api/images/')){await route.fulfill({contentType:'image/png',body:Buffer.from(png,'base64'),headers:{'X-Neo-Resource-Path':encodeURIComponent('C:\\image.png')}});return true}
 if(url.pathname.startsWith('/api/message-files/')||url.pathname==='/api/download-test'){await route.fulfill({contentType:'application/octet-stream',body:'file',headers:{'X-Neo-Resource-Path':encodeURIComponent('C:\\report.txt')}});return true}
 return false
})
const {page}=fixture
try {
 await page.locator('.message-file-attachment').waitFor()
 assert.equal(await page.locator('.message-file-attachment').count(),1)
 assert.equal(await page.locator('.message-image-attachment img').count(),1)
 async function checkMinimalAttachments(){
  const file=page.locator('.message-file-attachment')
  assert.equal(await file.innerText(),'报告.txt')
  assert.equal(await file.evaluate(el=>el.tagName),'SPAN')
  assert.equal(await file.getAttribute('href'),null)
  assert.equal(await file.getAttribute('tabindex'),null)
  assert.equal(await file.locator('svg, a, button').count(),0)
  const style=await file.evaluate(el=>({border:getComputedStyle(el).borderWidth,background:getComputedStyle(el).backgroundColor,color:getComputedStyle(el).color,body:getComputedStyle(document.querySelector('.message-text')).color}))
  assert.equal(style.border,'0px');assert.equal(style.background,'rgba(0, 0, 0, 0)');assert.notEqual(style.color,style.body)
  const images=page.locator('.chat-image-thumbnails')
  const body=images.locator('..').locator('.message-text')
  assert.equal(await body.textContent(),'图片说明')
  const gap=await images.evaluate(el=>el.getBoundingClientRect().top-el.previousElementSibling.getBoundingClientRect().bottom)
  assert.ok(gap>=0 && gap<=12,`Unexpected thumbnail gap: ${gap}`)
  assert.equal(await images.locator('figcaption, a, .attachment-size').count(),0)
  assert.equal((await images.innerText()).trim(),'')
  for(const selector of ['figure','.image-preview-trigger']){
   const style=await images.locator(selector).evaluate(el=>({border:getComputedStyle(el).borderWidth,shadow:getComputedStyle(el).boxShadow,background:getComputedStyle(el).backgroundColor}))
   assert.equal(style.border,'0px');assert.equal(style.shadow,'none');assert.equal(style.background,'rgba(0, 0, 0, 0)')
  }
  await images.locator('img').evaluate(async el=>{await el.decode()})
  await images.locator('.image-preview-trigger').click()
  await page.locator('.image-preview-modal img').waitFor()
  assert.match(await page.locator('.image-preview-modal img').getAttribute('src'),/image_stable/)
  await page.locator('.image-preview-close').click()
  assert.equal(await page.locator('.image-preview-modal').count(),0)
 }
 await checkMinimalAttachments()
 await page.reload();await page.locator('.message-file-attachment').waitFor()
 assert.equal(await page.locator('.message-image-attachment img').count(),1)
 await checkMinimalAttachments()
 for(const theme of ['light','dark']){
  await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme)
  await page.setViewportSize({width:480,height:800})
  await checkMinimalAttachments()
 }
 await page.setViewportSize({width:1180,height:760})
 const downloads=[];page.on('download',d=>downloads.push(d))
 await page.locator('.message-file-attachment').click();await page.waitForTimeout(150);assert.equal(downloads.length,0)
 await page.addInitScript(()=>{
  window.nativeCalls=[];window.__TAURI__={core:{invoke:async(command,args)=>{window.nativeCalls.push({command,args});return []},Channel:class{constructor(){this.id=1}}}}
 })
 await page.reload();await page.locator('.message-file-attachment').waitFor()
 await checkMinimalAttachments()
 await page.locator('.message-file-attachment').click();await page.waitForTimeout(150)
 assert.equal(await page.evaluate(()=>window.nativeCalls.filter(c=>c.command.endsWith('|reveal_file')).length),0)
 await page.locator('a.inline-resource-download').click()
 await page.waitForFunction(()=>window.nativeCalls.some(c=>c.command.endsWith('|reveal_file')))
 await page.getByRole('link',{name:'网站',exact:true}).click()
 await page.waitForFunction(()=>window.nativeCalls.some(c=>c.command.endsWith('|open_external')))
 const style=await page.locator('a.inline-resource-download').evaluate(el=>({decoration:getComputedStyle(el).textDecorationLine,opacity:getComputedStyle(el,'::after').opacity,icon:getComputedStyle(el,'::before').maskImage,text:getComputedStyle(el,'::after').content}))
 assert.equal(style.decoration,'none');assert.equal(style.opacity,'1');assert.match(style.icon,/svg/);assert.doesNotMatch(style.text,/打开/);assert.match(style.text,/KB|B/ )
 // Wrong MIME and extension use actual pixels; malformed images never enter the composer.
 await page.locator('input[type=file]').setInputFiles({name:'wrong.jpg',mimeType:'image/jpeg',buffer:Buffer.from(png,'base64')})
 await page.locator('.image-attachment img').waitFor()
 assert.equal(await page.locator('.image-attachment img').count(),1)
 await page.locator('input[type=file]').setInputFiles({name:'broken.png',mimeType:'image/png',buffer:Buffer.from('<html>not image</html>')})
 await page.waitForTimeout(200)
 assert.equal(await page.locator('.image-attachment img').count(),1)
 assert.deepEqual(fixture.errors,[])
 console.log('PASS attachments: reload, borderless thumbnails and preview, inert filenames, generated resource actions, MIME correction and rejected fake PNG')
} finally {await fixture.close()}
