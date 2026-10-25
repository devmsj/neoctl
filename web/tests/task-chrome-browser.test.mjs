import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createObservabilityBrowser, observabilitySnapshot } from './observability-browser-fixture.mjs'
const part = text => ({ state:'complete', text, offset:0, totalChars:text.length, hasMore:false })
test('task chrome: status icons, history, terminal/agent details, focus, themes and mobile', async () => {
 const terminal={kind:'terminal',sessionId:'term-review',ownerSessionId:'obs-session',description:'运行项目测试',command:'npm run test',cwd:'D:\\workspace\\project',status:'running',startedAt:new Date().toISOString()}
 const agent={kind:'agent',taskId:'agent-review',agentId:'child',runGeneration:1,description:'检查文档与示例命令'.repeat(8),status:'completed',durationMs:10000}
 const failed={...terminal,sessionId:'failed-run',description:'检查失败记录',status:'failed'}
 const fixture=await createObservabilityBrowser(observabilitySnapshot({backgroundTasks:[terminal],backgroundTaskCount:1,agentTaskHistory:[agent],terminalTaskHistory:[failed]}),async route=>{
  const url=new URL(route.request().url())
  if(url.pathname==='/api/terminal-output'){
   const stream=url.searchParams.get('stream'), offset=Number(url.searchParams.get('offset')), text=offset?'':stream==='stdout'?'Tests passed\n':'Diagnostic note\n'
   await route.fulfill({json:{sessionId:'obs-session',runId:url.searchParams.get('runId'),stream,offset,nextOffset:offset+Buffer.byteLength(text),text,endOfStoredOutput:true,record:{availability:'available',lifecycle:'terminal',streams:{stdout:{storedBytes:13},stderr:{storedBytes:16}}}}});return true
  }
  if(url.pathname==='/api/agent-content'){
   const view=url.searchParams.get('view'),base={ownerSessionId:'obs-session',taskId:agent.taskId,runGeneration:1,state:'complete',snapshotId:view}
   const data=view==='delegation'?{delegation:{scope:'task',prompt:part('检查项目文档')}}:view==='messages'?{messages:{content:part('[]')}}:{report:{content:part('## 检查完成\n\n示例命令已确认。\n\n```js\nconst ok = true;\n```')}}
   await route.fulfill({json:{...base,...data}});return true
  }
 })
 try {
  const {page}=fixture
  const entry=page.locator('.right-panel .background-task-summary').first()
  await entry.waitFor()
  assert.equal(await entry.locator('.task-status-icon').getAttribute('aria-label'),'运行中')
  await page.locator('.background-task-history > summary').click()
  assert.equal(await page.locator('.background-task-history-item').count(),2)
  assert.equal(await page.locator('.background-task-summary-status').count(),0)
  await entry.click()
  const modal=page.getByRole('dialog',{name:'后台任务',exact:true})
  await modal.locator('.background-task-live-output').first().waitFor()
  assert.equal(await modal.getByRole('button',{name:'关闭',exact:true}).evaluate(el=>el===document.activeElement),true)
  assert.equal(await modal.locator('.tool-result-modal-status, .background-task-meta .wide').count(),0)
  assert.ok(!(await modal.innerText()).includes(terminal.cwd),'no directory path')
  assert.equal(await modal.locator('.background-task-detail-title .task-status-icon').getAttribute('aria-label'),'运行中')
  for(const theme of ['light','dark']){
   await page.evaluate(t=>document.documentElement.dataset.theme=t,theme)
   assert.equal(await modal.locator('.background-task-live-output').first().evaluate(el=>getComputedStyle(el).backgroundColor),'rgba(0, 0, 0, 0)')
   assert.equal(await modal.locator('.background-task-index-item.active').evaluate(el=>getComputedStyle(el).boxShadow),'none')
   await page.screenshot({path:join(tmpdir(),`neo-tasks-${theme}.png`)})
  }
  const agentButton=modal.locator('.background-task-index-item').filter({hasText:'检查文档与示例命令'})
  await agentButton.click()
  await modal.locator('.agent-parent-message h2').waitFor()
  assert.deepEqual(await modal.locator('.agent-parent-message header strong').allTextContents(),['委派','回复'])
  assert.equal(await agentButton.getAttribute('aria-current'),'true')
  for(const width of [1440,390]){
   await page.setViewportSize({width,height:844})
   assert.ok(await modal.evaluate(el=>el.scrollWidth<=el.clientWidth+1))
   assert.ok(await modal.evaluate(el=>el.getBoundingClientRect().height<=innerHeight))
   await page.screenshot({path:join(tmpdir(),`neo-task-agent-${width}.png`)})
  }
  await page.keyboard.press('Escape')
  assert.equal(await modal.count(),0)
  await page.setViewportSize({width:1440,height:1000})
  await entry.click()
  await modal.getByRole('button',{name:'关闭',exact:true}).click()
  assert.equal(await entry.evaluate(el=>el===document.activeElement),true)
  assert.deepEqual(fixture.errors,[])
  assert.ok(fixture.requests.every(r=>r.method==='GET'),'read-only review')
 } finally {await fixture.close()}
})
