import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createObservabilityBrowser, observabilitySnapshot } from './observability-browser-fixture.mjs'
const output = '\n  多行\n\n\tindent  \n' + 'x'.repeat(71000) + '\nEND\n\n'
const err = '\n  stderr\n\nENDERR\n'
let lifecycle = 'terminal', availability = 'available', failOnce = false
const task = { kind: 'terminal', taskId: 'terminal:run1', ownerSessionId: 'obs-session', sessionId: 'run1', status: 'exited', description: '保留终端阅读', createdAt: Date.now()-5000, durationMs: 1234, exitCode: 7, terminationReason: 'failed' }
const lines = [1,2].map(i => ({id:i,kind:'tool',toolName:i===1?'terminal_run':'terminal_control',toolUseId:`c${i}`,messageId:`m${i}`,title:'工具',text:'preview only',toolDisplay:{purpose:'重复目的',facts:[],previews:[]}}))
const snapshot = () => observabilitySnapshot({ lines, terminalTaskHistory: lifecycle==='terminal' ? [task] : [], backgroundTasks:lifecycle==='running' ? [{...task,status:'running'}] : [] })
const fixture = await createObservabilityBrowser(snapshot, async route => {
 const url = new URL(route.request().url())
 if(url.pathname === '/api/tool-call-detail') {
  const part=text=>({state:'complete',reason:'已保存调用结果（本次增量）',text})
  await route.fulfill({json:{sessionId:'obs-session',toolUseId:url.searchParams.get('toolUseId'),messageId:url.searchParams.get('messageId'),toolName:'terminal_control',input:part('{"session_id":"run1"}'),result:part('{"session_id":"run1","stdout":"preview only"}'),error:{state:'missing',text:'',reason:'不适用'}}});return true
 }
 if(url.pathname !== '/api/terminal-output') return false
 if(failOnce){failOnce=false;await route.fulfill({status:503,json:{}});return true}
 const stream=url.searchParams.get('stream'),offset=Number(url.searchParams.get('offset')),bytes=Buffer.from(stream==='stdout'?output:err),end=Math.min(bytes.length,offset+65536)
 const record={runId:'run1',ownerSessionId:'obs-session',metadata:{startedAt:Date.now()-5000,tty:false},lifecycle,availability,truncated:false,expiresAt:Date.now()+300000,exit:lifecycle==='terminal'?{status:'exited',exitCode:7,signal:null,terminationReason:'failed',durationMs:1234}:null,streams:{stdout:{storedBytes:Buffer.byteLength(output),observedBytes:Buffer.byteLength(output)},stderr:{storedBytes:Buffer.byteLength(err),observedBytes:Buffer.byteLength(err)}}}
 await route.fulfill({json:{sessionId:'obs-session',runId:'run1',stream,offset,nextOffset:end,text:availability==='available'?bytes.subarray(offset,end).toString():null,endOfStoredOutput:end===bytes.length,record}});return true
})
const {page}=fixture
try {
 await page.locator('.tool-group-trigger').first().click()
 const buttons=page.locator('.tool-result-summary .image2-detail-button')
 assert.equal(await buttons.count(),2)
 await buttons.first().click()
 const reader=page.locator('.terminal-output-reader')
 await reader.getByText('stderr',{exact:true}).waitFor()
 await reader.getByRole('button',{name:'加载全部已保留输出'}).click()
 await page.waitForFunction(()=>document.querySelector('.terminal-output-reader pre')?.textContent.endsWith('END\n\n'))
 assert.equal(await reader.locator('pre').first().textContent(),output)
 assert.equal(await reader.locator('pre').nth(1).textContent(),err)
 assert.match(await reader.innerText(),/退出码\s*7/)
 for(let i=0;i<2;i++)await reader.getByRole('button',{name:'刷新输出',exact:true}).click()
 assert.equal(await reader.locator('pre').first().textContent(),output)
 await page.context().grantPermissions(['clipboard-read','clipboard-write'])
 await reader.getByRole('button',{name:'复制完整输出',exact:true}).click()
 await reader.getByRole('button',{name:'复制完整输出',exact:true}).waitFor()
 const clipboard = await page.evaluate(()=>navigator.clipboard.readText())
 assert.ok(clipboard.replace(/\r\n/g,'\n').includes(output), `clipboard length=${clipboard.length} expected=${output.length}, tail=${JSON.stringify(clipboard.slice(-100))}`)
 const downloadPromise=page.waitForEvent('download');await reader.getByRole('button',{name:'下载完整输出',exact:true}).click();const download=await downloadPromise
 assert.ok((await readFile(await download.path(),'utf8')).includes(output))
 availability='expired';await reader.getByRole('button',{name:'刷新输出',exact:true}).click();await reader.getByRole('alert').waitFor()
 assert.match(await reader.innerText(),/已过期/);assert.equal(await reader.locator('pre').count(),0);assert.match(await reader.innerText(),/退出码\s*7/)
 await page.keyboard.press('Escape');availability='available'
 await page.locator('.background-task-history summary').click()
 await page.locator('.background-task-history button').first().click()
 await reader.getByRole('button',{name:'加载全部已保留输出'}).waitFor()
 await reader.getByRole('button',{name:'加载全部已保留输出'}).click();await page.waitForFunction(()=>document.querySelector('.terminal-output-reader pre')?.textContent.endsWith('END\n\n'))
 assert.equal(await reader.locator('pre').first().textContent(),output)
 await page.keyboard.press('Escape');await page.reload()
 await page.locator('.background-task-history summary').click();await page.locator('.background-task-history button').first().click();await reader.getByText('stderr',{exact:true}).waitFor()
 await page.setViewportSize({width:390,height:844});assert.ok(await page.locator('.background-task-modal').evaluate(el=>el.getBoundingClientRect().width<=390))
 assert.equal(fixture.requests.some(r=>r.method!=='GET'),false)
 assert.deepEqual(fixture.errors,[])
 console.log('OBS03/05 Edge PASS: independent calls, full multi-page whitespace/streams, repeated read no duplicates, clipboard/download beyond preview, expiry clears text retains facts, history reopen/reload, narrow viewport')
} finally {await fixture.close()}
