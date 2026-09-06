// Run after npm run build. Uses optional existing desktop Playwright cache and local Edge.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { resolve, extname } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
const dist = fileURLToPath(new URL('./dist/', import.meta.url))
const require = createRequire(import.meta.url)
const { chromium } = require('../desktop/.cache/ui-test/node_modules/playwright-core')
const server = createServer(async (req,res) => {
 try { const path = resolve(dist, req.url === '/' ? 'index.html' : '.' + req.url); res.setHeader('Content-Type', {'.html':'text/html','.js':'text/javascript','.css':'text/css'}[extname(path)] || 'application/octet-stream'); res.end(await readFile(path)) } catch {res.writeHead(404);res.end()}
})
await new Promise(r=>server.listen(0,'127.0.0.1',r))
let browser
try {
 browser = await chromium.launch({channel:'msedge',headless:true})
 const page = await browser.newPage({viewport:{width:1440,height:1000}})
 const task = {kind:'agent',taskId:'task_test',agentId:'agent_test',description:'Browser regression task',status:'completed',runGeneration:2,pendingMessageCount:2,deliveredRetainedThisRun:128,progress:{lastActivity:'2026-01-01T00:00:00.000Z'},createdAt:'2026-01-01T00:00:00.000Z',result:{content:'CURRENT_REPORT',truncated:true},runHistory:[{runGeneration:1,status:'completed',result:{content:'HISTORICAL_REPORT'}}]}
 const longTask = {...task,taskId:'task_long',agentId:'agent_long',description:'A very long recently finished task title that must stay on one line and be visually truncated instead of pushing its status away',status:'failed',pendingMessageCount:0,deliveredRetainedThisRun:4,result:{content:'LONG_REPORT'},runHistory:[]}
 const snapshot={lines:[],status:{phase:'ready'},backgroundTasks:[],agentTaskHistory:[task,longTask],backgroundTaskCount:0,catalog:{commands:[],modelIds:[],reasoning:[]},session:{sessionId:'fake',title:'Fake browser regression'},interactive:{}}
 await page.route('**/api/**',route=>route.fulfill({json:route.request().url().includes('/api/state') ? snapshot : {}}))
 await page.route('**/events',route=>route.fulfill({contentType:'text/event-stream',body:''}))
 await page.goto(`http://127.0.0.1:${server.address().port}/`)
 await page.locator('.right-panel summary').filter({hasText:'最近结束'}).click()
 const historyItems=page.locator('.background-task-history-item')
 assert.equal(await historyItems.count(),2)
 const longTitle=historyItems.nth(1).locator('strong')
 assert.equal(await longTitle.evaluate(el=>getComputedStyle(el).textOverflow),'ellipsis')
 assert.equal(await historyItems.nth(1).locator('.background-task-summary-status').innerText(),'失败')
 await historyItems.first().click()
 const detail=page.locator('.background-task-detail')
 await detail.waitFor()
 assert.match(await detail.innerText(), /待续跑 · 2 条未交付/)
 assert.match(await detail.innerText(), /本轮最近已交付\s*128/)
 assert.match(await detail.innerText(), /最后活动/)
 assert.match(await detail.innerText(), /预览已截断/)
 assert.match(await detail.innerText(), /CURRENT_REPORT/)
 assert.doesNotMatch(await detail.innerText(), /HISTORICAL_REPORT/)
 assert.equal(await page.locator('.background-task-detail-body').evaluate(el=>getComputedStyle(el).overflowY),'auto')
 assert.equal(await page.locator('.background-task-agent-grid').evaluate(el=>getComputedStyle(el).gridTemplateColumns.split(' ').length > 1),true)
 await detail.locator('.background-task-archives summary').click()
 assert.match(await detail.innerText(), /HISTORICAL_REPORT/)
 await page.setViewportSize({width:760,height:720})
 assert.equal(await page.locator('.background-task-page').evaluate(el=>getComputedStyle(el).gridTemplateColumns.split(' ').length),1)
 assert.equal(await page.locator('.background-task-agent-grid').evaluate(el=>getComputedStyle(el).gridTemplateColumns.split(' ').length),1)
 const modalBox=await page.locator('.background-task-modal').boundingBox()
 assert.ok(modalBox.height <= 720 && modalBox.width <= 760)
 console.log('Edge fake snapshot browser assertions passed: history alignment and ellipsis, independent detail scrolling, delivery/result hierarchy, collapsed history, narrow layout')
} finally { await browser?.close(); await new Promise(r=>server.close(r)) }
