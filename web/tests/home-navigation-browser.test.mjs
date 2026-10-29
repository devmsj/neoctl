import {emptyAppearance} from '../shared/appearance.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import {fileURLToPath} from 'node:url'
import {createObservabilityBrowser,observabilitySnapshot} from './observability-browser-fixture.mjs'

test('settings and session manager entries return home without reopening or replacing the current session',async()=>{
 const f=await createObservabilityBrowser(observabilitySnapshot({lines:[{id:1,kind:'user',text:'保留当前对话'}]}),async route=>{if(new URL(route.request().url()).pathname==='/api/appearance'){await route.fulfill({json:{config:emptyAppearance(),revision:'0'}});return true}});const p=f.page
 try{
  await p.locator('.composer textarea').waitFor()
  await p.evaluate(()=>{window.__TAURI_INTERNALS__={invoke:async()=>false}})
  await p.addScriptTag({path:fileURLToPath(new URL('../../desktop/ui/window-chrome.js',import.meta.url))})
  const chrome=p.locator('neo-window-chrome')
  await p.locator('.composer textarea').fill('未发送草稿')
  await chrome.getByRole('button',{name:'全局配置',exact:true}).click()
  await chrome.getByRole('button',{name:'返回对话',exact:true}).waitFor()
  await p.getByRole('button',{name:'外观',exact:true}).click()
  await p.getByRole('button',{name:'设计外观',exact:true}).click()
  await p.getByRole('button',{name:'颜色',exact:true}).click()
  await p.locator('#appearance-accent').fill('#287b82')
  await chrome.getByRole('button',{name:'返回对话',exact:true}).click()
  await p.getByRole('alertdialog').waitFor()
  await p.getByRole('button',{name:'继续编辑',exact:true}).click()
  assert.ok(await p.locator('.appearance-editor').isVisible())
  await chrome.getByRole('button',{name:'返回对话',exact:true}).click()
  await p.getByRole('button',{name:'放弃',exact:true}).click()
  await p.locator('.composer textarea').waitFor()
  assert.equal(await p.locator('.composer textarea').inputValue(),'未发送草稿')
  await chrome.getByRole('button',{name:'全局配置',exact:true}).waitFor()
  const quick=p.locator('.quick-actions')
  await quick.getByRole('button',{name:'会话管理',exact:true}).click()
  await p.locator('.sessions-page').waitFor()
  const home=quick.getByRole('button',{name:'返回对话',exact:true});await home.waitFor()
  assert.match(await home.locator('path').getAttribute('d'),/m2 9/)
  const before=f.requests.length
  await home.click();await p.locator('.composer textarea').waitFor()
  assert.equal(await p.locator('.composer textarea').inputValue(),'未发送草稿')
  assert.equal(f.requests.slice(before).filter(x=>x.url.includes('/api/state')).length,0)
  assert.ok(await quick.getByRole('button',{name:'会话管理',exact:true}).isVisible())
  assert.deepEqual(f.errors,[])
 }finally{await f.close()}
})
