import test from 'node:test'
import assert from 'node:assert/strict'
import {createObservabilityBrowser,observabilitySnapshot} from './observability-browser-fixture.mjs'
import {emptyAppearance} from '../shared/appearance.mjs'
import {openGlobalSettings} from './settings-navigation.mjs'

test('appearance uses workspace surfaces, editable unified font dropdowns and distinct code palettes',async()=>{
 const config=emptyAppearance();config.mode='light';config.light={accent:'#287b82',background:'#bfd7d1',surface:'#dce9e5',panel:'#dce9e5'}
 const f=await createObservabilityBrowser(observabilitySnapshot(),async route=>{
  if(new URL(route.request().url()).pathname==='/api/appearance'){await route.fulfill({json:{config,revision:'1'}});return true}
 });const p=f.page
 try{
  await openGlobalSettings(p);await p.getByRole('button',{name:'外观',exact:true}).click()
  const editor=p.locator('.appearance-editor');await editor.waitFor()
  assert.equal(await editor.getByRole('heading',{name:'外观',exact:true}).count(),1)
  assert.equal(await editor.evaluate(el=>getComputedStyle(el).backgroundColor),'rgba(0, 0, 0, 0)')
  const inherited=await editor.evaluate(el=>({editor:getComputedStyle(el).getPropertyValue('--chrome-surface').trim(),root:getComputedStyle(document.documentElement).getPropertyValue('--chrome-surface').trim()}));assert.equal(inherited.editor,inherited.root)
  for (const theme of ['light', 'dark']) {
   await p.evaluate(theme => document.documentElement.dataset.theme = theme, theme)
   for (const name of ['背景','字体','颜色','布局']) {
    await editor.locator('.appearance-tabs').getByRole('button',{name,exact:true}).click()
    await p.waitForTimeout(200)
    const borders = await editor.locator('.appearance-tabs button').evaluateAll(buttons => buttons.map(el => {
     const s=getComputedStyle(el), probe=document.createElement('span');probe.style.color='var(--chrome-accent)';el.append(probe);const accent=getComputedStyle(probe).color;probe.remove()
     return {selected:el.getAttribute('aria-current')==='page',accent,edges:['Top','Right','Bottom','Left'].map(side=>({color:s['border'+side+'Color'],width:s['border'+side+'Width'],style:s['border'+side+'Style']}))}
    }))
    assert.equal(borders.filter(x=>x.selected).length,1)
    for (const item of borders) for (const edge of item.edges) {assert.equal(edge.width,'1px');assert.equal(edge.style,'solid');assert.equal(edge.color,item.selected?item.accent:'rgba(0, 0, 0, 0)')}
   }
  }
  await p.evaluate(()=>document.documentElement.dataset.theme='light')
  await editor.getByRole('button',{name:'字体',exact:true}).click()
  assert.equal(await editor.locator('datalist,input[list]').count(),0)
  const font=editor.getByRole('combobox',{name:'界面字体',exact:true});await font.click()
  const menu=editor.getByRole('listbox',{name:'界面字体',exact:true});await menu.waitFor()
  const style=await menu.evaluate(el=>({shadow:getComputedStyle(el).boxShadow,border:getComputedStyle(el).borderTopWidth}));assert.equal(style.shadow,'none');assert.equal(style.border,'1px')
  await menu.getByRole('option',{name:'Segoe UI',exact:true}).click();assert.equal(await font.inputValue(),'Segoe UI')
  await font.fill('My Custom Font');await p.keyboard.press('Escape');assert.equal(await font.inputValue(),'My Custom Font')
  await editor.getByRole('button',{name:'颜色',exact:true}).click()
  const palettes=[]
  for(const name of ['跟随主题','单色','多彩']){
   await editor.getByRole('button',{name:'代码配色',exact:true}).click()
   await editor.getByRole('option',{name,exact:true}).click()
   await p.waitForTimeout(160)
   palettes.push(await editor.locator('.appearance-code-preview').evaluate(el=>({keyword:getComputedStyle(el.querySelector('.hljs-keyword')).color,string:getComputedStyle(el.querySelector('.hljs-string')).color,number:getComputedStyle(el.querySelector('.hljs-number')).color,bg:getComputedStyle(el.querySelector('pre')).backgroundColor,head:getComputedStyle(el.querySelector('th')).backgroundColor})))
  }
  assert.equal(new Set(palettes.map(x=>JSON.stringify([x.keyword,x.string,x.number]))).size,3)
  assert.equal(palettes[1].keyword,palettes[1].string);assert.notEqual(palettes[2].keyword,palettes[2].string)
  assert.notEqual(palettes[0].bg,'rgb(246, 247, 250)');assert.notEqual(palettes[0].head,'rgb(246, 247, 250)');assert.notEqual(palettes[0].head,palettes[0].bg)
  await p.screenshot({path:'../desktop/.cache/appearance-unified.png'})
  assert.deepEqual(f.errors,[])
 }finally{await f.close()}
})

test('custom tooltips reveal full text, follow accent, dismiss and work across desktop shadow roots',async()=>{
 const f=await createObservabilityBrowser(observabilitySnapshot());const p=f.page
 try{
  const item=p.locator('.quick-session').first();await item.waitFor()
  const text='完整会话标题 / '+ '很长的内容'.repeat(24)
  await item.evaluate((el,text)=>el.setAttribute('data-tooltip',text),text)
  await item.hover();const tip=p.getByRole('tooltip');await tip.waitFor({state:'visible'})
  assert.equal(await tip.textContent(),text);assert.equal(await item.getAttribute('title'),null)
  assert.equal(await item.getAttribute('aria-describedby'),'neo-tooltip-description')
  const rect=await tip.boundingBox();assert.ok(rect.x>=0&&rect.x+rect.width<=1440)
  const old=await tip.evaluate(el=>getComputedStyle(el).borderTopColor)
  await p.evaluate(()=>document.documentElement.style.setProperty('--appearance-accent','#d9a556'))
  assert.notEqual(await tip.evaluate(el=>getComputedStyle(el).borderTopColor),old)
  await tip.hover();await p.waitForTimeout(200);assert.ok(await tip.isVisible())
  await p.keyboard.press('Escape');assert.equal(await tip.isVisible(),false)
  await p.evaluate(()=>{const host=document.createElement('div');host.id='shadow-test';const root=host.attachShadow({mode:'open'});root.innerHTML='<button data-tooltip="窗口置顶" style="position:fixed;right:20px;top:10px">Pin</button>';document.body.append(host)})
  const pin=p.locator('#shadow-test button');await pin.hover();await tip.waitFor({state:'visible'});assert.equal(await tip.textContent(),'窗口置顶')
  await pin.evaluate(el=>el.setAttribute('data-tooltip','取消置顶'));await p.waitForFunction(()=>document.querySelector('neo-tooltip-layer').shadowRoot.querySelector('[role=tooltip]').textContent==='取消置顶')
  await p.keyboard.press('Escape')
  await p.evaluate(()=>{const button=document.createElement('button');button.id='legacy-tip';button.title='<b>literal</b>';button.textContent='legacy';button.style='position:fixed;right:20px;top:50px';document.body.append(button)})
  await p.locator('#legacy-tip').hover();await tip.waitFor({state:'visible'});assert.equal(await p.locator('#legacy-tip').getAttribute('title'),null);assert.equal(await tip.textContent(),'<b>literal</b>');assert.equal(await tip.locator('b').count(),0)
  await p.locator('#legacy-tip').click();assert.equal(await tip.isVisible(),false)
  assert.deepEqual(f.errors,[])
 }finally{await f.close()}
})
