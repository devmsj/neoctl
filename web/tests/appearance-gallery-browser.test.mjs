import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { createObservabilityBrowser, observabilitySnapshot } from './observability-browser-fixture.mjs'
import { openGlobalSettings } from './settings-navigation.mjs'
import { emptyAppearance, normalizeAppearance } from '../shared/appearance.mjs'
import { APPEARANCE_PRESETS, availableAppearancePresets, matchesAppearancePreset, withDefaultAppearance } from '../src/appearance-presets.mjs'

test('platform defaults and order never overwrite saved appearance',()=>{
 assert.equal(new Set(APPEARANCE_PRESETS.map(p=>p.id)).size,APPEARANCE_PRESETS.length)
 for(const p of APPEARANCE_PRESETS){const c={...emptyAppearance(),light:p.light,dark:p.dark};assert.deepEqual(normalizeAppearance(c),c)}
 assert.deepEqual(availableAppearancePresets([],true).slice(0,2).map(p=>p.id),['glass','amber-glass'])
 assert.equal(availableAppearancePresets([],false)[0].id,'slate')
 assert.equal(availableAppearancePresets([],false).length,6)
 const custom=[{name:'自定磨砂',light:{windowFrost:2},dark:{}},{name:'自定普通',light:{},dark:{}}]
 for(const desktop of [true,false])assert.deepEqual(availableAppearancePresets(custom,desktop).slice(-2).map(p=>p.name),custom.map(p=>p.name))
 const override={builtin:'glass',name:'雾玻璃',light:{accent:'#112233'},dark:{}}
 assert.equal(availableAppearancePresets([override],true)[0].light.accent,'#112233')
 for(const bad of [{...override,name:'改名'}, {...override,builtin:'missing'}])assert.throws(()=>normalizeAppearance({...emptyAppearance(),presets:[bad]}))
 assert.deepEqual(normalizeAppearance({...emptyAppearance(),presets:[override]}).presets,[override])

 for(const desktop of [true,false]){
  const empty=emptyAppearance(),def=withDefaultAppearance(empty,'0',desktop)
  assert.ok(matchesAppearancePreset(def,APPEARANCE_PRESETS.find(p=>p.id===(desktop?'glass':'slate'))))
  assert.equal(withDefaultAppearance(empty,'1',desktop),empty)
  const custom={...empty,light:{accent:'#123456'}};assert.equal(withDefaultAppearance(custom,'0',desktop),custom)
 }
})

