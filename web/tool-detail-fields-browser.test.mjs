// Edge uses production-built classifier on real OBS01 reader parts; API fixture is read-only.
import assert from 'node:assert/strict'
import { toolDetailFieldsFromDetail } from '../engine/dist/web/tool-detail-fields.js'
import { readToolCallDetail } from '../engine/dist/web/tool-call-detail.js'
import { createObservabilityBrowser, observabilitySnapshot } from './observability-browser-fixture.mjs'
const long = '允许展示正文\n  detail '.repeat(2500) + 'LONG_END'
const cases = [
 {name:'file_read',input:{description:'完整源目的',path:'relative.txt',offset:0,limit:0},output:{path:'C:\\actual\\完整 路径.txt'}},
 {name:'web_search',input:{query:'query',provider:'openai',includeDomains:[],excludeDomains:['blocked.example'],startPublishedDate:'2026-01-01',endPublishedDate:'2026-09-07'},output:{provider:'exa',results:[]}},
 {name:'subagent_message',input:{target:'worker',message:long},output:{task_id:'resolved-task',run_generation:0}},
 {name:'file_edit',input:{path:'relative',oldString:'',newString:long,replaceAll:false},output:{path:'C:\\actual\\edit.txt'},primary:true},
 {name:'file_read',input:undefined,output:{path:'C:\\preview.txt',truncated:true},primary:true},
]
const lines=cases.map((c,i)=>({id:i+1,kind:'tool',toolName:c.name,toolUseId:`c${i}`,messageId:`m${i}`,title:'工具',titleStatus:'success',text:'SUMMARY',toolDisplay:{purpose:'保留重复目的',subject:'SHORT_SUBJECT',previews:[],facts:[]},...(c.primary?{presentationLevel:'primary'}:{})}))
const details=await Promise.all(cases.map(async(c,i)=>{
 const detail=await readToolCallDetail({sessionId:'obs-session',expectedSessionId:'obs-session',toolUseId:`c${i}`,entries:[
  {type:'message',message:{id:`u${i}`,role:'assistant',createdAt:'',blocks:[{type:'tool_use',id:`c${i}`,name:c.name,input:c.input}]}},
  {type:'message',message:{id:`m${i}`,role:'tool_result',createdAt:'',blocks:[{type:'tool_result',toolUseId:`c${i}`,name:c.name,ok:true,output:c.output}]}}
 ]})
 return {...detail,fields:toolDetailFieldsFromDetail(detail)}
}))
const fixture=await createObservabilityBrowser(observabilitySnapshot({lines}),async route=>{
 const url=new URL(route.request().url());if(url.pathname!=='/api/tool-call-detail')return false
 await route.fulfill({json:details[Number(url.searchParams.get('toolUseId').slice(1))]});return true
})
const {page}=fixture
try {
 await page.locator('.tool-group-trigger').first().waitFor()
 assert.equal(await page.locator('.tool-group-purpose').count(),3)
 await page.locator('.tool-group-trigger').first().click()
 const buttons=page.locator('.tool-result-summary .image2-detail-button')
 assert.equal(await buttons.count(),5)
 const modal=page.locator('.tool-result-modal')
 const row=key=>modal.locator(`[data-detail-field="${key}"]`)
 await page.context().grantPermissions(['clipboard-read','clipboard-write'])
 for(let i=0;i<cases.length;i++) {
  await buttons.nth(i).focus();await page.keyboard.press('Enter')
  await modal.getByText('对象与关键参数',{exact:true}).waitFor()
  assert.match(await row('subject').innerText(),/SHORT_SUBJECT[\s\S]*|展示摘要/)
  assert.match(await row('subject').innerText(),/展示摘要（不是完整输入）/)
  if(i===0 || i===3) {
   await modal.getByRole('button',{name:'复制完整路径'}).click()
   assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),cases[i].output.path)
  }
  if(i===0) {assert.equal(await row('purpose').locator('pre').innerText(),'完整源目的');assert.equal(await row('offset').locator('pre').innerText(),'0');assert.equal(await row('limit').locator('pre').innerText(),'0')}
  if(i===1) {
   for(const key of ['query','provider','includeDomains','excludeDomains','startPublishedDate','endPublishedDate']) assert.ok(await row(key).count())
   assert.equal(await row('includeDomains').locator('pre').innerText(),'[]')
   assert.equal(await row('actualProvider').locator('pre').innerText(),'exa')
   assert.equal(await row('numResults').locator('pre').innerText(),'未指定')
   assert.match(await modal.innerText(),/空结果/)
  }
  if(i===2) {assert.equal(await row('target').locator('pre').innerText(),'worker');assert.equal(await row('object').locator('pre').innerText(),'resolved-task');assert.equal(await row('message').locator('pre').textContent(),long)}
  if(i===3) {assert.equal(await row('oldString').locator('pre').innerText(),'（空字符串）');assert.equal(await row('replaceAll').locator('pre').innerText(),'false');assert.equal(await row('newString').locator('pre').textContent(),long)}
  if(i===4) {assert.match(await row('actualPath').innerText(),/已截断来源/);assert.equal(await modal.getByRole('button',{name:'复制完整路径'}).count(),0);assert.equal(await row('offset').locator('pre').innerText(),'未提供');assert.equal(await modal.getByRole('button',{name:'复制当前预览'}).count(),1)}
  await page.setViewportSize({width:390,height:844})
  assert.ok(await modal.evaluate(el=>el.getBoundingClientRect().width<=390))
  await page.keyboard.press('Escape');assert.equal(await buttons.nth(i).evaluate(el=>el===document.activeElement),true)
  await page.setViewportSize({width:1440,height:1000})
 }
 assert.equal(fixture.requests.some(r=>r.method!=='GET'),false)
 assert.deepEqual(fixture.errors,[])
 console.log('OBS06 Edge passed: grouped/ungrouped absolute clipboard, metadata source, filters/provider, target/long message/edit, 0 false [], missing/truncated, focus and narrow viewport')
} finally {await fixture.close()}
