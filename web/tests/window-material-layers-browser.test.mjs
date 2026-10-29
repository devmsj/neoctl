import test from 'node:test'
import assert from 'node:assert/strict'
import {createObservabilityBrowser,observabilitySnapshot} from './observability-browser-fixture.mjs'
import {openGlobalSettings} from './settings-navigation.mjs'
import {emptyAppearance} from '../shared/appearance.mjs'
const alpha=css=>{const m=css.match(/\/\s*([\d.]+)\)/);if(m)return Number(m[1]);if(css.startsWith('rgba'))return Number(css.match(/[\d.]+/g).at(-1));return 1}
const near=(a,b,label)=>assert.ok(Math.abs(a-b)<.002,`${label}: ${a} != ${b}`)
test('glass elevations follow master transparency across controls, previews, popovers, code and both themes; web unchanged',async()=>{
 const config=emptyAppearance();config.mode='light'
 const ui=await createObservabilityBrowser(observabilitySnapshot(),async route=>{
  if(new URL(route.request().url()).pathname==='/api/appearance'){await route.fulfill({json:{config,revision:'1'}});return true}
 })
 try{
 const p=ui.page;await openGlobalSettings(p);await p.locator('[data-settings-page="appearance"]').click();await p.getByRole('button',{name:'设计外观',exact:true}).click()
 const css=async sel=>p.locator(sel).first().evaluate(e=>({bg:getComputedStyle(e).backgroundColor,opacity:getComputedStyle(e).opacity}))
 const selectors={panel:'.sidebar',control:'#appearance-design-name',content:'.appearance-preview',code:'.appearance-code-preview pre',table:'.appearance-code-preview th',label:'.appearance-background-picker span'}
 const web=await css(selectors.control);near(alpha(web.bg),1,'normal web')
 for(const mode of ['light','dark']){
 await p.locator('.appearance-mode').getByRole('button',{name:mode==='light'?'日间':'夜间',exact:true}).click()
 for(const t of [0,48,100]){
 await p.evaluate(t=>{let r=document.documentElement;r.dataset.desktop='true';r.dataset.windowMaterial='on';r.style.setProperty('--appearance-window-transparency',String(t))},t)
 await p.waitForTimeout(180) // existing control background transition
 const expect={panel:1-t*.0088,content:1-t*.0072,control:1-t*.0062,code:1-t*.0062,table:1-t*.0062,label:1-t*.0062}
 for(const [role,sel]of Object.entries(selectors)){
 await p.waitForFunction(({sel,a})=>{const c=getComputedStyle(document.querySelector(sel)).backgroundColor;const m=c.match(/\/\s*([\d.]+)\)/);const actual=m?Number(m[1]):c.startsWith('rgba')?Number(c.match(/[\d.]+/g).at(-1)):1;return Math.abs(actual-a)<.002},{sel,a:expect[role]})
 const v=await css(sel);near(alpha(v.bg),expect[role],mode+' '+role+' '+t);assert.equal(v.opacity,'1')
 }
 await p.getByRole('button',{name:'颜色',exact:true}).click();await p.getByRole('button',{name:'代码配色',exact:true}).click();near(alpha((await css('.neo-select-menu')).bg),1-t*.001,'popup');await p.keyboard.press('Escape');await p.getByRole('button',{name:'背景',exact:true}).click()
 }
 }
 await p.getByRole('button',{name:'字体',exact:true}).click()
 const range=await p.locator('.appearance-editor input[type="range"]').first().evaluate(e=>({bg:getComputedStyle(e).backgroundColor,border:getComputedStyle(e).borderTopWidth}))
 near(alpha(range.bg),0,'range outer box stays clear');assert.equal(range.border,'0px')
 await p.getByRole('button',{name:'背景',exact:true}).click()
 await p.evaluate(()=>{document.documentElement.dataset.desktop='false'})
 await p.waitForTimeout(180)
 await p.waitForFunction(sel=>getComputedStyle(document.querySelector(sel)).backgroundColor.startsWith('rgb('),selectors.control)
 near(alpha((await css(selectors.control)).bg),1,'web does not adopt native material even with saved parameters')
 // Actual settings textarea and session search share the same control surface.
 await p.getByRole('button',{name:'返回外观',exact:true}).click();await p.locator('.appearance-editor').getByRole('button',{name:'返回全局配置',exact:true}).click()
 await p.locator('[data-settings-page="prompt"]').click()
 await p.evaluate(()=>{let r=document.documentElement;r.dataset.desktop='true';r.style.setProperty('--appearance-window-transparency','48')})
 await p.waitForTimeout(180)
 await p.waitForFunction(()=>{const css=getComputedStyle(document.querySelector('textarea')).backgroundColor;const match=css.match(/\/\s*([\d.]+)\)/);return match && Math.abs(Number(match[1])-.7024)<.002})
 near(alpha((await css('textarea')).bg),.7024,'prompt textarea')
 await p.getByRole('button',{name:'会话管理',exact:true}).first().click()
 near(alpha((await css('.sessions-page input')).bg),.7024,'session search')
 await p.setViewportSize({width:700,height:750})
 near(alpha((await css('.topbar')).bg),0,'narrow navigation rail has no extra backing')
 await p.locator('.mobile-nav-menu > summary').click()
 near(alpha((await css('.topbar .mobile-nav-menu nav')).bg),.952,'narrow expanded navigation')
 }finally{await ui.close()}
})

