import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createObservabilityBrowser, observabilitySnapshot } from './observability-browser-fixture.mjs'

test('icon controls never show hover or focus hints; textual titles still expand', async () => {
 const f = await createObservabilityBrowser(observabilitySnapshot())
 const p = f.page
 try {
  await p.locator('.composer').waitFor()
  await p.evaluate(() => {
   window.__TAURI_INTERNALS__ = { invoke: async () => false }
   const node=document.createElement('div');node.id='tooltip-test';node.style='position:fixed;top:100px;left:400px;z-index:3000;display:flex;gap:10px'
   node.innerHTML='<button id="legacy-icon" title="关闭" aria-label="关闭">×</button><button id="count-icon" data-tooltip="工具数量"><svg width="12" height="12"><title>Tools</title><circle cx="6" cy="6" r="4"/></svg>17</button><span id="status-icon" data-tooltip="等待中"><svg width="16" height="16"><circle cx="8" cy="8" r="5"/></svg></span><span id="full-title" data-tooltip="完整的会话名称">会话名称</span>'
   document.body.append(node)
  })
  await p.addScriptTag({ path: fileURLToPath(new URL('../../desktop/ui/window-chrome.js', import.meta.url)) })
  const tip=p.getByRole('tooltip')
  for(const selector of ['#legacy-icon','#count-icon','#status-icon','neo-window-chrome [data-controls-action]','neo-window-chrome [data-settings-action]','neo-window-chrome [data-pin-action]','neo-window-chrome [data-window=close]','.quick-head button:first-child']) {
   const el=p.locator(selector);await el.hover();await p.waitForTimeout(500)
   assert.equal(await tip.isVisible(),false,selector)
   assert.equal(await el.getAttribute('title'),null)
  }
  await p.locator('#legacy-icon').focus();await p.waitForTimeout(180);assert.equal(await tip.isVisible(),false)
  await p.locator('#full-title').hover();await tip.waitFor({state:'visible'});assert.equal(await tip.innerText(),'完整的会话名称')
  await p.locator('neo-window-chrome [data-controls-action]').hover();await tip.waitFor({state:'hidden'})
  assert.deepEqual(f.errors,[])
 } finally { await f.close() }
})
