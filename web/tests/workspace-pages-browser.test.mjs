import assert from 'node:assert/strict'
import test from 'node:test'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createObservabilityBrowser,observabilitySnapshot} from './observability-browser-fixture.mjs'

test('scope manager keeps absolute paths, icon actions and minimal session/prompt pages at all sizes', async()=>{
 const cwd='C:\\Users\\Local\\Neo Desktop Runtime\\data\\workspaces\\261023194248';let paths=[cwd,'D:\\projects\\neoctl'];
 const fixture=await createObservabilityBrowser(observabilitySnapshot({cwd}),async route=>{
  const req=route.request(),url=new URL(req.url());
  if(url.pathname==='/api/cwd/scope'){await route.fulfill({json:{ok:true,paths}});return true}
  if(url.pathname==='/api/cwd/remove'){paths=paths.filter(p=>p!==req.postDataJSON().path);await route.fulfill({json:{ok:true,paths,cwd}});return true}
  if(url.pathname==='/api/cwd/add'){if(!paths.includes(req.postDataJSON().path))paths.push(req.postDataJSON().path);await route.fulfill({json:{ok:true,paths,cwd}});return true}
  if(url.pathname==='/api/cwd'){await route.fulfill({json:{ok:true,cwd:'D:\\projects',parent:'D:\\',entries:[{name:'new-project',path:'D:\\projects\\new-project'}],locations:[{id:'d',kind:'drive',label:'D:',path:'D:\\'}]}});return true}
  if(url.pathname==='/api/sessions'){
   const all=Array.from({length:13},(_,i)=>({sessionId:i?'session-long-identifier-'+i:'obs-session',title:i?'Review streaming code and mathematical expressions '+i:'当前会话',updatedAt:'2026-10-23T10:00:00Z'}));
   const q=(url.searchParams.get('q')||'').toLowerCase(),page=Number(url.searchParams.get('page')||1),pageSize=10;
   const matches=all.filter(s=>!q||[s.title,s.sessionId].some(v=>v.toLowerCase().includes(q)));
   await route.fulfill({json:{sessions:matches.slice((page-1)*pageSize,page*pageSize),total:matches.length,totalCount:all.length,page,pageSize}});return true
  }
  if(url.pathname==='/api/prompt-library'){await route.fulfill({json:{items:[{id:'one',title:'代码审查',content:'检查修改和回归测试',usage:'开发'}]}});return true}
 });
 try{
  const {page}=fixture;await page.locator('.composer').waitFor();
  for(const theme of ['dark','light'])for(const width of [1440,390,320]){
   await page.setViewportSize({width,height:950});await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);
   await page.getByRole('button',{name:'工作区范围',exact:true}).click();let modal=page.getByRole('dialog',{name:'工作区范围',exact:true});
   await modal.locator('.workspace-scope-path').first().waitFor();
   assert.deepEqual(await modal.locator('.workspace-scope-path > span').allTextContents(),paths);
   assert.ok(await modal.evaluate(el=>el.scrollWidth<=el.clientWidth+1));
   const rows=await modal.locator('.workspace-scope-path').evaluateAll(rows=>rows.map(row=>{const r=[...row.children].map(el=>el.getBoundingClientRect());return Math.max(...r.map(x=>(x.top+x.bottom)/2))-Math.min(...r.map(x=>(x.top+x.bottom)/2))}));for(const delta of rows)assert.ok(delta<=1);
   assert.ok((await modal.locator('button').allTextContents()).every(v=>!v.trim()));
   await modal.screenshot({path:join(tmpdir(),`neo-workspace-scope-${theme}-${width}.png`)});
   await modal.getByRole('button',{name:'添加路径',exact:true}).click();const picker=page.getByRole('dialog',{name:'选择工作目录',exact:true});await picker.locator('.cwd-tree-row').first().waitFor();await page.keyboard.press('Escape');await modal.waitFor();await page.keyboard.press('Escape');
   assert.equal(await page.locator('body').evaluate(el=>el.classList.contains('cwd-picker-lock')),false);
   if(width<=760){await page.locator('.mobile-nav-menu > summary').click();await page.locator('.mobile-nav-menu nav').getByRole('button',{name:'会话',exact:true}).click()}
   else await page.locator('.sidebar').getByRole('button',{name:'会话管理',exact:true}).click();
   await page.locator('.session-card').first().waitFor();assert.ok((await page.locator('.session-actions button').allTextContents()).every(v=>!v.trim()));
   assert.equal(await page.locator('.sessions-page-head p').count(),0);
   assert.ok(await page.locator('.sessions-page').evaluate(el=>el.scrollWidth<=el.clientWidth+1));
   await page.screenshot({path:join(tmpdir(),`neo-sessions-minimal-${theme}-${width}.png`)});
   if(width<=760){await page.locator('.mobile-nav-menu > summary').click();await page.locator('.mobile-nav-menu nav').getByRole('button',{name:'提示词',exact:true}).click()}
   else {
    assert.equal(await page.locator('.prompt-stack').count(),0);
    await page.locator('.quick-session[aria-current="true"]').click();
    continue;
   }
   await page.locator('.prompt-editor-panel').waitFor();assert.ok((await page.locator('.prompt-editor-toolbar-actions button').allTextContents()).every(v=>!v.trim()));
   await page.screenshot({path:join(tmpdir(),`neo-prompts-minimal-${theme}-${width}.png`)});
   await page.getByRole('button',{name:'回到对话',exact:true}).click();
  }
  await page.getByRole('button',{name:'工作区范围',exact:true}).click();let modal=page.getByRole('dialog',{name:'工作区范围',exact:true});await modal.locator('.workspace-scope-path').first().waitFor();
  await modal.getByRole('button',{name:'移除 '+cwd,exact:true}).click();await page.waitForTimeout(100);assert.deepEqual(await modal.locator('.workspace-scope-path > span').allTextContents(),['D:\\projects\\neoctl']);
  await modal.getByRole('button',{name:'添加路径',exact:true}).click();const picker=page.getByRole('dialog',{name:'选择工作目录',exact:true});await picker.locator('.cwd-tree-row').first().waitFor();await picker.getByRole('button',{name:'new-project',exact:true}).click();await picker.getByRole('button',{name:'选择',exact:true}).click();await modal.waitFor();assert.deepEqual(await modal.locator('.workspace-scope-path > span').allTextContents(),['D:\\projects\\neoctl','D:\\projects\\new-project']);
  assert.deepEqual(fixture.errors,[]);assert.ok(!fixture.requests.some(r=>/cwd\/(change|delete)/.test(r.url)));
 }finally{await fixture.close()}
})
