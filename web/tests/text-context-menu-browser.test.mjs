import test from 'node:test'
import assert from 'node:assert/strict'
import { createObservabilityBrowser, observabilitySnapshot } from './observability-browser-fixture.mjs'

test('text menu copies selection, pastes multiline at selection, preserves undo and session menu', async()=>{
 const f=await createObservabilityBrowser(observabilitySnapshot());const p=f.page
 try {
  await p.context().grantPermissions(['clipboard-read','clipboard-write'])
  const input=p.locator('.composer textarea');await input.waitFor()
  await p.evaluate(()=>{const e=document.createElement('p');e.id='copy-fixture';e.textContent='选中文本\n第二行';e.style='position:fixed;top:180px;left:400px;white-space:pre-wrap';document.body.append(e);const r=document.createRange();r.selectNodeContents(e);getSelection().removeAllRanges();getSelection().addRange(r)})
  await p.locator('#copy-fixture').dispatchEvent('contextmenu',{clientX:420,clientY:190,bubbles:true})
  const menu=p.getByRole('menu',{name:'文字操作'})
  assert.deepEqual(await menu.getByRole('menuitem').allTextContents(),['复制'])
  await menu.getByRole('menuitem',{name:'复制',exact:true}).click()
  assert.equal((await p.evaluate(()=>navigator.clipboard.readText())).replace(/\r\n/g,'\n'),'选中文本\n第二行')
  await p.evaluate(()=>{getSelection().removeAllRanges();document.querySelector('#copy-fixture').remove()})
  await input.fill('前替换后');await input.evaluate(el=>{el.focus();el.setSelectionRange(1,3)})
  await input.dispatchEvent('contextmenu',{clientX:500,clientY:600,bubbles:true})
  await menu.getByRole('menuitem',{name:'复制',exact:true}).click();assert.equal(await p.evaluate(()=>navigator.clipboard.readText()),'替换')
  await p.evaluate(()=>navigator.clipboard.writeText('第一行\n第二行'))
  await input.dispatchEvent('contextmenu',{clientX:500,clientY:600,bubbles:true})
  await menu.getByRole('menuitem',{name:'粘贴',exact:true}).click()
  await menu.waitFor({state:'hidden'})
  assert.equal(await input.inputValue(),'前第一行\n第二行后')
  assert.equal(await input.evaluate(el=>el.selectionStart),8)
  await input.press('Control+z');assert.equal(await input.inputValue(),'前替换后')
  await input.fill('');await input.dispatchEvent('contextmenu',{clientX:1439,clientY:999,bubbles:true})
  assert.equal(await menu.getByRole('menuitem',{name:'复制',exact:true}).isDisabled(),true)
  const bounds=await menu.boundingBox();assert.ok(bounds.x+bounds.width<=1440&&bounds.y+bounds.height<=1000)
  await p.keyboard.press('Escape');assert.equal(await menu.count(),0)
  await input.evaluate(el=>el.readOnly=true);await input.dispatchEvent('contextmenu',{clientX:500,clientY:600,bubbles:true});assert.equal(await menu.getByRole('menuitem',{name:'粘贴',exact:true}).count(),0)
  await p.keyboard.press('Escape');await input.evaluate(el=>el.readOnly=false)
  await p.locator('.quick-session').first().click({button:'right'});assert.equal(await p.getByRole('menu',{name:'会话操作'}).isVisible(),true)
  assert.deepEqual(f.errors,[])
 }finally{await f.close()}
})

test('desktop bypasses browser clipboard permissions for text and images and retries each click',async()=>{
 const f=await createObservabilityBrowser(observabilitySnapshot());const p=f.page
 try{
  const input=p.locator('.composer textarea');await input.waitFor()
  await p.evaluate(()=>{
   window.nativeCalls=[];window.nativeDenied=false
   Object.defineProperty(navigator,'clipboard',{configurable:true,value:{read:()=>{throw Error('browser must not be used')},writeText:()=>{throw Error('browser must not be used')}}})
   window.__TAURI__={core:{invoke:async(command,args)=>{window.nativeCalls.push({command,args});if(window.nativeDenied)throw Error('occupied');if(command.endsWith('clipboard_read'))return{text:'原生\n换行',imagePng:btoa('test image')}}}}
   document.querySelector('.composer textarea').addEventListener('paste',e=>{window.nativePaste={text:e.clipboardData.getData('text/plain'),types:[...e.clipboardData.files].map(f=>f.type)};e.preventDefault();e.stopImmediatePropagation()},true)
  })
  await input.fill('原生复制');await input.evaluate(el=>{el.focus();el.select()});await input.dispatchEvent('contextmenu');await p.getByRole('menuitem',{name:'复制',exact:true}).click()
  await p.locator('.text-context-menu').waitFor({state:'hidden'})
  assert.deepEqual(await p.evaluate(()=>window.nativeCalls[0]),{command:'plugin:local-resources|clipboard_write',args:{text:'原生复制'}})
  await input.dispatchEvent('contextmenu');await p.getByRole('menuitem',{name:'粘贴',exact:true}).click();await p.waitForFunction(()=>window.nativePaste)
  assert.deepEqual(await p.evaluate(()=>window.nativePaste),{text:'原生\n换行',types:['image/png']})
  await input.press('Control+a');await input.press('Control+c');await p.waitForFunction(()=>window.nativeCalls.filter(c=>c.command.endsWith('clipboard_write')).length===2)
  await input.press('Control+v');await p.waitForFunction(()=>window.nativeCalls.filter(c=>c.command.endsWith('clipboard_read')).length===2)
  await p.evaluate(()=>window.nativeDenied=true)
  for(let i=0;i<2;i++){await input.dispatchEvent('contextmenu');await p.getByRole('menuitem',{name:'粘贴',exact:true}).click();await p.locator('.text-context-menu').waitFor({state:'hidden'})}
  assert.equal(await p.evaluate(()=>window.nativeCalls.filter(c=>c.command.endsWith('clipboard_read')).length),4)
  assert.deepEqual(f.errors,[])
 }finally{await f.close()}
})

test('paste uses existing paste handler for image data and reports permission errors',async()=>{
 const f=await createObservabilityBrowser(observabilitySnapshot());const p=f.page
 try{
  const input=p.locator('.composer textarea');await input.waitFor()
  await p.evaluate(()=>{
   Object.defineProperty(navigator,'clipboard',{configurable:true,value:{read:async()=>[{types:['image/png','text/plain'],getType:async type=>new Blob([type==='text/plain'?'附带文字':'fixture'],{type})}]}})
   document.querySelector('.composer textarea').addEventListener('paste',e=>{window.pasted={text:e.clipboardData.getData('text/plain'),types:[...e.clipboardData.files].map(f=>f.type)};e.preventDefault();e.stopImmediatePropagation()},true)
  })
  await input.dispatchEvent('contextmenu',{clientX:500,clientY:600,bubbles:true});await p.getByRole('menuitem',{name:'粘贴',exact:true}).click()
  await p.waitForFunction(()=>window.pasted)
  assert.deepEqual(await p.evaluate(()=>window.pasted),{text:'附带文字',types:['image/png']})
  await p.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{readText:async()=>{throw Error('denied')}}}))
  await input.dispatchEvent('contextmenu',{clientX:500,clientY:600,bubbles:true});await p.getByRole('menuitem',{name:'粘贴',exact:true}).click()
  await p.getByText('无法读取剪贴板，请使用 Ctrl+V',{exact:true}).waitFor();assert.deepEqual(f.errors,[])
 }finally{await f.close()}
})
