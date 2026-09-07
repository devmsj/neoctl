// Shared read-only UI regression fixture. Does not start a model or execute tools.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { resolve, extname, sep, join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

export async function createObservabilityBrowser(snapshot, handleApi) {
  const require = createRequire(import.meta.url)
  let playwright
  for (const path of [process.env.PLAYWRIGHT_CORE_PATH, '../desktop/.cache/ui-test/node_modules/playwright-core', join(tmpdir(), 'neoctl-observability-tests/node_modules/playwright-core'), 'playwright-core'].filter(Boolean)) {
    try { playwright = require(path); break } catch {}
  }
  if (!playwright) throw new Error('Set PLAYWRIGHT_CORE_PATH to an installed playwright-core directory')
  const dist = fileURLToPath(new URL('./dist/', import.meta.url))
  const server = createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url, 'http://localhost').pathname
      const path = resolve(dist, pathname === '/' ? 'index.html' : '.' + pathname)
      if (!path.startsWith(resolve(dist) + sep)) { res.writeHead(403); res.end(); return }
      res.setHeader('Content-Type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[extname(path)] || 'application/octet-stream')
      res.end(await readFile(path))
    } catch { res.writeHead(404); res.end() }
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  let browser
  try {
    browser = await playwright.chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true })
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    const requests = []
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/api/**', async route => {
      requests.push({ url: route.request().url(), method: route.request().method() })
      if (handleApi && await handleApi(route)) return
      await route.fulfill({ json: route.request().url().includes('/api/state') ? (typeof snapshot === 'function' ? snapshot() : snapshot) : {} })
    })
    await page.route('**/events', route => route.fulfill({ contentType: 'text/event-stream', body: '' }))
    const url = `http://127.0.0.1:${server.address().port}/`
    await page.goto(url)
    return { browser, page, requests, errors, url, close: async () => { await browser.close(); await new Promise(r => server.close(r)) } }
  } catch (error) {
    await browser?.close()
    await new Promise(r => server.close(r))
    throw error
  }
}

export function observabilitySnapshot(overrides = {}) {
  return {
    lines: [], status: { phase: 'ready' }, backgroundTasks: [], agentTaskHistory: [], backgroundTaskCount: 0,
    catalog: { commands: [], modelIds: [], reasoning: [] }, session: { sessionId: 'obs-session', title: 'Observability regression' }, interactive: {},
    ...overrides,
  }
}
