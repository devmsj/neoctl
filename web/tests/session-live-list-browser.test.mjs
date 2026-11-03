import test from 'node:test'
import assert from 'node:assert/strict'
import { createObservabilityBrowser, observabilitySnapshot } from './observability-browser-fixture.mjs'

async function streamFixture(snapshot, handler) {
  const f = await createObservabilityBrowser(snapshot, handler, { viewport: { width: 1180, height: 760 } })
  await f.page.addInitScript(() => {
    window.EventSource = class {
      constructor() { this.listeners = {}; window.sessionStream = this }
      addEventListener(name, listener) { this.listeners[name] = listener }
      close() {}
    }
  })
  await f.page.reload()
  return f
}

test('new session title remains in sidebar after switching; initial and continued dates stay grouped', async () => {
  const today = new Date().toISOString(), yesterday = new Date(Date.now() - 86400000).toISOString()
  const current = { sessionId: 'fresh', createdAt: today }
  const old = { sessionId: 'old', title: 'Yesterday session', updatedAt: yesterday }
  const snapshot = observabilitySnapshot({ session: current })
  const f = await streamFixture(snapshot, async route => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/sessions') { await route.fulfill({ json: { sessions: [old], page: 1, totalPages: 1, total: 1 } }); return true }
    if (url.pathname === '/api/state' && url.searchParams.get('sessionId') === 'old') { await route.fulfill({ json: observabilitySnapshot({ session: old }) }); return true }
    return false
  })
  try {
    const p = f.page
    await p.locator('.quick-session').nth(1).waitFor()
    assert.deepEqual(await p.locator('.quick-group').allTextContents(), ['今天', '昨天'])
    await p.evaluate(payload => window.sessionStream.listeners.sync({ data: JSON.stringify(payload) }), { ...snapshot, session: { ...current, title: 'Generated fresh title', updatedAt: today } })
    const fresh = p.locator('.quick-session').filter({ hasText: 'Generated fresh title' })
    await fresh.waitFor()
    await p.locator('.quick-session').filter({ hasText: old.title }).click()
    await p.waitForFunction(() => document.querySelector('.quick-session[aria-current="true"]')?.textContent.includes('Yesterday session'))
    assert.equal(await fresh.count(), 1, 'the newly persisted row must survive switching away before list refetch')
    assert.deepEqual(await p.locator('.quick-group').allTextContents(), ['今天', '昨天'])
    await p.evaluate(payload => window.sessionStream.listeners.sync({ data: JSON.stringify(payload) }), observabilitySnapshot({ session: { ...old, updatedAt: new Date(Date.now() + 1000).toISOString() } }))
    await p.waitForFunction(() => document.querySelectorAll('.quick-group').length === 1)
    assert.equal(await p.locator('.quick-session').first().textContent().then(s => s.trim()), old.title)
    assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})

test('focus refresh updates background titles, adds sessions and removes deleted rows without scroll reset', async () => {
  const now = Date.now(), iso = n => new Date(now - n * 1000).toISOString()
  const current = { sessionId: 's0', title: 'Current session', updatedAt: iso(0) }
  let sessions = [current, ...Array.from({ length: 9 }, (_, i) => ({ sessionId: `s${i + 1}`, title: `Background ${i + 1}`, updatedAt: iso(i + 1) }))]
  let calls = 0
  const f = await streamFixture(observabilitySnapshot({ session: current }), async route => {
    const url = new URL(route.request().url())
    if (url.pathname !== '/api/sessions') return false
    calls++
    const q = url.searchParams.get('q') || ''
    const matches = sessions.filter(s => !q || s.title.includes(q))
    await route.fulfill({ json: { sessions: matches, page: 1, totalPages: 1, total: matches.length } }); return true
  })
  try {
    const p = f.page
    await p.locator('.quick-session').nth(9).waitFor()
    const scroll = p.locator('.quick-scroll')
    await scroll.evaluate(el => { el.scrollTop = 40 })
    const top = await scroll.evaluate(el => el.scrollTop)
    sessions = [{ sessionId: 'external', title: 'New from another window', updatedAt: iso(-1) }, ...sessions.slice(0, -1).map(s => s.sessionId === 's1' ? { ...s, title: 'Background title ready' } : s)]
    await p.evaluate(() => window.dispatchEvent(new Event('focus')))
    await p.locator('.quick-session').filter({ hasText: 'Background title ready' }).waitFor()
    assert.equal(await p.locator('.quick-session').filter({ hasText: 'New from another window' }).count(), 1)
    assert.equal(await p.locator('.quick-session').filter({ hasText: 'Background 9' }).count(), 0)
    assert.equal(await scroll.evaluate(el => el.scrollTop), top)
    const before = calls
    await p.getByRole('button', { name: '搜索最近会话', exact: true }).click()
    await p.getByRole('searchbox', { name: '搜索最近会话标题' }).fill('Background title')
    await p.waitForFunction(() => document.querySelectorAll('.quick-session').length === 1)
    assert.ok(calls > before)
    assert.equal(await p.locator('.quick-session[aria-current="true"]').count(), 0, 'search must not inject the unrelated current row')
    assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})
