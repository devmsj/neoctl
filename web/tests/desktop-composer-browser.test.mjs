import test from 'node:test'
import assert from 'node:assert/strict'
import { createObservabilityBrowser, observabilitySnapshot } from './observability-browser-fixture.mjs'
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=='

test('desktop directory drops append paths; click and Enter queue; queued attachments stay minimal after reload', async()=>{
 const snapshot=observabilitySnapshot({busy:true,runControl:{state:'running',canPause:true,canResume:false}})
 const submissions=[]
 const ui=await createObservabilityBrowser(()=>snapshot,async route=>{
  const url=new URL(route.request().url()),p=url.pathname
  if(p==='/api/submit'){
   const body=route.request().postDataJSON();submissions.push(body)
   snapshot.queuedInput=body.text;snapshot.queuedAttachments=body.attachments.map(a=>a.kind==='image'?{kind:'image',imageId:a.imageId,previewUrl:'/api/queue/images/'+a.imageId}:{kind:'file',name:a.name})
   await route.fulfill({json:{ok:true}});return true
  }
  if(p.startsWith('/api/queue/images/')){await route.fulfill({contentType:'image/png',body:Buffer.from(png,'base64')});return true}
  return false
 })
 try{
  const {page}=ui
  await page.addInitScript(()=>{
   window.__TAURI__={core:{Channel:class{constructor(){this.id=1;window.dropChannel=this}},invoke:async(cmd)=>cmd.endsWith('take_file_drop')?window.dropItems:undefined}}
  })
  await page.reload()
  const input=page.getByRole('textbox',{name:'消息',exact:true})
  await input.fill('保留原文')
  await page.waitForFunction(()=>window.dropChannel?.onmessage)
  await page.evaluate(async()=>{
   window.dropItems=[{kind:'directory',name:'资料',absolutePath:'C:\\资料 项目'},{kind:'directory',name:'第二个',absolutePath:'D:\\第二个'}]
   const r=document.querySelector('.composer textarea').getBoundingClientRect()
   await window.dropChannel.onmessage({type:'drop',id:1,position:{x:(r.x+20)*devicePixelRatio,y:(r.y+20)*devicePixelRatio}})
  })
  assert.equal(await input.inputValue(),'保留原文\nC:\\资料 项目\nD:\\第二个')
  assert.equal(await page.locator('.attachment-file').count(),0)
  assert.equal(ui.requests.filter(r=>new URL(r.url).pathname.startsWith('/api/uploads')).length,0)
  await page.getByRole('button',{name:'加入队列 ↵',exact:true}).click()
  await page.waitForFunction(()=>document.querySelector('.composer textarea').value==='')
  assert.equal(submissions.length,1)
  await input.fill('回车排队')
  await page.getByRole('button',{name:'加入队列 ↵',exact:true}).waitFor()
  await input.press('Enter');await page.waitForTimeout(120)
  assert.equal(submissions.length,2)
  assert.equal(ui.requests.filter(r=>/submit-now|queue\/send-now|interrupt/.test(r.url)).length,0)
  snapshot.queuedInput='第一行\n  第二行\n\n[img#7]'
  snapshot.queuedAttachments=[{kind:'image',imageId:'image_11111111-1111-4111-a111-111111111111',previewUrl:'/api/queue/images/image_11111111-1111-4111-a111-111111111111'},{kind:'file',name:'资料.txt'}]
  await page.reload()
  const queue=page.locator('.queued-message');await queue.locator('img').waitFor()
  assert.equal(await queue.locator('.queued-message-text').textContent(),'第一行\n  第二行')
  assert.doesNotMatch(await queue.textContent(),/img#|file#|image_111|大小|打开/)
  assert.equal(await queue.locator('.message-file-attachment').textContent(),'资料.txt')
  assert.equal(await queue.locator('.message-file-attachment').evaluate(el=>el.tagName),'SPAN')
  assert.equal(await queue.locator('.image-preview-trigger').evaluate(el=>getComputedStyle(el).borderWidth),'0px')
  await queue.locator('.image-preview-trigger').click()
  await page.locator('.image-preview-modal').waitFor()
  assert.deepEqual(ui.errors,[])
 }finally{await ui.close()}
})

test('sidebar keeps running marks across switches and removes them when background runs finish',async()=>{
 let running=['obs-session','other']
 const ui=await createObservabilityBrowser(observabilitySnapshot(),async route=>{
  const url=new URL(route.request().url())
  if(url.pathname==='/api/sessions/running'){await route.fulfill({json:{runningSessionIds:running}});return true}
  if(url.pathname==='/api/sessions'){await route.fulfill({json:{sessions:[{sessionId:'obs-session',title:'First'},{sessionId:'other',title:'Other'}],total:2,totalPages:1,page:1}});return true}
  if(url.pathname==='/api/state'){const id=url.searchParams.get('sessionId')||'obs-session';await route.fulfill({json:observabilitySnapshot({session:{sessionId:id,title:id==='other'?'Other':'First'}})});return true}
  return false
 })
 try{
  const {page}=ui
  await page.waitForFunction(()=>document.querySelectorAll('.quick-running').length===2)
  await page.locator('.quick-session').filter({hasText:'Other'}).click()
  await page.waitForFunction(()=>document.querySelector('.quick-session[aria-current="true"]')?.textContent.includes('Other'))
  assert.equal(await page.locator('.quick-running').count(),2)
  running=[]
  await page.waitForFunction(()=>document.querySelectorAll('.quick-running').length===0)
  assert.equal(ui.requests.filter(r=>new URL(r.url).pathname==='/api/sessions').length,1,'status refresh must not reload/prewarm the list')
  assert.deepEqual(ui.errors,[])
 }finally{await ui.close()}
})
