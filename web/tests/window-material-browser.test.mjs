import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createObservabilityBrowser, observabilitySnapshot } from './observability-browser-fixture.mjs'
import { openGlobalSettings } from './settings-navigation.mjs'
import { emptyAppearance } from '../shared/appearance.mjs'

test('material stays opaque on web; desktop acknowledgement gates all canvas layers', async()=>{
 const config=emptyAppearance(); config.mode='light';config.light={windowTransparency:65,windowFrost:2}
 const ui=await createObservabilityBrowser(observabilitySnapshot(),async route=>{
  if(new URL(route.request().url()).pathname==='/api/appearance'){await route.fulfill({json:{config,revision:'1'}});return true}
 })
 try {
  const p=ui.page;await p.waitForFunction(()=>document.documentElement.dataset.appearance==='ready')
  await openGlobalSettings(p);await p.locator('[data-settings-page="appearance"]').click()
  assert.equal(await p.locator('#appearance-windowTransparency').count(),0)
  await p.locator('.appearance-editor').getByRole('button',{name:'返回全局配置',exact:true}).click()
  await p.evaluate(()=>window.dispatchEvent(new Event('neo:open-settings')))
  const bg=()=>p.locator('.shell').evaluate(e=>getComputedStyle(e).backgroundColor)
  const opaque=await bg();assert.equal(opaque,'rgb(255, 255, 255)')
  await p.evaluate(()=>{window.calls=[];window.activeNative=0;window.maxNative=0;window.__TAURI_INTERNALS__={invoke:async(command,args)=>{if(command.endsWith('|sync_surface')){window.calls.push(args);window.maxNative=Math.max(window.maxNative,++window.activeNative);await new Promise(r=>setTimeout(r,60));window.activeNative--;if(window.failNative)throw Error('mock unsupported');return args.transparency>0}return false}};document.documentElement.dataset.desktop='true'})
  assert.equal(await bg(),opaque,'no native acknowledgement means no transparent canvas')
  await p.addScriptTag({content:await readFile(new URL('../../desktop/ui/window-chrome.js',import.meta.url),'utf8')})
  await p.waitForFunction(()=>document.documentElement.dataset.windowMaterial==='on')
  for(const s of ['html','body','#app','.workspace','.chat-panel','.rows-history'])assert.equal(await p.locator(s).first().evaluate(e=>getComputedStyle(e).backgroundColor),'rgba(0, 0, 0, 0)',s)
  assert.match(await bg(),/0\.35/)
  const before=await p.evaluate(()=>window.calls.length)
  await p.evaluate(()=>document.documentElement.style.setProperty('--appearance-window-transparency','50'))
  await p.waitForTimeout(130);assert.equal(await p.evaluate(()=>window.calls.length),before,'tint changes do not rebuild native blur')
  await p.evaluate(()=>document.documentElement.style.setProperty('--appearance-window-frost','0'))
  await p.waitForTimeout(160)
  assert.equal(await p.evaluate(()=>window.calls.at(-1).frost),0)
  await p.evaluate(()=>document.documentElement.style.setProperty('--appearance-window-frost','2'))
  await p.waitForTimeout(160)
  assert.equal(await p.evaluate(()=>window.calls.at(-1).frost),2)
  assert.equal(await p.evaluate(()=>window.maxNative),1)
  assert.equal(await p.locator('.composer').evaluate(e=>getComputedStyle(e).backdropFilter),'none')
  const calls=await p.evaluate(()=>window.calls.length)
  await p.evaluate(()=>{for(let i=0;i<30;i++)window.dispatchEvent(new Event('resize'))})
  await p.waitForTimeout(220);assert.equal(await p.evaluate(()=>window.calls.length),calls,'moving/resizing never reapplies the material')
  await p.evaluate(()=>{window.failNative=true;document.documentElement.style.setProperty('--appearance-bg','#223344')})
  await p.waitForFunction(()=>document.documentElement.dataset.windowMaterial==='off')
  assert.equal(await bg(),'rgb(34, 51, 68)','native error restores opaque CSS in the selected background color')
  await p.evaluate(()=>{window.failNative=false;document.documentElement.style.setProperty('--appearance-window-transparency','0')})
  await p.waitForTimeout(120);assert.equal(await p.evaluate(()=>window.calls.at(-1).transparency),0)
  assert.equal(await bg(),'rgb(34, 51, 68)')
  assert.equal(await p.evaluate(()=>window.calls.at(-1).frost),2,'zero transparency retains the selected frost')
  await p.evaluate(()=>{document.documentElement.style.setProperty('--appearance-window-frost','0');document.documentElement.style.setProperty('--appearance-window-transparency','100')})
  await p.waitForFunction(()=>document.documentElement.dataset.windowMaterial==='on')
  assert.equal(await p.evaluate(()=>window.calls.at(-1).frost),0)
  assert.match(await bg(),/\/ 0\)/,'100% removes the tint instead of substituting white')
 } finally {await ui.close()}
})
