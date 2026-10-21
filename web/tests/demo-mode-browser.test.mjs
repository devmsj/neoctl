import assert from 'node:assert/strict'
import test from 'node:test'
import { createObservabilityBrowser, observabilitySnapshot } from './observability-browser-fixture.mjs'

async function mount(current, handler) {
  const fixture = await createObservabilityBrowser(() => current, async route => {
    if (new URL(route.request().url()).pathname === '/api/runtime-context') {
      await route.fulfill({ json: { protocolVersion: 2, revision: 1, sessionId: current.session.sessionId, prompt: { sections: [] }, tools: [], project: { documents: [] } } })
      return true
    }
    return handler?.(route) ?? false
  })
  await fixture.page.addInitScript(() => {
    window.__demoEvents = []
    window.EventSource = class extends EventTarget {
      constructor() { super(); window.__demoEvents.push(this); queueMicrotask(() => this.dispatchEvent(new Event('open'))) }
      close() { this.closed = true }
    }
  })
  await fixture.page.reload()
  await fixture.page.getByRole('button', { name: '运行上下文', exact: true }).waitFor()
  await fixture.page.waitForTimeout(120)
  return fixture
}
async function sync(page, snapshot) {
  await page.evaluate(value => window.__demoEvents.filter(source => !source.closed).at(-1).dispatchEvent(new MessageEvent('sync', { data: JSON.stringify(value) })), snapshot)
  await page.waitForTimeout(60)
}

test('five clicks start a scoped backend demo and show only the existing toast; user messages use normal submit', async () => {
  const current = observabilitySnapshot({ busy: false, session: { sessionId: 'demo-browser' } })
  const posts = []
  const f = await mount(current, async route => {
    if (route.request().method() !== 'POST') return false
    posts.push({ url: new URL(route.request().url()), body: route.request().postDataJSON() })
    await route.fulfill({ json: { ok: true } })
    return true
  })
  try {
    const title = f.page.getByRole('button', { name: '运行上下文', exact: true })
    for (let i = 0; i < 4; i++) await title.click()
    assert.equal(posts.length, 0)
    await f.page.locator('.composer textarea').click()
    for (let i = 0; i < 4; i++) await title.click()
    assert.equal(posts.length, 0, 'clicking elsewhere breaks the consecutive gesture')
    await title.click()
    await f.page.waitForFunction(() => document.querySelector('.toast')?.textContent === '已进入演示模式')
    assert.equal(posts.length, 1)
    assert.equal(posts[0].url.pathname, '/api/demo')
    assert.equal(posts[0].url.searchParams.get('sessionId'), 'demo-browser')
    assert.ok(posts[0].url.searchParams.get('tabId'))
    current.demoMode = true; current.busy = true; current.status.phase = 'thinking'
    await sync(f.page, current)
    assert.equal(await f.page.locator('[role="dialog"], .demo-banner, .demo-badge').count(), 0)
    const input = f.page.locator('.composer textarea')
    await input.fill('这条对话只发送')
    await f.page.getByRole('button', { name: '发送 ↵', exact: true }).click()
    assert.equal(posts.at(-1).url.pathname, '/api/submit')
    assert.equal(posts.at(-1).body.text, '这条对话只发送')
    assert.ok(!posts.some(post => post.url.pathname === '/api/interrupt' || post.url.pathname === '/api/submit-now'))
    for (let i = 0; i < 5; i++) await title.click()
    assert.equal(posts.filter(post => post.url.pathname === '/api/demo').length, 1)
    assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})

test('runtime context trigger text stays vertically centered in both themes and viewport sizes', async () => {
  const f = await mount(observabilitySnapshot({ busy: false }))
  try {
    for (const theme of ['light', 'dark']) {
      await f.page.evaluate(value => document.documentElement.dataset.theme = value, theme)
      for (const width of [1912, 390]) {
        await f.page.setViewportSize({ width, height: 948 })
        const geometry = await f.page.locator('[data-demo-trigger]').evaluate(element => {
          const range = document.createRange()
          range.selectNodeContents(element)
          const text = range.getBoundingClientRect()
          const trigger = element.getBoundingClientRect()
          const bar = element.closest('.runtime-context-bar').getBoundingClientRect()
          return {
            height: trigger.height,
            textOffset: text.top + text.height / 2 - (trigger.top + trigger.height / 2),
            barOffset: trigger.top + trigger.height / 2 - (bar.top + bar.height / 2),
          }
        })
        assert.ok(geometry.height >= 44, 'preserve the accessible click target')
        assert.ok(Math.abs(geometry.textOffset) <= 2, `${theme}/${width}: text offset ${geometry.textOffset}px`)
        assert.ok(Math.abs(geometry.barOffset) <= 1, `${theme}/${width}: trigger must be centered in its bar`)
      }
    }
    assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})

test('nonempty, busy and draft sessions never start demo', async () => {
  for (const overrides of [{ lines: [{ id: 1, kind: 'user', text: 'existing' }] }, { busy: true }, { draft: true }]) {
    const current = observabilitySnapshot({ busy: false, ...overrides })
    const f = await mount(current)
    try {
      if (overrides.draft) await f.page.locator('.composer textarea').fill('draft')
      const title = f.page.getByRole('button', { name: '运行上下文', exact: true })
      for (let i = 0; i < 5; i++) await title.click()
      assert.equal(f.requests.filter(req => req.method === 'POST' && req.url.includes('/api/demo')).length, 0)
      assert.deepEqual(f.errors, [])
    } finally { await f.close() }
  }
})
