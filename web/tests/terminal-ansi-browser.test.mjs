// Run after npm run build. Uses optional existing desktop Playwright cache and local Edge.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { resolve, extname } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const dist = fileURLToPath(new URL('../dist/', import.meta.url))
const require = createRequire(import.meta.url)
const { chromium } = require(process.env.NEO_PLAYWRIGHT_MODULE || '../../desktop/.cache/ui-test/node_modules/playwright-core')
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
const server = createServer(async (req, res) => {
  try {
    if (req.url?.startsWith('/api/images/')) {
      res.setHeader('Content-Type', 'image/png')
      res.end(pixel)
      return
    }
    const path = resolve(dist, req.url === '/' ? 'index.html' : `.${req.url}`)
    res.setHeader('Content-Type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[extname(path)] || 'application/octet-stream')
    res.end(await readFile(path))
  } catch {
    res.writeHead(404)
    res.end()
  }
})

await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
let browser
try {
 browser=await chromium.launch({channel:'msedge',headless:true})
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[]
 page.on('pageerror',e=>errors.push(e.message))
 const sessionId='ansi-session',runId='ansi-run'
 const chunks=['\x1b[3','1mcolored',' continuation\x1b[0m plain\n\x1b[38;2;10;120;230mtruecolor\x1b[0m\n<img src=x onerror=alert(1)>\x1b]52;c;never-clipboard\x07']
 let stdout=chunks[0],stderr='stderr plain',finished=false
 const snapshot={busy:true,session:{sessionId,title:'终端真实着色'},catalog:{commands:[],modelIds:[],reasoning:[]},interactive:{},backgroundTasks:[{kind:'terminal',sessionId:runId,ownerSessionId:sessionId,status:'running',description:'彩色输出命令',command:'node color-output.mjs'}],backgroundTaskCount:1,agentTaskHistory:[],status:{phase:'running_tools',currentTool:{name:'terminal_run'}},lines:[{id:'term',kind:'tool',toolName:'terminal_run',toolUseId:'color-call',titleStatus:'running',activity:{phase:'running',input:{cmd:'node color-output.mjs'}},observation:{session_id:runId}}]}
 await page.addInitScript(()=>{localStorage.setItem('neo-tool-history-view','rows');localStorage.setItem('neoctl-web.theme','light');window.__streams=[];window.EventSource=class{constructor(){this.handlers={};window.__streams.push(this)}addEventListener(name,fn){this.handlers[name]=fn}close(){}}})
 await page.route('**/api/**',route=>{
  const url=new URL(route.request().url()),path=url.pathname
  if(path==='/api/auth/status')return route.fulfill({json:{isolation:false,user:null}})
  if(path==='/api/terminal-output'){
   const stream=url.searchParams.get('stream'),source=stream==='stdout'?stdout:stderr,offset=Number(url.searchParams.get('offset')),buffer=Buffer.from(source),text=buffer.subarray(offset).toString()
   return route.fulfill({json:{sessionId,runId,stream,offset,nextOffset:buffer.length,text,endOfStoredOutput:true,record:{availability:'available',lifecycle:finished?'terminal':'running',exit:finished?{exitCode:1}:undefined,streams:{stdout:{storedBytes:Buffer.byteLength(stdout)},stderr:{storedBytes:Buffer.byteLength(stderr)}}}}})
  }
  return route.fulfill({json:path==='/api/state'?snapshot:{}})
 })
 await page.goto(`http://127.0.0.1:${server.address().port}/`)
 await page.locator('.tool-activity-row').waitFor()
 await page.locator('.tool-activity-row').click()
 await page.locator('.is-pinned .terminal-stderr').waitFor()
 const notify=()=>page.evaluate(({sessionId,runId})=>window.__streams.at(-1).handlers.delta({data:JSON.stringify({sessionId,operations:[{type:'terminal.output',sessionId:runId}]})}),{sessionId,runId})
 stdout+=chunks[1];await notify()
 await page.locator('.is-pinned .terminal-text span').filter({hasText:/^colored$/}).waitFor()
 const color=locator=>locator.evaluate(el=>getComputedStyle(el).color)
 assert.equal(await color(page.locator('.is-pinned .terminal-text span').filter({hasText:/^colored$/})),'rgb(179, 36, 36)')
 stdout+=chunks[2];stderr+='\n\x1b[32mexplicit green\x1b[0m';finished=true;await notify()
 await page.locator('.is-pinned .terminal-text span').filter({hasText:/colored continuation/}).waitFor()
 assert.equal(await color(page.locator('.is-pinned .terminal-text span').filter({hasText:'truecolor'})),'rgb(10, 120, 230)')
 assert.equal(await color(page.locator('.is-pinned .terminal-stderr span').filter({hasText:'stderr plain'})),'rgb(32, 37, 45)','stderr has no guessed red')
 assert.equal(await color(page.locator('.is-pinned .terminal-stderr span').filter({hasText:'explicit green'})),'rgb(33, 117, 45)')
 assert.equal(await page.locator('.is-pinned img').count(),0)
 assert.ok(!(await page.locator('.is-pinned').innerText()).includes('never-clipboard'))
 assert.ok(!(await page.locator('.is-pinned').innerText()).includes('\x1b'))
 await page.getByRole('button',{name:'应用菜单',exact:true}).click(); await page.getByRole('menuitem',{name:/切换到(夜间|白天)/}).click();await page.waitForTimeout(250)
 assert.equal(await color(page.locator('.is-pinned .terminal-text span').filter({hasText:/colored continuation/})),'rgb(205, 49, 49)')
 assert.equal(await color(page.locator('.is-pinned .terminal-text span').filter({hasText:'truecolor'})),'rgb(10, 120, 230)')
 await page.locator('.background-task-summary').first().click()
 await page.locator('.background-task-modal .terminal-text span').filter({hasText:'truecolor'}).waitFor()
 assert.equal(await color(page.locator('.background-task-modal .terminal-text span').filter({hasText:'truecolor'})),'rgb(10, 120, 230)')
 assert.equal(await color(page.locator('.background-task-modal .terminal-stderr span').filter({hasText:'stderr plain'})),'rgb(215, 220, 227)')
 await page.getByRole('button',{name:'关闭',exact:true}).click()
 assert.deepEqual(errors,[])
 console.log('PASS terminal ANSI: split chunks, style continuity/reset, real RGB, theme palette, independent stderr, inert markup/control strings, observation and terminal detail')
} finally {await browser?.close();await new Promise(r=>server.close(r))}
