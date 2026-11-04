import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createObservabilityBrowser, observabilitySnapshot } from './observability-browser-fixture.mjs'

function snapshot(extra = {}) {
  return observabilitySnapshot({ session: { sessionId: 'fast-session' }, fastMode: false, fastModeRevision: 0, pendingSessionSettings: {}, ...extra })
}
async function mount(current, api) {
  const fixture = await createObservabilityBrowser(() => current, api)
  await fixture.page.addInitScript(() => {
    window.__sources = []
    window.EventSource = class extends EventTarget {
      constructor() { super(); window.__sources.push(this); queueMicrotask(() => this.dispatchEvent(new Event('open'))) }
      close() { this.closed = true }
    }
  })
  await fixture.page.reload()
  await fixture.page.locator('.fast-mode-button:visible').waitFor()
  await fixture.page.waitForFunction(() => window.__sources?.some(source => !source.closed))
  return fixture
}
async function emit(page, type, payload) {
  await page.evaluate(({ type, payload }) => window.__sources.filter(s => !s.closed).at(-1).dispatchEvent(new MessageEvent(type, { data: JSON.stringify(payload) })), { type, payload })
}
async function toast(page, text) { await page.waitForFunction(text => document.querySelector('.toast')?.textContent === text, text) }
const fallback = '快速模式不可用，已切换普通模式，继续执行'
for (const busy of [false, true]) test(`fast toggle messages, deferred=${busy}`, async () => {
  const current = snapshot({ busy })
  const fixture = await mount(current, async route => {
    if (route.request().method() !== 'POST') return false
    const enabled = route.request().postDataJSON().enabled
    current.fastModeRevision++
    if (busy) current.pendingSessionSettings.fastMode = enabled
    else current.fastMode = enabled
    await route.fulfill({ json: { ok: true, fastMode: enabled, fastModeRevision: current.fastModeRevision, deferred: busy } }); return true
  })
  try {
    const button = fixture.page.locator('.fast-mode-button:visible')
    await button.click()
    await toast(fixture.page, busy ? '快速模式将在下一轮 API 调用时生效，消耗倍率增加' : '已开启快速模式，消耗倍率增加')
    assert.equal(await button.getAttribute('aria-pressed'), 'true')
    await button.click()
    await toast(fixture.page, busy ? '普通模式将在下一轮 API 调用时生效' : '已切换普通模式')
    assert.equal(await button.getAttribute('aria-pressed'), 'false')
  } finally { await fixture.close() }
})

test('fallback resets switch, rejects old snapshots and another session notification', async () => {
  const current = snapshot({ fastMode: true, fastModeRevision: 1 })
  const fixture = await mount(current)
  try {
    const { page } = fixture
    await emit(page, 'fast-mode.fallback', { sessionId: 'other', revision: 2 })
    assert.equal(await page.locator('.fast-mode-button:visible').getAttribute('aria-pressed'), 'true')
    Object.assign(current, { fastMode: false, fastModeRevision: 2 })
    await emit(page, 'sync', current)
    await emit(page, 'fast-mode.fallback', { sessionId: 'fast-session', revision: 2 })
    await toast(page, fallback)
    assert.equal(await page.locator('.fast-mode-button:visible').getAttribute('aria-pressed'), 'false')
    await emit(page, 'sync', snapshot({ fastMode: true, fastModeRevision: 1 }))
    await page.waitForTimeout(80)
    assert.equal(await page.locator('.fast-mode-button:visible').getAttribute('aria-pressed'), 'false')
    assert.deepEqual(fixture.errors, [])
  } finally { await fixture.close() }
})

for (const newerChoice of [false, true]) test(`fallback versus pending toggle: newer=${newerChoice}`, async () => {
  const current = snapshot({ fastMode: newerChoice, fastModeRevision: 1 })
  let resolvePost, signalPost
  const post = new Promise(r => { signalPost = r })
  const wait = new Promise(r => { resolvePost = r })
  const fixture = await mount(current, async route => {
    if (route.request().method() !== 'POST') return false
    signalPost(); await wait
    await route.fulfill({ json: { ok: true, fastMode: true, fastModeRevision: newerChoice ? 3 : 1, deferred: false } }); return true
  })
  try {
    const { page } = fixture
    // false: old enabling response arrives after fallback. true: two queued clicks end in a newer enabling choice.
    await page.locator('.fast-mode-button:visible').click()
    if (newerChoice) await page.locator('.fast-mode-button:visible').click()
    await post
    Object.assign(current, { fastMode: false, fastModeRevision: 2 })
    await emit(page, 'sync', current)
    await emit(page, 'fast-mode.fallback', { sessionId: 'fast-session', revision: 2 })
    if (newerChoice) Object.assign(current, { fastMode: true, fastModeRevision: 3 })
    resolvePost()
    await toast(page, newerChoice ? '已开启快速模式，消耗倍率增加' : fallback)
    assert.equal(await page.locator('.fast-mode-button:visible').getAttribute('aria-pressed'), String(newerChoice))
  } finally { resolvePost(); await fixture.close() }
})

test('failed toggle restores existing state using unified notification', async () => {
  const fixture = await mount(snapshot(), async route => {
    if (route.request().method() !== 'POST') return false
    await route.fulfill({ status: 500, json: { ok: false, error: 'failed' } }); return true
  })
  try {
    await fixture.page.locator('.fast-mode-button:visible').click()
    await toast(fixture.page, '切换失败，已恢复原状态')
    assert.equal(await fixture.page.locator('.fast-mode-button:visible').getAttribute('aria-pressed'), 'false')
  } finally { await fixture.close() }
})