test('rendered chat, context menus and confirmation dialogs use their semantic glass layers',async()=>{
 const config=emptyAppearance();config.mode='light'
 const snapshot=observabilitySnapshot({lines:[
  {id:1,kind:'user',text:'Glass sample'},
  {id:2,kind:'assistant',text:'```js\nconst glass = true\n```\n\n| Name | State |\n| --- | --- |\n| Glass | Ready |'}
 ]})
 const ui=await createObservabilityBrowser(snapshot,async route=>{
  const path=new URL(route.request().url()).pathname
  if(path==='/api/appearance'){await route.fulfill({json:{config,revision:'1'}});return true}
  if(path==='/api/sessions'){await route.fulfill({json:{sessions:[snapshot.session],total:1,page:1,totalPages:1}});return true}
 })
 try{
  const p=ui.page
  await p.locator('.message-text pre').waitFor()
  for(const theme of ['light','dark']){
   await p.evaluate(theme=>{const r=document.documentElement;r.dataset.desktop='true';r.dataset.windowMaterial='on';r.dataset.theme=theme;r.style.setProperty('--appearance-window-transparency','48')},theme)
   await p.waitForTimeout(180)
   for(const [sel,a] of [['.message.user .message-body',.6544],['.message-text pre',.7024],['.message-text th',.7024],['.composer',.6544]]){
    const value=await p.locator(sel).first().evaluate(e=>({bg:getComputedStyle(e).backgroundColor,opacity:getComputedStyle(e).opacity}))
    near(alpha(value.bg),a,theme+' '+sel);assert.equal(value.opacity,'1')
   }
   await p.locator('.quick-session').first().click({button:'right'})
   const menu=p.getByRole('menu',{name:'会话操作'});await menu.waitFor()
   near(alpha(await menu.evaluate(e=>getComputedStyle(e).backgroundColor)),.952,'context menu')
   await p.getByRole('menuitem',{name:'删除',exact:true}).click()
   const dialog=p.getByRole('alertdialog');await dialog.waitFor()
   near(alpha(await dialog.evaluate(e=>getComputedStyle(e).backgroundColor)),.952,'confirmation')
   await dialog.getByRole('button',{name:'取消',exact:true}).click()
  }
  assert.deepEqual(ui.errors,[])
 }finally{await ui.close()}
})
