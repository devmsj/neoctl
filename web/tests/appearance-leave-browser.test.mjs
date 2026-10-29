import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createObservabilityBrowser, observabilitySnapshot } from './observability-browser-fixture.mjs'
import { openGlobalSettings } from './settings-navigation.mjs'
import { emptyAppearance } from '../shared/appearance.mjs'

test('unsaved appearance uses themed leave guard; direct reload keeps a separate recoverable draft without native dialogs',async()=>{
 const config=emptyAppearance(); config.mode='light';let saves=0
 const ui=await createObservabilityBrowser(observabilitySnapshot(),async route=>{
  if(new URL(route.request().url()).pathname==='/api/appearance'){if(route.request().method()==='PUT')saves++;await route.fulfill({json:{config,revision:'1'}});return true}
 })
 try {
  const p=ui.page,dialogs=[];p.on('dialog',async d=>{dialogs.push(d.type());await d.dismiss()})
  await openGlobalSettings(p);await p.locator('[data-settings-page="appearance"]').click();await p.getByRole('button',{name:'设计外观',exact:true}).click()
  await p.getByRole('button',{name:'字体',exact:true}).click();await p.locator('#appearance-textSize').fill('21')
  await p.reload();await openGlobalSettings(p);await p.locator('[data-settings-page="appearance"]').click()
  await p.getByRole('button',{name:'字体',exact:true}).click();assert.equal(await p.locator('#appearance-textSize').inputValue(),'21');assert.equal(saves,0)
  await p.evaluate(()=>{window.nativeCalls=[];window.__TAURI_INTERNALS__={invoke:async(command,args)=>{window.nativeCalls.push({command,...args});return false}}})
  await p.addScriptTag({content:await readFile(new URL('../../desktop/ui/window-chrome.js',import.meta.url),'utf8')})
  const leave=async()=>{await p.getByRole('button',{name:'应用菜单',exact:true}).click();await p.getByRole('menuitem',{name:'返回启动页',exact:true}).click()}
  await leave();const modal=p.getByRole('alertdialog',{name:'放弃未保存的外观？'});await modal.waitFor();assert.equal(await p.evaluate(()=>window.nativeCalls.filter(c=>c.action==='start_page').length),0)
  await modal.getByRole('button',{name:'继续编辑'}).click();assert.equal(await p.locator('#appearance-textSize').inputValue(),'21')
  await p.keyboard.press('F5');await modal.waitFor();await modal.getByRole('button',{name:'继续编辑'}).click()
  await leave();await modal.getByRole('button',{name:'放弃',exact:true}).click();await p.waitForFunction(()=>window.nativeCalls.some(c=>c.action==='start_page'))
  assert.equal(await p.locator('#appearance-textSize').inputValue(),'15');assert.equal(await p.evaluate(()=>localStorage.getItem('neoctl-web.appearance-draft.v1')),null)
  assert.deepEqual(dialogs,[]);assert.equal(saves,0)
 }finally{await ui.close()}
})
