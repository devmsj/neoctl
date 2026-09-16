// Real production App regression. Build is coordinated by the caller; this suite never builds.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createObservabilityBrowser, observabilitySnapshot } from './observability-browser-fixture.mjs'

const initialModel = 'private-model-not-in-catalog'
const longModel = `custom-${'long-model-name-'.repeat(12)}`
function snapshot(busy = false, id = 'settings-session') {
  return observabilitySnapshot({
    session: { sessionId: id, title: id }, busy,
    status: { phase: busy ? 'thinking' : 'ready', metrics: { model: initialModel, contextWindowTokens: 100000, estimatedInputTokens: 10000, contextUsageRatio: 0.1 } },
    modelSettings: { model: initialModel }, fastMode: false, pendingSessionSettings: {},
    catalog: {
      commands: [], modelIds: ['gpt-test', 'plain-model', longModel],
      reasoning: ['default', 'off', 'low', 'high', 'xhigh'],
      modelReasoning: { 'gpt-test': ['low', 'high'], 'plain-model': [], [longModel]: [] },
    },
  })
}
async function mount(getSnapshot, handleApi) {
  const fixture = await createObservabilityBrowser(getSnapshot, handleApi)
  await fixture.page.addInitScript(() => {
    window.__settingsEvents = []
    window.EventSource = class extends EventTarget {
      constructor(url) { super(); this.url = url; window.__settingsEvents.push(this); queueMicrotask(() => this.dispatchEvent(new Event('open'))) }
      close() { this.closed = true }
    }
  })
  await fixture.page.reload()
  await fixture.page.locator('.model-trigger:visible').waitFor()
  return fixture
}
async function sync(page, value) {
  await page.evaluate(value => {
    const source = window.__settingsEvents.filter(source => !source.closed).at(-1)
    source.dispatchEvent(new MessageEvent('sync', { data: JSON.stringify(value) }))
  }, value)
  await page.waitForTimeout(80)
}
async function toast(page, expected) {
  await page.waitForFunction(expected => document.querySelector('.toast')?.textContent === expected, expected)
}
async function openModel(page) {
  await page.locator('.model-trigger:visible').click()
  const dialog = page.getByRole('dialog', { name: '选择模型', exact: true })
  await dialog.waitFor()
  assert.equal(await dialog.locator('small, p, [class*="description"], [class*="hint"]').count(), 0)
  return dialog
}
async function openContext(page) {
  await page.locator('.context-window-trigger:not(.model-trigger):visible, .mobile-context-button:not(.model-trigger):visible').click()
  const dialog = page.getByRole('dialog', { name: '上下文窗口', exact: true })
  await dialog.waitFor()
  assert.equal(await dialog.locator('label').textContent(), '上下文窗口')
  assert.equal(await dialog.locator('small, p, [class*="description"], [class*="hint"]').count(), 0)
  return dialog
}
async function confirm(page, dialog) {
  await dialog.getByRole('button', { name: '确认', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
}

for (const busy of [false, true]) {
  test(`session settings use scoped APIs and ${busy ? 'deferred' : 'immediate'} feedback without chat/cache pollution`, async () => {
    const current = snapshot(busy)
    const writes = []
    const fixture = await mount(() => current, async route => {
      const req = route.request()
      if (req.method() !== 'POST') return false
      const url = new URL(req.url())
      const body = req.postDataJSON()
      writes.push({ url, body })
      const result = { ok: true, deferred: busy }
      if (url.pathname === '/api/session-model') {
        result.modelSettings = { model: body.model, reasoning: body.reasoning === 'off' ? null : body.reasoning === 'default' ? undefined : { effort: body.reasoning } }
        if (busy) Object.assign(current.pendingSessionSettings, result.modelSettings)
        else current.modelSettings = result.modelSettings
      } else if (url.pathname === '/api/fast-mode') {
        result.fastMode = body.enabled
        if (busy) current.pendingSessionSettings.fastMode = body.enabled
        else current.fastMode = body.enabled
      } else if (url.pathname === '/api/context-window') {
        result.contextWindowK = Number(body.value)
        result.contextWindowTokens = Number(body.value) * 1000
        if (busy) current.pendingSessionSettings.contextWindowTokens = result.contextWindowTokens
        else Object.assign(current.status.metrics, { contextWindowTokens: result.contextWindowTokens, contextUsageRatio: 0.05 })
      } else if (url.pathname === '/api/compact') {
        if (busy) current.pendingSessionSettings.compact = true
        // Keep the request in flight long enough to exercise duplicate prevention.
        await new Promise(resolve => setTimeout(resolve, 150))
      } else throw new Error(`Unexpected settings POST: ${url.pathname}`)
      await route.fulfill({ json: result })
      return true
    })
    try {
      const { page } = fixture
      const suffix = busy ? '将在下一轮生效' : '已生效'
      let dialog = await openModel(page)
      assert.equal(await dialog.getByRole('radio', { name: initialModel, exact: true }).isChecked(), true)
      await dialog.getByRole('radio', { name: 'gpt-test', exact: true }).check()
      assert.equal(await dialog.getByRole('radio', { name: 'xhigh', exact: true }).count(), 0)
      await dialog.getByRole('radio', { name: 'high', exact: true }).check()
      await dialog.getByRole('radio', { name: 'plain-model', exact: true }).check()
      assert.equal(await dialog.getByRole('radio', { name: 'high', exact: true }).count(), 0)
      assert.equal(await dialog.getByRole('radio', { name: '默认', exact: true }).isChecked(), true)
      await dialog.getByRole('radio', { name: 'gpt-test', exact: true }).check()
      await dialog.getByRole('radio', { name: 'high', exact: true }).check()
      await confirm(page, dialog)
      await toast(page, `模型${suffix}`)
      await sync(page, current)
      assert.match(await page.locator('.model-trigger:visible').textContent(), /gpt-test.*high/)
      dialog = await openModel(page)
      assert.equal(await dialog.getByRole('radio', { name: 'gpt-test', exact: true }).isChecked(), true)
      assert.equal(await dialog.getByRole('radio', { name: 'high', exact: true }).isChecked(), true)
      await page.keyboard.press('Escape')
      await dialog.waitFor({ state: 'hidden' })
      assert.equal(await page.locator('.model-trigger:visible').evaluate(el => el === document.activeElement), true)

      await page.locator('.fast-mode-button:visible').click()
      await toast(page, `快速模式${suffix}`)
      await sync(page, current)
      assert.equal(await page.locator('.fast-mode-button:visible').getAttribute('aria-pressed'), 'true')
      const beforeContext = await page.locator('.context-window-trigger:not(.model-trigger):visible strong').textContent()
      dialog = await openContext(page)
      await dialog.getByRole('textbox').fill('200')
      await confirm(page, dialog)
      await toast(page, `上下文窗口${suffix}`)
      await sync(page, current)
      if (busy) assert.equal(await page.locator('.context-window-trigger:not(.model-trigger):visible strong').textContent(), beforeContext)
      dialog = await openContext(page)
      assert.equal(await dialog.getByRole('textbox').inputValue(), '200')
      await page.keyboard.press('Escape')

      const compact = page.locator('.compact-button:visible')
      assert.equal(await compact.isEnabled(), true, 'busy session must allow compaction')
      await compact.click()
      assert.equal(await compact.isDisabled(), true)
      await toast(page, `压缩会话${suffix}`)
      await sync(page, current)
      assert.equal(await compact.isDisabled(), busy)
      assert.equal(await page.locator('.queued-input').count(), 0)
      assert.deepEqual(writes.map(({ url }) => url.pathname), ['/api/session-model', '/api/fast-mode', '/api/context-window', '/api/compact'])
      assert.deepEqual(writes.map(({ body }) => body), [{ model: 'gpt-test', reasoning: 'high' }, { enabled: true }, { value: '200' }, {}])
      for (const { url } of writes) {
        assert.equal(url.searchParams.get('sessionId'), 'settings-session')
        assert.ok(url.searchParams.get('tabId'))
      }
      assert.equal(fixture.requests.some(({ url, method }) => method === 'POST' && /\/api\/(submit|login)/.test(url)), false)
      assert.deepEqual(current.lines, [])
      if (busy) {
        // Actual next-round snapshot clears pending and supplies effective metrics/settings.
        current.modelSettings = { model: current.pendingSessionSettings.model, reasoning: current.pendingSessionSettings.reasoning }
        current.fastMode = current.pendingSessionSettings.fastMode
        Object.assign(current.status.metrics, { contextWindowTokens: 200000, contextUsageRatio: 0.05 })
        current.pendingSessionSettings = {}
        await sync(page, current)
        assert.match(await page.locator('.model-trigger:visible').textContent(), /gpt-test.*high/)
        assert.equal(await page.locator('.fast-mode-button:visible').getAttribute('aria-pressed'), 'true')
        assert.equal(await compact.isEnabled(), true)
      }
      assert.deepEqual(fixture.errors, [])
    } finally { await fixture.close() }
  })
}

test('model and context dialogs stay minimal, keyboard-operable and within mobile viewports', async () => {
  const current = snapshot(true)
  current.modelSettings = { model: longModel }
  const fixture = await mount(() => current)
  try {
    const { page } = fixture
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 700 })
      await page.locator('.mobile-session-options').evaluate(el => { el.open = true })
      assert.equal(await page.locator('.mobile-session-options .model-trigger').isVisible(), true)
      let dialog = await openModel(page)
      await dialog.getByRole('searchbox').fill('plain')
      assert.equal(await dialog.locator('.session-model-option').count(), 1)
      await dialog.getByRole('radio', { name: 'plain-model', exact: true }).check()
      assert.deepEqual(await dialog.locator('.session-reasoning-options span').allTextContents(), ['默认', '关闭'])
      const bounds = await dialog.evaluate(el => {
        const rect = el.getBoundingClientRect()
        return { left: rect.left, right: rect.right, bottom: rect.bottom, overflow: el.scrollWidth > el.clientWidth + 1 }
      })
      assert.ok(bounds.left >= 0 && bounds.right <= width && bounds.bottom <= 700)
      assert.equal(bounds.overflow, false)
      await dialog.getByRole('button', { name: '关闭模型选择' }).click()
      dialog = await openContext(page)
      assert.equal(await dialog.evaluate(el => el.scrollWidth > el.clientWidth + 1), false)
      await dialog.getByRole('button', { name: '取消' }).click()
      assert.equal(await page.locator('.composer').evaluate(el => el.scrollWidth > el.clientWidth + 1), false)
      assert.equal(await page.locator('.compact-button:visible').isEnabled(), true)
    }
    assert.deepEqual(fixture.errors, [])
  } finally { await fixture.close() }
})

