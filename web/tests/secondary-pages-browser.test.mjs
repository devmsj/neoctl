import assert from 'node:assert/strict'
import test from 'node:test'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createObservabilityBrowser,observabilitySnapshot} from './observability-browser-fixture.mjs'

test('admin users preserve roles with aligned icon controls in dark/light and narrow layouts',async()=>{
 const f=await createObservabilityBrowser(observabilitySnapshot(),async route=>{
  const p=new URL(route.request().url()).pathname;
  if(p==='/api/auth/status'){await route.fulfill({json:{isolation:true,user:{username:'Admin',role:'admin'}}});return true}
  if(p==='/api/admin/users'){await route.fulfill({json:{users:[{username:'Admin',role:'admin'},{username:'Local reviewer',role:'user'}]}});return true}
 });
 try{
  const {page}=f;await page.locator('.sidebar .nav').getByRole('button',{name:'用户管理',exact:true}).click();await page.locator('.admin-user-list .session-card').first().waitFor();
  for(const theme of ['dark','light'])for(const width of [1440,390,320]){
   await page.setViewportSize({width,height:950});await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);
   assert.ok(await page.locator('.admin-users-page').evaluate(el=>el.scrollWidth<=el.clientWidth+1));
   assert.ok((await page.locator('.admin-users-page button').allTextContents()).every(t=>!t.trim()));
   await page.screenshot({path:join(tmpdir(),`neo-users-minimal-${theme}-${width}.png`)});
  }assert.deepEqual(f.errors,[]);assert.ok(f.requests.every(r=>r.method==='GET'));
 }finally{await f.close()}
})

test('login retains icon-only layout and one input focus border at desktop and mobile sizes',async()=>{
 const f=await createObservabilityBrowser({},async route=>{if(new URL(route.request().url()).pathname==='/api/auth/status'){await route.fulfill({json:{isolation:true,user:null}});return true}});
 try{
  const {page}=f;await page.getByRole('form',{name:'用户登录'}).waitFor();
  for(const width of [1440,390,320]){
   await page.setViewportSize({width,height:950});await page.getByRole('textbox',{name:'用户名'}).focus();
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
   assert.equal(await page.locator('#auth-username').evaluate(el=>getComputedStyle(el).boxShadow),'none');
   assert.equal((await page.locator('.auth-card').innerText()).trim(),'');
   await page.screenshot({path:join(tmpdir(),`neo-login-review-${width}.png`)});
  }assert.deepEqual(f.errors,[]);
 }finally{await f.close()}
})
