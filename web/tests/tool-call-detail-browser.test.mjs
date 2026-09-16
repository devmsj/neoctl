// Actual Edge DOM/keyboard/download regression, with read-only API fixtures (no model).
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createObservabilityBrowser, observabilitySnapshot } from './observability-browser-fixture.mjs'
const errors = ['ENOENT: missing.txt', 'oldString not found', 'input.path must be string', 'Unknown agent target: nobody']
const lines = errors.map((error, i) => ({ id: i + 1, kind: 'error', toolName: ['file_read','file_edit','file_read','subagent_message'][i], toolUseId: `c${i}`, messageId: `m${i}`, title: '工具', titleStatus: 'failure', text: 'SUMMARY_NOT_FULL', toolError: error, toolDisplay: { purpose: '保留重复目的', previews: [], facts: [] }, ...(i === 3 ? { presentationLevel: 'primary' } : {}) }))
let failOnce = true, delay = 0, wrongIdentity = false
const part = text => ({state:'complete',text,reason:'已保存数据的脱敏全文'})
const fixture = await createObservabilityBrowser(observabilitySnapshot({lines}), async route => {
 const url = new URL(route.request().url())
 if (url.pathname !== '/api/tool-call-detail') return false
 const i = Number(url.searchParams.get('toolUseId').slice(1))
 if (failOnce) { failOnce = false; await route.fulfill({status:503,json:{error:'read failed'}}); return true }
 if (delay) await new Promise(r=>setTimeout(r,delay))
 await route.fulfill({json:{ sessionId:'obs-session', toolUseId: wrongIdentity ? 'WRONG' : `c${i}`, messageId:`m${i}`, toolName:lines[i].toolName, ok:false, input:part('path: missing.txt\nsecret: [已脱敏]'), result: i===2 ? {state:'truncated',text:'PREVIEW_ONLY',reason:'数据源已截断；当前为预览，不是完整结果'} : part('FULL_START\n'+'x'.repeat(9000)+'\nFULL_END'), error:part(errors[i]) }})
 return true
})
const {page, requests} = fixture
try {
 const group = page.locator('.tool-group-trigger').first()
 await group.waitFor()
 assert.equal(await page.locator('.tool-group-purpose').count(),3)
 assert.equal(await page.locator('.tool-group-purpose').first().innerText(),'保留重复目的')
 assert.equal(await page.locator('.tool-group-purposes').innerText().then(t=>t.includes('ENOENT')),false)
 await group.click()
 const buttons = page.locator('.tool-result-summary .image2-detail-button')
 assert.equal(await buttons.count(),4)
 const modal = page.locator('.tool-result-modal')
 await buttons.first().focus(); await page.keyboard.press('Enter')
 await modal.getByRole('alert').waitFor()
 assert.match(await modal.innerText(),/详情读取失败/)
 assert.equal(await page.locator('.tool-result-failure-mark').count(),4)
 await modal.getByRole('button',{name:'重试加载详情'}).click()
 await modal.getByText('错误原因',{exact:true}).waitFor()
 assert.match(await modal.innerText(),/FULL_END/)
 assert.match(await modal.innerText(),/ENOENT/)
 await page.context().grantPermissions(['clipboard-read','clipboard-write'])
 await modal.getByRole('button',{name:'复制脱敏全文'}).nth(1).click()
 assert.match(await page.evaluate(()=>navigator.clipboard.readText()),/FULL_END/)
 assert.equal(await modal.locator('script').count(),0)
 const downloadPromise = page.waitForEvent('download')
 await modal.getByRole('button',{name:'下载脱敏全文'}).nth(1).click()
 const download = await downloadPromise
 assert.match(await readFile(await download.path(),'utf8'),/FULL_END/)
 await modal.getByRole('button',{name:'关闭',exact:true}).focus(); await page.keyboard.press('Tab')
 assert.equal(await modal.getByRole('button',{name:'关闭工具结果'}).evaluate(el=>el===document.activeElement),true)
 await page.keyboard.press('Escape')
 assert.equal(await buttons.first().evaluate(el=>el===document.activeElement),true)
 for (let i=1;i<4;i++) {
   await buttons.nth(i).click(); await modal.getByText('错误原因',{exact:true}).waitFor()
   assert.match(await modal.innerText(),new RegExp(errors[i].replace(/[.*+?^${}()|[\]\\]/g,'\\$&')))
   if(i===2) assert.equal(await modal.getByRole('button',{name:'复制当前预览'}).count(),1)
   await page.keyboard.press('Escape')
 }
 // A delayed old call cannot populate the next modal, including after cancellation.
 delay=250; await buttons.first().click(); await modal.getByRole('status').waitFor(); await page.keyboard.press('Escape')
 delay=0; await buttons.nth(3).click(); await modal.getByText('错误原因',{exact:true}).waitFor(); await page.waitForTimeout(350)
 assert.match(await modal.innerText(),/Unknown agent target/); assert.doesNotMatch(await modal.innerText(),/ENOENT/)
 await page.keyboard.press('Escape')
 wrongIdentity=true; await buttons.nth(1).click(); await modal.getByRole('alert').waitFor(); assert.match(await modal.innerText(),/身份不匹配/)
 await page.keyboard.press('Escape'); wrongIdentity=false
 await page.reload(); await page.locator('.tool-group-trigger').first().click(); await page.locator('.tool-result-summary .image2-detail-button').nth(1).click(); await modal.getByText('错误原因',{exact:true}).waitFor(); assert.match(await modal.innerText(),/oldString not found/)
 await page.setViewportSize({width:390,height:844}); assert.ok(await modal.evaluate(el=>el.getBoundingClientRect().width<=390))
 assert.equal(requests.some(r=>r.method!=='GET'),false)
 assert.deepEqual(fixture.errors,[])
 console.log('OBS-01 actual Edge passed: grouped/ungrouped errors, keyboard/focus/trap, retry, full download, truncation, delayed identity, reload, narrow viewport, read-only requests')
} finally { await fixture.close() }
