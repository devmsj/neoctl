import test from 'node:test'
import assert from 'node:assert/strict'
import { createObservabilityBrowser, observabilitySnapshot } from './observability-browser-fixture.mjs'

const text='auth_unavailable: no auth available\n'+Array.from({length:90},(_,i)=>`详细信息 ${i} https://example.com/${'path'.repeat(35)}`).join('\n')+'\n末尾完整信息 <script>not executable</script>'
test('system notices stay expanded full-width, accent colored, themed radius and internally scrollable',async()=>{
 const f=await createObservabilityBrowser(observabilitySnapshot({lines:[{id:1,kind:'tool',toolName:'file_read',text:'read'},{id:2,kind:'system',title:'System',text,format:'plain',previewStyle:'summary'},{id:3,kind:'error',text:'另一条错误',format:'plain'},{id:4,kind:'tool',toolName:'file_write',text:'write'}]}));const p=f.page
 try{
  await p.locator('.system-notice').first().waitFor()
  assert.equal(await p.locator('.system-notice').count(),2)
  const notice=p.locator('.system-notice').first(),content=notice.locator('.system-notice-content')
  assert.equal(await content.textContent(),text)
  assert.equal(await notice.locator('details,summary,.message-marker,.message-head,script').count(),0)
  await p.evaluate(()=>document.documentElement.style.setProperty('--appearance-radius','13px'))
  assert.equal(await notice.evaluate(el=>getComputedStyle(el).borderRadius),'13px')
  const colors=await notice.evaluate(el=>{const probe=document.createElement('span');probe.style.color='var(--chrome-accent)';el.append(probe);const accent=getComputedStyle(probe).color;probe.remove();return{accent,text:getComputedStyle(el.querySelector('.system-notice-content')).color,icon:getComputedStyle(el.querySelector('svg')).color}})
  assert.equal(colors.text,colors.accent);assert.equal(colors.icon,colors.accent)
  const old=colors.text;await p.evaluate(()=>document.documentElement.style.setProperty('--chrome-accent','#3b8b78'));assert.notEqual(await content.evaluate(el=>getComputedStyle(el).color),old)
  assert.ok(await content.evaluate(el=>el.scrollHeight>el.clientHeight+100))
  await content.evaluate(el=>el.scrollTop=el.scrollHeight);assert.ok(await content.evaluate(el=>el.scrollTop>0))
  for(const width of [1440,1180,820,390]){
   await p.setViewportSize({width,height:820});await notice.scrollIntoViewIfNeeded()
   const box=await notice.boundingBox(),row=await notice.locator('..').boundingBox()
   assert.ok(Math.abs(box.x-row.x)<1&&Math.abs(box.width-row.width)<1)
   assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
  }
  assert.deepEqual(f.errors,[])
 }finally{await f.close()}
})

test('slash-prefixed composer text no longer navigates to system command pages',async()=>{
 const submitted=[];const f=await createObservabilityBrowser(observabilitySnapshot(),async route=>{if(new URL(route.request().url()).pathname!=='/api/submit')return;submitted.push(route.request().postDataJSON().text);await route.fulfill({json:{ok:true}});return true})
 try{
  const input=f.page.getByRole('textbox',{name:'消息',exact:true});await input.waitFor()
  for(const command of ['/new','/sessions','/login','/help','/reset']){
   await input.fill(command);await Promise.all([f.page.waitForResponse(r=>new URL(r.url()).pathname==='/api/submit'),input.press('Enter')])
   assert.equal(await f.page.locator('.composer').isVisible(),true)
  }
  assert.deepEqual(submitted,['/new','/sessions','/login','/help','/reset']);assert.deepEqual(f.errors,[])
 }finally{await f.close()}
})
