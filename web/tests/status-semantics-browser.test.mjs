import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createObservabilityBrowser, observabilitySnapshot } from './observability-browser-fixture.mjs'
const raw = JSON.parse(await readFile(join(tmpdir(),'obs08-browser-lines.json'),'utf8'))
// Same actual service projections in both ordinary rendering branches.
const lines = [...raw.map((l,i)=>({...l,id:i+1,presentationLevel:'process'})), {id:100,kind:'assistant',text:'分隔'}, ...raw.map((l,i)=>({...l,id:101+i,toolUseId:`standalone-${i}`,messageId:`standalone-message-${i}`,presentationLevel:'primary'}))]
const fixture = await createObservabilityBrowser(observabilitySnapshot({lines}))
try {
 const {page}=fixture
 await page.setViewportSize({width:1440,height:16000}); await page.locator('.tool-group-trigger').first().waitFor()
 assert.equal(await page.locator('.tool-group-purpose').count(),raw.length)
 assert.deepEqual(await page.locator('.tool-group-purpose').allTextContents(),raw.map(()=> '保留重复目的'))
 const folded=await page.locator('.tool-group-purposes').innerText()
 assert.doesNotMatch(folded,/调用成功|未入队|暂无终态结果/)
 const header=await page.locator('.tool-group-trigger').first().innerText(); assert.match(header,/×/)
 await page.locator('.tool-group-trigger').first().click()
 const cards=page.locator('.tool-result-summary')
 assert.equal(await cards.count(),raw.length*2)
 for(let i=0;i<raw.length;i++){
  const a=cards.nth(i),b=cards.nth(i+raw.length)
  const expected=raw[i].titleStatus==='failure'?'status-failed':'status-completed'
  assert.match(await a.getAttribute('class'),new RegExp(expected));assert.match(await b.getAttribute('class'),new RegExp(expected))
  for(const fact of raw[i].toolDisplay.facts){assert.ok((await a.innerText()).includes(fact.value)); assert.ok((await b.innerText()).includes(fact.value))}
  const style=el=>{const s=getComputedStyle(el);return [s.fontSize,s.color,s.padding,s.gap,s.borderRadius]}
  assert.deepEqual(await a.evaluate(style),await b.evaluate(style))
 }
 assert.equal(await page.locator('.tool-result-failure-mark[aria-label="执行失败"]').count(),4)
 assert.match(await cards.last().innerText(),/阶段结果未提供/)
 assert.doesNotMatch(await cards.first().innerText(),/仅入队/)
 assert.deepEqual(fixture.errors,[])
 assert.equal(fixture.requests.some(r=>r.method!=='GET'),false)
 console.log('OBS08 Edge passed: actual projection matrix in grouped and ungrouped cards; identical computed card style; duplicate purpose order; × aria-label; no false read failure; read-only')
} finally {await fixture.close()}