test('next-round SSE overtaking deferred HTTP cannot resurrect pending settings', async () => {
  const current = snapshot(true)
  let release
  let posted
  let reads = 0
  const fixture = await mount(() => current, async route => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.pathname === '/api/state') reads += 1
    if (request.method() !== 'POST') return false
    const body = request.postDataJSON()
    posted = url.pathname
    await new Promise(resolve => { release = resolve })
    await route.fulfill({ json: {
      ok: true, deferred: true, fastMode: body.enabled,
      modelSettings: { model: body.model }, contextWindowTokens: Number(body.value) * 1000,
    } })
    return true
  })
  try {
    const { page } = fixture
    async function overtake(path, update) {
      for (let attempts = 0; posted !== path && attempts < 100; attempts += 1) await page.waitForTimeout(10)
      assert.equal(posted, path)
      update()
      current.pendingSessionSettings = {}
      await sync(page, current)
      const priorReads = reads
      release()
      for (let attempts = 0; reads === priorReads && attempts < 100; attempts += 1) await page.waitForTimeout(10)
      assert.ok(reads > priorReads, 'overtaken HTTP acknowledgement requires owner-scoped state reconciliation')
      await page.waitForTimeout(60)
      posted = undefined
    }
    let dialog = await openModel(page)
    await dialog.getByRole('radio', { name: 'plain-model', exact: true }).check()
    await dialog.getByRole('button', { name: '确认' }).click()
    await overtake('/api/session-model', () => { current.modelSettings = { model: 'plain-model' } })
    await dialog.waitFor({ state: 'hidden' })
    await page.locator('.fast-mode-button:visible').click()
    await overtake('/api/fast-mode', () => { current.fastMode = true })
    dialog = await openContext(page)
    await dialog.getByRole('textbox').fill('200')
    await dialog.getByRole('button', { name: '确认' }).click()
    await overtake('/api/context-window', () => { Object.assign(current.status.metrics, { contextWindowTokens: 200000, contextUsageRatio: 0.05 }) })
    await dialog.waitFor({ state: 'hidden' })
    await page.locator('.compact-button:visible').click()
    await overtake('/api/compact', () => {})
    assert.equal(await page.locator('.compact-button:visible').isEnabled(), true, 'no permanent synthetic pending compact')
    // A later external update is not masked by stale pending model/fast/context values.
    current.modelSettings = { model: initialModel, reasoning: { effort: 'high' } }
    current.pendingSessionSettings = { model: 'plain-model' }
    current.fastMode = false
    current.status.metrics.contextWindowTokens = 100000
    await sync(page, current)
    dialog = await openModel(page)
    assert.equal(await dialog.getByRole('radio', { name: '默认', exact: true }).isChecked(), true, 'missing pending reasoning must not retain old high effort')
    await page.keyboard.press('Escape')
    assert.equal(await page.locator('.fast-mode-button:visible').getAttribute('aria-pressed'), 'false')
    dialog = await openContext(page)
    assert.equal(await dialog.getByRole('textbox').inputValue(), '100')
    await page.keyboard.press('Escape')
    assert.deepEqual(fixture.errors, [])
  } finally { release?.(); await fixture.close() }
})