test('named designs persist as independent cards; icon actions edit and apply separately',async()=>{
 let config=emptyAppearance(),revision='1',writes=0,fail=false;config.mode='light'
 const ui=await createObservabilityBrowser(observabilitySnapshot(),async route=>{
  if(new URL(route.request().url()).pathname!=='/api/appearance')return false
  if(route.request().method()==='PUT'){
   if(fail){await route.fulfill({status:409,json:{error:'外观已更新，请重新载入'}});return true}
   config=normalizeAppearance(route.request().postDataJSON().config);revision=String(+revision+1);writes++
  }
  await route.fulfill({json:{config,revision}});return true
 },{viewport:{width:1180,height:820}})
 try{
  const p=ui.page
  await p.addInitScript(()=>{window.__TAURI__={core:{invoke:async()=>false}}})
  await p.reload();await openGlobalSettings(p);await p.locator('[data-settings-page="appearance"]').click()
  assert.equal(await p.locator('.appearance-preset-card').count(),8)
  assert.equal(await p.locator('.appearance-preset-card').first().getAttribute('aria-label'),'雾玻璃')
  assert.equal(await p.locator('.appearance-head button').count(),1)
  assert.equal(await p.getByRole('button',{name:/^(导入|导出)$/}).count(),0)
  assert.equal(await p.locator('input[accept=".json"]').count(),0)
  assert.equal(await p.getByRole('button',{name:'原色',exact:true}).count(),0)
  await p.getByRole('button',{name:'应用远山',exact:true}).click()
  await p.waitForFunction(()=>document.querySelector('[aria-label="应用远山"]').getAttribute('aria-pressed')==='true')
  const applied=structuredClone({light:config.light,dark:config.dark});assert.equal(writes,1)
  await p.getByRole('button',{name:'设计外观',exact:true}).click()
  assert.equal(await p.getByLabel('外观名称',{exact:true}).inputValue(),'')
  assert.ok(await p.getByRole('button',{name:'完成设计',exact:true}).isDisabled())
  assert.equal(await p.locator('.appearance-tabs button').count(),4)
  assert.equal(await p.getByRole('button',{name:'导出',exact:true}).count(),0)
  await p.getByLabel('外观名称',{exact:true}).fill('我的新外观')
  await p.getByRole('button',{name:'颜色',exact:true}).click();await p.locator('#appearance-accent').fill('#4477aa')
  // Name and unpublished design survive a refresh without applying or writing.
  await p.reload();await openGlobalSettings(p);await p.locator('[data-settings-page="appearance"]').click()
  assert.equal(await p.getByLabel('外观名称',{exact:true}).inputValue(),'我的新外观')
  await p.getByRole('button',{name:'颜色',exact:true}).click();assert.equal(await p.locator('#appearance-accent').inputValue(),'#4477aa');assert.equal(writes,1)
  fail=true;await p.getByRole('button',{name:'完成设计',exact:true}).click();await p.getByRole('alert').waitFor()
  assert.equal(await p.getByLabel('外观名称',{exact:true}).inputValue(),'我的新外观');assert.equal(config.presets.length,0)
  fail=false;await p.getByRole('button',{name:'完成设计',exact:true}).click();await p.locator('.appearance-preset-grid').waitFor()
  assert.equal(writes,2);assert.equal(config.presets.length,1);assert.deepEqual({light:config.light,dark:config.dark},applied)
  assert.equal(await p.getByRole('button',{name:'应用我的新外观',exact:true}).getAttribute('aria-pressed'),'false')
  await p.getByRole('button',{name:'编辑我的新外观',exact:true}).click();assert.equal(await p.getByLabel('外观名称',{exact:true}).inputValue(),'我的新外观')
  await p.getByRole('button',{name:'颜色',exact:true}).click();await p.locator('#appearance-accent').fill('#446655');await p.getByRole('button',{name:'完成设计',exact:true}).click();await p.locator('.appearance-preset-grid').waitFor()
  assert.equal(config.presets.length,1);assert.equal(config.presets[0].light.accent,'#446655');assert.deepEqual(config.light,applied.light)
  await p.getByRole('button',{name:'应用我的新外观',exact:true}).click();await p.waitForFunction(()=>document.querySelector('[aria-label="应用我的新外观"]').getAttribute('aria-pressed')==='true');assert.equal(config.light.accent,'#446655')
  assert.equal(await p.locator('.appearance-preset-card').last().getAttribute('aria-label'),'我的新外观')
  // System edits stay on their card, cannot rename and survive refresh.
  await p.getByRole('button',{name:'编辑雾玻璃',exact:true}).click()
  assert.equal(await p.getByLabel('外观名称',{exact:true}).inputValue(),'雾玻璃')
  assert.equal(await p.getByLabel('外观名称',{exact:true}).getAttribute('readonly'),'')
  await p.locator('#appearance-bg-color').fill('#ddeeff')
  await p.reload();await openGlobalSettings(p);await p.locator('[data-settings-page="appearance"]').click()
  assert.equal(await p.getByLabel('外观名称',{exact:true}).getAttribute('readonly'),'')
  await p.getByRole('button',{name:'完成设计',exact:true}).click();await p.locator('.appearance-preset-grid').waitFor()
  assert.equal(config.presets.length,2);assert.equal(config.presets.find(x=>x.builtin==='glass').light.background,'#ddeeff')
  assert.equal(await p.locator('.appearance-preset-card').count(),9)
  assert.equal(await p.getByRole('button',{name:'删除雾玻璃',exact:true}).count(),0)
  assert.equal(await p.locator('.appearance-preset-card').last().getAttribute('aria-label'),'我的新外观')
  await p.getByRole('button',{name:'应用雾玻璃',exact:true}).click();await p.waitForFunction(()=>document.querySelector('[aria-label="应用雾玻璃"]').getAttribute('aria-pressed')==='true')
  assert.equal(config.light.background,'#ddeeff')
  await p.getByRole('button',{name:'编辑雾玻璃',exact:true}).click();await p.locator('#appearance-bg-color').fill('#ccddee')
  await p.getByRole('button',{name:'完成设计',exact:true}).click();await p.locator('.appearance-preset-grid').waitFor()
  assert.equal(config.light.background,'#ccddee')
  fail=true;await p.getByRole('button',{name:'重置雾玻璃',exact:true}).click();await p.getByRole('alert').waitFor();assert.equal(config.light.background,'#ccddee')
  fail=false;await p.getByRole('button',{name:'重置雾玻璃',exact:true}).click()
  await p.waitForFunction(()=>document.querySelector('[aria-label="重置雾玻璃"]').disabled)
  assert.equal(config.presets.length,1);assert.deepEqual(config.light,APPEARANCE_PRESETS.find(x=>x.id==='glass').light)
  assert.deepEqual(config.dark,APPEARANCE_PRESETS.find(x=>x.id==='glass').dark)
  await p.getByRole('button',{name:'应用我的新外观',exact:true}).click();await p.waitForFunction(()=>document.querySelector('[aria-label="应用我的新外观"]').getAttribute('aria-pressed')==='true')
  const beforeDelete=structuredClone(config.light)
  await p.getByRole('button',{name:'删除我的新外观',exact:true}).click();await p.getByRole('alertdialog').getByRole('button',{name:'取消',exact:true}).click();assert.equal(config.presets.length,1)
  await p.getByRole('button',{name:'删除我的新外观',exact:true}).click();await p.getByRole('alertdialog').getByRole('button',{name:'删除',exact:true}).click()
  await p.getByRole('button',{name:'删除我的新外观',exact:true}).waitFor({state:'detached'})
  assert.equal(config.presets.length,0);assert.deepEqual(config.light,beforeDelete)
  await mkdir('../desktop/.cache',{recursive:true});await p.screenshot({path:'../desktop/.cache/appearance-actions-day.png'})
  for(const width of [1180,820,520,390]){await p.setViewportSize({width,height:820});await p.waitForTimeout(60);assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1))}
  await p.setViewportSize({width:1180,height:820});await p.getByRole('button',{name:'夜间',exact:true}).click();await p.waitForTimeout(180);await p.screenshot({path:'../desktop/.cache/appearance-actions-night.png'})
  await p.reload();await openGlobalSettings(p);await p.locator('[data-settings-page="appearance"]').click();assert.equal(await p.locator('.appearance-preset-card').count(),8)
  assert.deepEqual(ui.errors,[])
 }finally{await ui.close()}
})

for(const desktop of [false,true])test(`${desktop?'desktop':'web'} loads the platform default on first use without a write`,async()=>{
 let writes=0
 const ui=await createObservabilityBrowser(observabilitySnapshot(),async route=>{
  if(new URL(route.request().url()).pathname!=='/api/appearance')return false
  if(route.request().method()==='PUT')writes++
  await route.fulfill({json:{config:emptyAppearance(),revision:'0'}});return true
 })
 try{
  const p=ui.page;if(desktop){await p.addInitScript(()=>{window.__TAURI__={core:{invoke:async()=>false}}});await p.evaluate(()=>localStorage.clear());await p.reload()}
  await openGlobalSettings(p);await p.locator('[data-settings-page="appearance"]').click()
  const name=desktop?'雾玻璃':'远山'
  assert.equal(await p.locator('.appearance-preset-card').first().getAttribute('aria-label'),name)
  assert.equal(await p.getByRole('button',{name:'应用'+name,exact:true}).getAttribute('aria-pressed'),'true');assert.equal(writes,0)
 }finally{await ui.close()}
})
