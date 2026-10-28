import test from 'node:test'
import assert from 'node:assert/strict'
import {createObservabilityBrowser,observabilitySnapshot} from './observability-browser-fixture.mjs'
import {emptyAppearance,deriveSurfaces} from '../shared/appearance.mjs'
import {openGlobalSettings} from './settings-navigation.mjs'

test('sidebar and panels derive from day/night backgrounds; legacy controls and overrides disappear',async()=>{
 let config=emptyAppearance(),revision='1'
 config.mode='light';config.light={background:'#bfd7d1',panel:'#ff0000',surface:'#0000ff',panelOpacity:20,surfaceOpacity:30};config.dark={background:'#101918',panel:'#ff0000',surfaceOpacity:40}
 const ui=await createObservabilityBrowser(observabilitySnapshot(),async route=>{
  if(new URL(route.request().url()).pathname!=='/api/appearance')return false
  if(route.request().method()==='PUT'){config=route.request().postDataJSON().config;revision='2'}
  await route.fulfill({json:{config,revision}});return true
 })
 try{
  const p=ui.page;await openGlobalSettings(p);await p.locator('[data-settings-page="appearance"]').click()
  const editor=p.locator('.appearance-editor');await editor.waitFor()
  assert.equal(await editor.locator('#appearance-panelOpacity,#appearance-surfaceOpacity').count(),0)
  assert.equal(await editor.getByText('面板透明度',{exact:true}).count(),0)
  for(const [mode,label,background] of [['light','日间','#b7d4d0'],['dark','夜间','#182028']]){
   await editor.getByRole('button',{name:label,exact:true}).click()
   await editor.locator('#appearance-bg-color').fill(background)
   const expected=deriveSurfaces(background,mode)
   await p.waitForFunction(expected=>document.documentElement.style.getPropertyValue('--appearance-panel')===expected.panel&&document.documentElement.style.getPropertyValue('--appearance-surface')===expected.surface,expected)
  }
  await editor.getByRole('button',{name:'颜色',exact:true}).click()
  assert.equal(await editor.locator('#appearance-color-panel,#appearance-color-surface').count(),0)
  await editor.getByRole('button',{name:'应用',exact:true}).click()
  await editor.getByRole('button',{name:'应用',exact:true}).waitFor()
  await p.waitForFunction(()=>document.querySelector('.appearance-apply')?.disabled)
  for(const mode of ['light','dark'])for(const key of ['panel','surface','panelOpacity','surfaceOpacity'])assert.equal(config[mode][key],undefined)
  await p.reload();await p.waitForFunction(()=>document.documentElement.style.getPropertyValue('--appearance-panel')=== '#cee2df')
  assert.deepEqual(ui.errors,[])
 }finally{await ui.close()}
})
