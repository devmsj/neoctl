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
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const snapshot = {
    lines: [
      { id: 'current-live', kind: 'tool', toolName: 'image_create', toolUseId: 'tool-current-live', title: '图片生成', text: JSON.stringify({ mode: 'generate', prompt: '可爱的蓝猫' }), live: true, presentationLevel: 'primary' },
      { id: 'current-result', kind: 'tool', toolName: 'image_create', toolUseId: 'tool-current-result', title: '图片生成', text: 'Generated 1 image\nopenai · gpt-image-2 · 1024x1024 · png', live: false, presentationLevel: 'primary' },
      { id: 'current-image', kind: 'tool', parentToolName: 'image_create', parentToolUseId: 'tool-current-result', text: '可爱的蓝猫', image: { src: '/api/images/current', label: '可爱的蓝猫', mimeType: 'image/png', available: true, blockIndex: 1 } },
      { id: 'legacy-result', kind: 'tool', toolName: 'image2', toolUseId: 'tool-legacy', title: '旧图片工具', text: 'Generated 1 image', live: false, presentationLevel: 'primary' },
    ],
    status: { phase: 'running_tools', currentTool: { name: 'image_create' } },
    backgroundTasks: [],
    agentTaskHistory: [],
    backgroundTaskCount: 0,
    catalog: { commands: [], modelIds: [], reasoning: [] },
    session: { sessionId: 'fake-image-create', title: 'Image create browser regression' },
    interactive: {},
  }
  await page.route('**/api/**', (route) => {
    if (route.request().url().includes('/api/images/')) return route.continue()
    return route.fulfill({ json: route.request().url().includes('/api/state') ? snapshot : {} })
  })
  await page.route('**/events', (route) => route.fulfill({ contentType: 'text/event-stream', body: '' }))
  await page.goto(`http://127.0.0.1:${server.address().port}/`)

  const imageShells = page.locator('.image2-result-shell')
  assert.equal(await imageShells.count(), 2, 'only image_create invocation/result lines use the rich image UI')
  assert.equal(await page.locator('.image2-diamond-field').count(), 1, 'live image_create renders the generation animation')
  assert.equal(await page.locator('.image2-output-images img').count(), 1, 'image_create result renders its associated generated image')
  assert.equal(await page.locator('.image2-output-images .image-download').count(), 1, 'image_create result exposes a download action')
  assert.equal(await page.getByText('旧图片工具', { exact: true }).count(), 1, 'retired image2 remains a normal tool result instead of rich image UI')
  assert.equal(await page.locator('.image2-result-shell').filter({ hasText: '旧图片工具' }).count(), 0, 'retired image2 is not recognized by the image_create renderer')

  console.log('Edge image_create assertions passed: generation animation, result preview, download action, and no image2 compatibility')
} finally {
  await browser?.close()
  await new Promise((resolveClose) => server.close(resolveClose))
}
