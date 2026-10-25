import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { resolve, extname } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT_CORE_PATH)
const dist = fileURLToPath(new URL('../dist/', import.meta.url))
const server = createServer(async (req, res) => {
  try { const file = resolve(dist, req.url === '/' ? 'index.html' : `.${req.url}`); res.setHeader('Content-Type', { '.html':'text/html','.js':'text/javascript','.css':'text/css' }[extname(file)] || 'application/octet-stream'); res.end(await readFile(file)) }
  catch { res.writeHead(404); res.end() }
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
let browser
try {
  browser = await chromium.launch({channel:'msedge',headless:true})
  const page = await browser.newPage(), errors = []
  page.on('pageerror', e => errors.push(e.message))
  await page.addInitScript(() => { localStorage.setItem('neoctl-web.theme','dark'); window.EventSource=class{addEventListener(){}close(){}} })
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname
    let json = {}
    if(path==='/api/auth/status') json={isolation:false,user:null}
    if(path==='/api/state') json={busy:false,cwd:'C:\\workspace',session:{sessionId:'layout-fixture',title:'布局检查'},catalog:{commands:[],modelIds:['fixture'],reasoning:['default']},interactive:{},lines:[],backgroundTasks:[],agentTaskHistory:[],backgroundTaskCount:0,status:{phase:'idle'}}
    if(path==='/api/sessions') json={sessions:[],runningSessionIds:[]}
    if(path==='/api/prompt-library'||path==='/api/tools'||path==='/api/plugins') json={items:[]}
    if(path==='/api/cwd/scope') json={ok:true,paths:['C:\\workspace']}
    if(path==='/api/memory') json={current:{rss:73400320},history:[]}
    if(path==='/api/cpa-quota') json={quotas:[],config:{}}
    return route.fulfill({json})
  })
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  await page.locator('.composer').waitFor()
  for(const desktop of [false,true]) {
    await page.evaluate(value => { if(value) document.documentElement.dataset.neoDesktop=''; else delete document.documentElement.dataset.neoDesktop },desktop)
    for(const width of [1440,1180,1000,888,821,820,760,390,320]) {
      await page.setViewportSize({width,height:800}); await page.waitForTimeout(60)
      const sizes = await page.evaluate(() => {const rect=s=>document.querySelector(s).getBoundingClientRect(); return {left:rect('.sidebar').width,right:rect('.right-panel').width,chat:rect('.chat-panel').width,composer:rect('.composer').width,scroll:document.documentElement.scrollWidth,height:rect('.chat-panel').bottom}})
      assert.ok(sizes.scroll<=width+1,`no overflow at ${width}: ${JSON.stringify(sizes)}`)
      assert.ok(sizes.height<=801,`composer fits viewport ${width}`)
      if(width>820){assert.ok(sizes.chat>=380,`conversation priority at ${width}: ${JSON.stringify(sizes)}`);if(width<=1000){assert.ok(sizes.left<=217&&sizes.right<=209,`sidebars shrink first: ${JSON.stringify(sizes)}`)}}
      else assert.equal(sizes.left,0)
      console.log(JSON.stringify({desktop,width,...sizes}))
    }
  }
  assert.deepEqual(errors,[])
  console.log('PASS responsive conversation priority in web and desktop')
} finally {await browser?.close();await new Promise(r=>server.close(r))}
