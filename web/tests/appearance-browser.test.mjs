import { openGlobalSettings } from './settings-navigation.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { createObservabilityBrowser, observabilitySnapshot } from './observability-browser-fixture.mjs'
import { emptyAppearance } from '../shared/appearance.mjs'

test('personal customization: independent schemes, one accent, previews, cancel, persistence and compact controls', async () => {
 let config=emptyAppearance(),revision='0',saves=0;config.mode='dark'
 const ui=await createObservabilityBrowser(observabilitySnapshot({lines:[{id:1,kind:'user',text:'保留默认外观'},{id:2,kind:'assistant',text:'正文\n\n```js\nconst a = 1\n```'}]}),async route=>{
  const req=route.request(),url=new URL(req.url())
  if(url.pathname==='/api/appearance') {
   if(req.method()==='PUT'){const body=req.postDataJSON();if(body.revision!==revision){await route.fulfill({status:409,json:{error:'外观已在其他窗口更新，请重新载入'}});return true};config=body.config;revision=String(Number(revision)+1);saves++}
   await route.fulfill({json:{config,revision}});return true
  }
  if(url.pathname==='/api/login'){await route.fulfill({json:{provider:'openai',providers:['openai'],fields:[],values:{}}});return true}
 },{viewport:{width:1440,height:1000}})
 try {
  const p=ui.page
  await p.waitForFunction(()=>document.documentElement.dataset.theme==='dark')
  await openGlobalSettings(p)
  await p.locator('[data-settings-page="appearance"]').click()
  const editor=p.locator('.appearance-editor')
  await editor.getByRole('button',{name:'颜色',exact:true}).click()
  assert.equal(await editor.locator('input[type=color]:visible').count(),1)
  for (const name of ['主题模式', '主题方案', '代码配色']) {
   const trigger = editor.getByRole('button', {name, exact:true})
   await trigger.click()
   const menu = editor.getByRole('listbox', {name, exact:true})
   const style = await menu.evaluate(el => ({ border:getComputedStyle(el).borderTopWidth, shadow:getComputedStyle(el).boxShadow, options:[...el.querySelectorAll('button')].map(n=>({border:getComputedStyle(n).borderTopWidth,align:getComputedStyle(n).textAlign,weight:getComputedStyle(n).fontWeight})) }))
   assert.equal(style.border,'1px'); assert.equal(style.shadow,'none')
   assert.ok(style.options.every(o=>o.border==='0px' && o.align==='left' && o.weight==='400'))
   assert.equal(await trigger.evaluate(el=>getComputedStyle(el).borderTopWidth),'0px')
   await p.keyboard.press('Escape')
   assert.ok(await trigger.evaluate(el=>document.activeElement===el))
  }
  await editor.locator('#appearance-accent').fill('#55aacc')
  await p.waitForFunction(()=>!!document.documentElement.style.getPropertyValue('--appearance-accent'))
  assert.equal(saves,0,'preview never writes')
  await p.waitForTimeout(250) // existing color transition finishes before computed-color assertions
  const controls = await editor.evaluate(el => {
   const summary = el.querySelector('.appearance-save-menu > summary'), icon = summary.querySelector('svg'), text = summary.querySelector('span'), apply = el.querySelector('.appearance-apply')
   const a = icon.getBoundingClientRect(), b = text.getBoundingClientRect()
   return { accent: getComputedStyle(el).getPropertyValue('--chrome-accent').trim(), border: getComputedStyle(apply).borderTopColor, summaryDisplay: getComputedStyle(summary).display, marker: getComputedStyle(summary).listStyleType, alignment: Math.abs(a.y + a.height / 2 - b.y - b.height / 2) }
  })
  assert.notEqual(controls.accent, '#bb8ea6'); assert.notEqual(controls.border, 'rgb(187, 142, 166)')
  assert.equal(controls.summaryDisplay, 'flex'); assert.equal(controls.marker, 'none'); assert.ok(controls.alignment < 1)
  await editor.locator('.appearance-save-menu > summary').click()
  await editor.getByLabel('方案名称', {exact:true}).fill('测试方案')
  await editor.getByRole('button', {name:'添加',exact:true}).click()
  await editor.locator('.appearance-save-menu > summary').click()
  await editor.getByRole('button',{name:'日间',exact:true}).click()
  await editor.locator('#appearance-accent').fill('#994422')
  await editor.getByRole('button',{name:'应用',exact:true}).click()
  await p.waitForFunction(()=>document.querySelector('.appearance-status')?.textContent==='已保存')
  assert.equal(config.dark.accent,'#55aacc');assert.equal(config.light.accent,'#994422');assert.equal(saves,1)
  await editor.getByRole('button',{name:'字体',exact:true}).click()
  await editor.locator('#appearance-textSize').fill('21')
  await editor.getByRole('button',{name:'取消',exact:true}).click()
  await p.waitForFunction(()=>!document.documentElement.style.getPropertyValue('--appearance-text-size'))
  await editor.getByRole('button',{name:'返回全局配置',exact:true}).click()
  await p.reload()
  await p.waitForFunction(()=>document.documentElement.style.getPropertyValue('--appearance-accent'))
  await openGlobalSettings(p);await p.locator('[data-settings-page="appearance"]').click()
  await editor.getByRole('button',{name:'布局',exact:true}).click()
  await editor.locator('#appearance-radius').fill('10')
  await editor.getByRole('button',{name:'应用',exact:true}).click()
  await p.waitForTimeout(150)
  assert.equal(config.dark.radius,10)
  for(const width of [1180,820,520,390]){
   await p.setViewportSize({width,height:900});await p.waitForTimeout(80)
   assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'no overflow '+width)
  }
  await p.setViewportSize({width:1440,height:1000})
  await editor.getByRole('button',{name:'颜色',exact:true}).click();await editor.locator('#appearance-accent').fill('#cc66aa')
  revision='20'
  await editor.getByRole('button',{name:'应用',exact:true}).click()
  await editor.getByRole('alert').waitFor()
  assert.match(await editor.getByRole('alert').innerText(),/重新载入/)
  assert.deepEqual(ui.errors,[])
  await p.screenshot({path:'../desktop/.cache/appearance-editor.png'})
 } finally {await ui.close()}
})

test('isolated users can access personal appearance without model settings', async()=>{
 const ui=await createObservabilityBrowser(observabilitySnapshot(),async route=>{
  const url=new URL(route.request().url())
  if(url.pathname==='/api/auth/status'){await route.fulfill({json:{isolation:true,user:{username:'Alice',role:'user'}}});return true}
  if(url.pathname==='/api/appearance'){await route.fulfill({json:{config:emptyAppearance(),revision:'0'}});return true}
 })
 try {await openGlobalSettings(ui.page);await ui.page.locator('[data-settings-page="appearance"]').click();await ui.page.locator('.appearance-editor').waitFor();assert.equal(ui.requests.filter(r=>r.url.includes('/api/login')).length,0);assert.deepEqual(ui.errors,[])}finally{await ui.close()}
})
