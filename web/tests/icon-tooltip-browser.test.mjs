import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createObservabilityBrowser, observabilitySnapshot } from './observability-browser-fixture.mjs'

test('icon controls show hints only after a hover pause or keyboard focus; clicks stay quiet', async () => {
 const f = await createObservabilityBrowser(observabilitySnapshot())
 const p = f.page
 try {
  await p.locator('.composer').waitFor()
  await p.evaluate(() => {
   window.__TAURI_INTERNALS__ = { invoke: async () => false }
   const node=document.createElement('div');node.id='tooltip-test';node.style='position:fixed;top:100px;left:400px;z-index:3000;display:flex;gap:10px'
   node.innerHTML='<button id="legacy-icon" title="关闭" aria-label="关闭">×</button><button id="count-icon" data-tooltip="工具数量"><svg width="12" height="12"><title>Tools</title><circle cx="6" cy="6" r="4"/></svg>17</button><span id="status-icon" data-tooltip="等待中"><svg width="16" height="16"><circle cx="8" cy="8" r="5"/></svg></span><span id="full-title" data-tooltip="完整的会话名称">会话名称</span><button id="aria-only" aria-label="复制"><svg width="12" height="12"><rect width="10" height="10"/></svg></button><span id="outer" data-tooltip="外层"><button id="bare-icon"><svg width="12" height="12"><rect width="10" height="10"/></svg></button></span>'
   document.body.append(node)
  })
  await p.addScriptTag({ path: fileURLToPath(new URL('../../desktop/ui/window-chrome.js', import.meta.url)) })
  const tip=p.getByRole('tooltip')
  const cases=[['#legacy-icon','关闭'],['#count-icon','工具数量'],['#status-icon','等待中'],['#aria-only','复制'],['neo-window-chrome [data-window=close]','关闭'],['.quick-head button:first-child','搜索会话']]
  for(const [selector,expected] of cases) {
   await p.mouse.move(0,0);await tip.waitFor({state:'hidden'})
   const el=p.locator(selector);await el.hover()
   await p.waitForTimeout(400);assert.equal(await tip.isVisible(),false,`${selector}: not before the hover pause`)
   await tip.waitFor({state:'visible'});assert.equal(await tip.innerText(),expected,selector)
   assert.equal(await el.getAttribute('title'),null)
  }
  // Unnamed icon controls neither show nor borrow an ancestor hint.
  await p.mouse.move(0,0);await p.locator('#bare-icon').hover();await p.waitForTimeout(900);assert.equal(await tip.isVisible(),false)
  // Clicking dismisses and stays quiet while the pointer remains on the control (mouse focus included).
  await p.mouse.move(0,0);await p.locator('#count-icon').click();await p.waitForTimeout(900);assert.equal(await tip.isVisible(),false)
  await p.locator('#count-icon').hover({position:{x:3,y:3}});await p.waitForTimeout(900);assert.equal(await tip.isVisible(),false)
  // Keyboard focus still reveals the hint promptly.
  await p.mouse.move(0,0);await p.keyboard.press('Shift+Tab');await tip.waitFor({state:'visible'});assert.equal(await tip.innerText(),'关闭')
  await p.keyboard.press('Escape')
  await p.locator('#full-title').hover();await tip.waitFor({state:'visible'});assert.equal(await tip.innerText(),'完整的会话名称')
  assert.deepEqual(f.errors,[])
 } finally { await f.close() }
})
