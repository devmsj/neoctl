import test from 'node:test'
import assert from 'node:assert/strict'
import { createObservabilityBrowser, observabilitySnapshot } from './observability-browser-fixture.mjs'

test('session context menu confirms deletion without navigation and allows current and protects running sessions', async () => {
  let items=[{sessionId:'obs-session',title:'Current'},{sessionId:'running',title:'Running'},{sessionId:'delete-me',title:'Delete me'},{sessionId:'keep',title:'Keep'}]
  const deleted=[]
  const f=await createObservabilityBrowser(observabilitySnapshot({runningSessionIds:['running']}),async route=>{
    const url=new URL(route.request().url())
    if(url.pathname==='/api/sessions'){await route.fulfill({json:{sessions:items,total:items.length,page:1,totalPages:1,runningSessionIds:['running']}});return true}
    if(url.pathname==='/api/sessions/delete'){const id=route.request().postDataJSON().sessionId;deleted.push(id);items=items.filter(i=>i.sessionId!==id);await route.fulfill({json:{ok:true}});return true}
    return false
  },{viewport:{width:1180,height:760}})
  try{
    const p=f.page, menu=p.getByRole('menu',{name:'会话操作'}),remove=p.getByRole('menuitem',{name:'删除',exact:true})
    await p.locator('.quick-session').nth(3).waitFor()
    const nativePrevented=()=>p.evaluate(()=>{const event=new MouseEvent('contextmenu',{bubbles:true,cancelable:true});document.body.dispatchEvent(event);return event.defaultPrevented})
    assert.equal(await nativePrevented(),false,'ordinary web context menu is unchanged')
    await p.evaluate(()=>{window.__TAURI__={core:{invoke:async()=>{}}}})
    assert.equal(await nativePrevented(),true,'desktop default Edge menu is prevented')
    await p.locator('.quick-session[aria-current="true"]').click({button:'right'})
    await menu.waitFor();assert.equal(await remove.getAttribute('aria-disabled'),'false')
    await p.keyboard.press('Escape');await menu.waitFor({state:'detached'})
    await p.locator('.quick-session').filter({hasText:'Running'}).click({button:'right'})
    assert.equal(await remove.getAttribute('aria-disabled'),'true')
    await p.mouse.click(700,100);await menu.waitFor({state:'detached'})
    await p.locator('.quick-session').filter({hasText:'Delete me'}).click({button:'right'})
    assert.equal(await remove.getAttribute('aria-disabled'),'false')
    await remove.click();const dialog=p.getByRole('alertdialog');await dialog.waitFor()
    await dialog.getByRole('button',{name:'取消',exact:true}).click();assert.deepEqual(deleted,[])
    await p.locator('.quick-session').filter({hasText:'Delete me'}).focus();await p.keyboard.press('Shift+F10')
    await menu.waitFor();await remove.click();await dialog.getByRole('button',{name:'确认删除',exact:true}).click()
    await p.waitForFunction(()=>document.querySelectorAll('.quick-session').length===3)
    assert.deepEqual(deleted,['delete-me']);assert.equal(await p.locator('.sessions-page').count(),0)
    await p.getByRole('button',{name:'会话管理',exact:true}).first().click()
    await p.locator('.session-card-title').last().waitFor()
    await p.locator('.session-card-title').last().dispatchEvent('contextmenu',{clientX:1178,clientY:758,bubbles:true,cancelable:true})
    await menu.waitFor();const box=await menu.boundingBox();assert.ok(box.x+box.width<=1172 && box.y+box.height<=752)
    await p.locator('.session-card-title').last().dispatchEvent('scroll')
    await menu.waitFor({state:'detached'})
    assert.deepEqual(f.errors,[])
  }finally{await f.close()}
})

test('current-session deletion confirms, recovers a failure, then opens the replacement without resuming the deleted id',async()=>{
 let snapshot=observabilitySnapshot({session:{sessionId:'obs-session',title:'Current'}}), fail=true, deletes=0;
 const f=await createObservabilityBrowser(()=>snapshot,async route=>{
  const path=new URL(route.request().url()).pathname;
  if(path==='/api/sessions'){await route.fulfill({json:{sessions:[snapshot.session],total:1,page:1,totalPages:1}});return true}
  if(path==='/api/sessions/delete'){
   deletes++;
   if(fail){await route.fulfill({json:{ok:false,error:'permission denied'}});return true}
   snapshot=observabilitySnapshot({session:{sessionId:'replacement',title:'New session'}});
   await route.fulfill({json:{ok:true,replacementSessionId:'replacement'}});return true
  }
  return false
 });
 try{
  const p=f.page, item=p.locator('.quick-session[aria-current="true"]'), dialog=p.getByRole('alertdialog');
  const open=async()=>{await item.click({button:'right'});await p.getByRole('menuitem',{name:'删除',exact:true}).click();await dialog.waitFor()};
  await item.waitFor();await open();assert.match(await dialog.innerText(),/删除后将打开新会话/);
  await dialog.getByRole('button',{name:'取消',exact:true}).click();assert.equal(deletes,0);
  await open();await dialog.getByRole('button',{name:'确认删除',exact:true}).click();
  await p.getByText('permission denied',{exact:false}).first().waitFor();assert.match(await item.innerText(),/Current/);
  fail=false;await open();await dialog.getByRole('button',{name:'确认删除',exact:true}).click();
  await p.waitForFunction(()=>document.querySelector('.quick-session[aria-current="true"]')?.textContent.includes('New session'));
  assert.equal(deletes,2);assert.ok(f.requests.some(r=>r.url.includes('/api/state')&&r.url.includes('replacement')));
  assert.equal(f.requests.filter(r=>r.url.includes('/api/sessions/resume')).length,0);assert.deepEqual(f.errors,[]);
 }finally{await f.close()}
});