test('queued fast toggles and modal responses keep their originating session across navigation', async () => {
  let current = snapshot(true, 'session-a')
  const writes = []
  const releases = []
  const fixture = await mount(() => current, async route => {
    const request = route.request()
    if (request.method() !== 'POST') return false
    const url = new URL(request.url())
    const body = request.postDataJSON()
    writes.push({ url, body })
    if (writes.length === 1 || url.pathname !== '/api/fast-mode') await new Promise(resolve => releases.push(resolve))
    await route.fulfill({ json: { ok: true, deferred: true, fastMode: body.enabled, modelSettings: { model: body.model, reasoning: { effort: body.reasoning } }, contextWindowTokens: Number(body.value) * 1000 } })
    return true
  })
  try {
    const { page } = fixture
    await page.locator('.fast-mode-button:visible').click()
    await page.locator('.fast-mode-button:visible').click()
    await page.waitForFunction(() => document.querySelector('.fast-mode-button.syncing'))
    let dialog = await openModel(page)
    await dialog.getByRole('radio', { name: 'gpt-test', exact: true }).check()
    await dialog.getByRole('button', { name: '确认' }).click()
    await page.keyboard.press('Escape')
    dialog = await openContext(page)
    await dialog.getByRole('textbox').fill('300')
    await dialog.getByRole('button', { name: '确认' }).click()
    await page.keyboard.press('Escape')
    current = snapshot(false, 'session-b')
    await page.locator('.nav button').filter({ hasText: '新建' }).first().click()
    await page.waitForFunction(() => document.querySelector('.toast')?.textContent === '已创建新会话')
    await page.locator('.model-trigger:visible').waitFor()
    const postNavigationToast = await page.locator('.toast').textContent()
    for (const release of releases) release()
    await page.waitForTimeout(350)
    assert.equal(writes.filter(({ url }) => url.pathname === '/api/fast-mode').length, 2)
    for (const { url } of writes) assert.equal(url.searchParams.get('sessionId'), 'session-a')
    assert.equal(await page.locator('.fast-mode-button:visible').getAttribute('aria-pressed'), 'false')
    assert.match(await page.locator('.model-trigger:visible').textContent(), /private-model/)
    assert.equal(await page.locator('.toast').textContent(), postNavigationToast)
    dialog = await openContext(page)
    assert.equal(await dialog.getByRole('textbox').inputValue(), '100')
    await page.keyboard.press('Escape')
    assert.deepEqual(fixture.errors, [])
  } finally {
    for (const release of releases) release()
    await fixture.close()
  }
})
