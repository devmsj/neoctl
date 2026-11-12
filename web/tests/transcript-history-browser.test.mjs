// npm run build, then node tests/transcript-history-browser.test.mjs (optional local Playwright/Edge)
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { resolve, extname } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
const require = createRequire(import.meta.url)
const { chromium } = require(process.env.NEO_PLAYWRIGHT_MODULE || '../../desktop/.cache/ui-test/node_modules/playwright-core')
const dist = fileURLToPath(new URL('../dist/', import.meta.url))
const server = createServer(async (req, res) => {
  try { const file = resolve(dist, req.url === '/' ? 'index.html' : `.${req.url}`); res.setHeader('Content-Type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[extname(file)] || 'application/octet-stream'); res.end(await readFile(file)) }
  catch { res.writeHead(404); res.end() }
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
let browser
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  const page = await browser.newPage({ viewport: process.env.NEO_TEST_MOBILE ? { width: 390, height: 844 } : { width: 1440, height: 1000 } })
  const errors = []; page.on('pageerror', e => errors.push(e.message))
  let historyRequests = 0, releaseHistory
  const historyGate = new Promise(resolve => { releaseHistory = resolve })
  const lines = (start, end, archived = false) => Array.from({ length: end - start }, (_, k) => ({ id: archived ? `history:200:${start+k}` : k+1, historyOffset: start+k, kind: k%2 ? 'assistant' : 'user', text: `Message ${start+k}\n\n${'A complete paragraph of history. '.repeat(8)}` }))
  const snapshot = { session: { sessionId: 'history-test' }, lines: lines(200, 260), history: { before: 200, hasMore: true, epoch: 'e' }, status: { phase: 'ready' }, catalog: { commands: [], modelIds: [], reasoning: [] }, interactive: {}, backgroundTasks: [] }
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/auth/status') return route.fulfill({ json: { isolation: false, user: null } })
    if (url.pathname === '/api/state') return route.fulfill({ json: snapshot })
    if (url.pathname === '/api/history') { historyRequests++; await historyGate; const before = Number(url.searchParams.get('before')); return route.fulfill({ json: { sessionId: 'history-test', epoch: 'e', before: Math.max(0, before-100), hasMore: before>100, lines: lines(Math.max(0, before-100), before, true) } }) }
    return route.fulfill({ json: {} })
  })
  await page.route('**/events*', route => route.fulfill({ contentType: 'text/event-stream', body: `event: sync\ndata: ${JSON.stringify(snapshot)}\n\n` }))
  const t = performance.now()
  await page.goto(`http://127.0.0.1:${server.address().port}/`)
  await page.locator('.virtual-message-row').first().waitFor()
  await page.waitForTimeout(800)
  const initialMs = performance.now()-t
  assert.ok(historyRequests >= 1, 'prefetch older history without user interaction')
  // Wheel intent turns off bottom follow; inspect anchor immediately before inserting prefetched rows.
  await page.locator('.transcript').hover(); await page.mouse.wheel(0, -20); await page.waitForTimeout(200)
  const before = await page.evaluate(() => {
    const el=document.querySelector('.transcript');el.scrollTop=1000
    return {height:el.scrollHeight}
  })
  await page.waitForTimeout(200)
  const anchor = await page.evaluate(() => {
    const el = document.querySelector('.transcript'), top = el.getBoundingClientRect().top
    const row = [...el.querySelectorAll('.virtual-message-row')].find(r => r.getBoundingClientRect().bottom > top)
    return { id: row.dataset.lineId, y: row.getBoundingClientRect().top - top }
  })
  releaseHistory()
  await page.waitForTimeout(600)
  const anchored = await page.evaluate(id => {
    const el = document.querySelector('.transcript'), row = el.querySelector(`[data-line-id="${id}"]`)
    return row ? row.getBoundingClientRect().top - el.getBoundingClientRect().top : null
  }, anchor.id)
  assert.notEqual(anchored, null, 'same reading anchor remains rendered')
  assert.ok(Math.abs(anchor.y - anchored) <= 2, `anchor drift ${anchored - anchor.y}px`)
  const after = await page.evaluate(() => { const el=document.querySelector('.transcript'); return { height:el.scrollHeight, top:el.scrollTop, rows:[...el.querySelectorAll('.virtual-message-row')].map(r=>r.textContent) } })
  assert.ok(after.height > before.height, 'scrolling up automatically prepends history')
  assert.ok(after.top > 1000, 'prepend compensates scroll rather than jumping to oldest')
  assert.equal(errors.length, 0, errors.join('\n'))
  console.log(JSON.stringify({ initialMs, historyRequests, anchorDrift: anchored - anchor.y, before, after: { height: after.height, top: after.top }, errors }))
} finally { await browser?.close(); await new Promise(r=>server.close(r)) }
