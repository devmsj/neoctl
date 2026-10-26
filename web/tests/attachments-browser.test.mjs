import assert from 'node:assert/strict'
import { createObservabilityBrowser, observabilitySnapshot } from './observability-browser-fixture.mjs'
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
const files=[{kind:'file',name:'报告.txt',size:1234,mimeType:'text/plain',absolutePath:'C:\\report.txt',url:'/api/message-files/user1/0'}]
const snapshot=observabilitySnapshot({lines:[
  {id:1,kind:'user',text:'检查附件',messageId:'user1',files},
  {id:2,kind:'user',text:'[img#1]',messageId:'user1',image:{imageId:'image_stable',label:'[img#1]',mimeType:'image/png',src:'/api/images/by-id/image_stable',available:true,sizeBytes:68}},
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
 assert.match(await page.locator('.message-file-attachment').innerText(),/报告.txt[\s\S]*1.2 KB[\s\S]*下载/)
 await page.reload();await page.locator('.message-file-attachment').waitFor()
 assert.equal(await page.locator('.message-image-attachment img').count(),1)
 const event=page.waitForEvent('download');await page.locator('.message-file-attachment').click();assert.equal((await event).suggestedFilename(),'报告.txt')
 await page.addInitScript(()=>{
  window.nativeCalls=[];window.__TAURI__={core:{invoke:async(command,args)=>{window.nativeCalls.push({command,args});return []},Channel:class{constructor(){this.id=1}}}}
 })
 await page.reload();await page.locator('.message-file-attachment').waitFor()
 assert.doesNotMatch(await page.locator('.message-file-attachment').innerText(),/打开/)
 assert.match(await page.locator('.message-file-attachment').getAttribute('title'),/打开所在文件夹/)
 assert.equal(await page.locator('.attachment-file-action svg').count(),1)
 const cardStyle=await page.locator('.message-file-attachment').evaluate(el=>({height:el.getBoundingClientRect().height,shadow:getComputedStyle(el).boxShadow,radius:getComputedStyle(el).borderRadius}))
 assert.ok(cardStyle.height<=44);assert.equal(cardStyle.shadow,'none');assert.equal(cardStyle.radius,'6px')
 await page.locator('.message-file-attachment').click()
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
 console.log('PASS attachments: reload, thumbnail, file download, desktop open/external link, visible size/SVG, MIME correction and rejected fake PNG')
} finally {await fixture.close()}
