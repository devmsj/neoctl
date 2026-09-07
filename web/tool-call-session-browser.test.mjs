import assert from 'node:assert/strict'
import {createObservabilityBrowser,observabilitySnapshot} from './observability-browser-fixture.mjs'
const line=s=>({id:1,kind:'tool',toolName:'file_read',toolUseId:'same-call',messageId:`result-${s}`,titleStatus:'success',text:'preview',toolDisplay:{purpose:`SESSION_${s}_PURPOSE`,facts:[],previews:[]}})
const snapshot=s=>observabilitySnapshot({session:{sessionId:s,title:`Session ${s}`},lines:[line(s)]})
let release,oldStarted=false,oldFinished=false
const gate=new Promise(r=>release=r)
const fixture=await createObservabilityBrowser(snapshot('A'),async route=>{
 const url=new URL(route.request().url()),s=url.searchParams.get('sessionId')||'A'
 if(url.pathname==='/api/state'){await route.fulfill({json:snapshot(s)});return true}
 if(url.pathname==='/api/sessions'){await route.fulfill({json:{sessions:[{sessionId:'B',title:'Session B',updatedAt:new Date().toISOString()}]}});return true}
 if(url.pathname!=='/api/tool-call-detail')return false
 if(s==='A'){oldStarted=true;await gate}
 const part=text=>({state:'complete',text,reason:'已保存数据的脱敏全文'})
 try{await route.fulfill({json:{sessionId:s,toolUseId:'same-call',messageId:`result-${s}`,toolName:'file_read',ok:true,input:part(`INPUT_${s}`),result:part(`RESULT_${s}_ONLY`),error:{state:'missing',text:'',reason:'不适用'}}})}catch(e){if(s!=='A')throw e}
 if(s==='A')oldFinished=true
 return true
})
try{
 const {page}=fixture
 await page.locator('.tool-result-summary .image2-detail-button').click()
 await page.locator('.tool-result-modal [role=status]').waitFor()
 assert.equal(oldStarted,true)
 await page.keyboard.press('Escape')
 await page.getByRole('button',{name:'会话管理',exact:true}).first().click()
 await page.getByRole('button',{name:'打开',exact:true}).click()
 await page.getByText('SESSION_B_PURPOSE',{exact:true}).waitFor()
 assert.equal(await page.locator('.tool-result-modal').count(),0)
 await page.locator('.tool-result-summary .image2-detail-button').click()
 await page.getByText('RESULT_B_ONLY',{exact:true}).waitFor()
 release();await page.waitForTimeout(300)
 assert.equal(oldFinished,true)
 assert.match(await page.locator('.tool-result-modal').innerText(),/RESULT_B_ONLY/)
 assert.doesNotMatch(await page.locator('.tool-result-modal').innerText(),/RESULT_A_ONLY|INPUT_A/)
 assert.equal(await page.evaluate(()=>sessionStorage.getItem('neoctl-web.sessionId')),'B')
 assert.equal(fixture.requests.some(r=>r.method!=='GET'),false)
 assert.deepEqual(fixture.errors,[])
 console.log('OBS-01 actual Edge session switch passed: A pending detail -> UI switch B with same line/call ID -> B detail -> late A rejected; all GET')
}finally{release();await fixture.close()}
