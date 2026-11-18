import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createObservabilityBrowser, observabilitySnapshot } from './observability-browser-fixture.mjs'

const titles = { 'obs-session': 'First', other: 'Other', fresh: 'Fresh' }
// Mock API. `api.next` decides what an id-less /api/state returns (initial load vs. "new session");
// `api.gate` holds submit/upload-complete responses until the test releases them.
function sessionApi() {
  const api = { sessions: ['obs-session', 'other'], next: 'obs-session', submitStatus: 200, submits: [], gate: null }
  api.hold = () => { let release; api.gate = new Promise(r => { release = r }); return () => release() }
  api.handle = async (route) => {
    const request = route.request(), url = new URL(request.url())
    if (url.pathname === '/api/sessions/running') { await route.fulfill({ json: { runningSessionIds: [] } }); return true }
    if (url.pathname === '/api/sessions') {
      const sessions = api.sessions.map(sessionId => ({ sessionId, title: titles[sessionId] }))
      await route.fulfill({ json: { sessions, total: sessions.length, totalPages: 1, page: 1 } })
      return true
    }
    if (url.pathname === '/api/state') {
      const id = url.searchParams.get('sessionId') || api.next
      if (id === 'fail') { await route.fulfill({ status: 500, json: { error: 'create failed' } }); return true }
      await route.fulfill({ json: observabilitySnapshot({ session: { sessionId: id, title: titles[id] } }) })
      return true
    }
    if (url.pathname === '/api/submit') {
      api.submits.push({ sessionId: url.searchParams.get('sessionId'), body: request.postDataJSON() })
      await api.gate
      await route.fulfill({ status: api.submitStatus, json: api.submitStatus === 200 ? { ok: true } : { error: 'submit failed' } })
      return true
    }
    if (url.pathname === '/api/uploads/chunks') { await route.fulfill({ json: { uploadId: 'u1', chunkBytes: 1 << 20 } }); return true }
    if (url.pathname === '/api/uploads/chunks/u1') { await route.fulfill({ json: { offset: Number(request.headers()['x-upload-offset']) + (request.postDataBuffer()?.length || 0) } }); return true }
    if (url.pathname === '/api/uploads/chunks/u1/complete') {
      await api.gate
      await route.fulfill({ json: { file: { name: 'note.txt', absolutePath: 'C:/uploads/note.txt', size: 5 } } })
      return true
    }
    return false
  }
  return api
}
const twoSessions = route => sessionApi().handle(route)
async function openSession(page, title) {
  await page.mouse.move(0, 0) // a hover tooltip left by the previous click can cover the next item
  await page.locator('.quick-session').filter({ hasText: title }).click()
  await page.waitForFunction(t => document.querySelector('.quick-session[aria-current="true"]')?.textContent.includes(t), title)
}

// Per-keystroke cost including Vue's update flush, on a large draft. Each keystroke runs as its own task
// (like real typing), so a long task here means a single keystroke blocked the main thread for >50 ms.
export async function measureTyping(page, keystrokes = 300) {
  return page.locator('textarea[aria-label="消息"]').evaluate(async (el, count) => {
    const nextTask = () => new Promise(r => setTimeout(r, 0))
    await new Promise(r => setTimeout(r, 200)) // let fill/startup work finish before observing
    const long = []
    const observer = new PerformanceObserver(list => long.push(...list.getEntries().map(e => e.duration)))
    try { observer.observe({ entryTypes: ['longtask'] }) } catch {}
    const costs = []
    for (let i = 0; i < count; i++) {
      await nextTask()
      const t0 = performance.now()
      el.value += i % 40 === 39 ? '\n' : '字'
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '字' }))
      await Promise.resolve(); await Promise.resolve()
      costs.push(performance.now() - t0)
    }
    await new Promise(r => setTimeout(r, 100))
    observer.disconnect()
    costs.sort((a, b) => a - b)
    const at = q => costs[Math.min(costs.length - 1, Math.floor(costs.length * q))]
    return { p50: at(0.5), p95: at(0.95), max: costs.at(-1), longTasks: long.length }
  }, keystrokes)
}

test('unsent composer content follows its session across switches', async () => {
  const ui = await createObservabilityBrowser(observabilitySnapshot(), twoSessions)
  try {
    const { page } = ui
    const input = page.getByRole('textbox', { name: '消息', exact: true })
    await page.locator('.quick-session').first().waitFor()
    await input.fill('First 的草稿\n第二行')
    await openSession(page, 'Other')
    assert.equal(await input.inputValue(), '', 'another session starts with its own (empty) draft')
    await input.fill('Other 的草稿')
    await openSession(page, 'First')
    assert.equal(await input.inputValue(), 'First 的草稿\n第二行')
    await openSession(page, 'Other')
    assert.equal(await input.inputValue(), 'Other 的草稿')
    await input.fill('')
    await openSession(page, 'First')
    await openSession(page, 'Other')
    assert.equal(await input.inputValue(), '', 'cleared drafts stay cleared')
    // Typing right after a switch lands in the shown session.
    await input.type('后续输入')
    assert.equal(await input.inputValue(), '后续输入')
    assert.ok(ui.requests.every(r => r.method === 'GET'), 'drafts never submit or persist through the API')
    assert.deepEqual(ui.errors, [])
  } finally { await ui.close() }
})

async function until(check, message) {
  for (let i = 0; i < 250; i++) { if (await check()) return; await new Promise(r => setTimeout(r, 20)) }
  throw new Error(`timed out: ${message}`)
}
const composerInput = page => page.getByRole('textbox', { name: '消息', exact: true })

test('sending clears only its own session; a failed send returns to the session it was typed in', async () => {
  const api = sessionApi()
  const ui = await createObservabilityBrowser(observabilitySnapshot(), api.handle)
  try {
    const { page } = ui, input = composerInput(page)
    await page.locator('.quick-session').first().waitFor()
    await openSession(page, 'Other')
    await input.fill('Other 保留')
    await openSession(page, 'First')
    await input.fill('发送成功')
    await input.press('Enter')
    await until(() => api.submits.length === 1, 'first submit')
    assert.equal(api.submits[0].body.text, '发送成功')
    assert.equal(await input.inputValue(), '')
    await openSession(page, 'Other')
    assert.equal(await input.inputValue(), 'Other 保留', 'sending in First does not touch Other')

    await openSession(page, 'First')
    api.submitStatus = 500
    const release = api.hold()
    await input.fill('发送失败')
    await input.press('Enter')
    await until(() => api.submits.length === 2, 'second submit')
    await openSession(page, 'Other')
    release()
    await page.getByText('submit failed').first().waitFor()
    assert.equal(await input.inputValue(), 'Other 保留', 'a failed send never lands in the session shown now')
    await openSession(page, 'First')
    assert.equal(await input.inputValue(), '发送失败', 'the failed text is back in its own session')
    assert.deepEqual(ui.errors, [])
  } finally { await ui.close() }
})

test('a new session starts empty, keeps its own draft, and a failed creation restores the previous draft', async () => {
  const api = sessionApi()
  const ui = await createObservabilityBrowser(observabilitySnapshot(), api.handle)
  try {
    const { page } = ui, input = composerInput(page)
    const create = page.locator('.quick-action[aria-label="新建会话"]')
    await page.locator('.quick-session').first().waitFor()
    await input.fill('First 草稿')
    api.next = 'fresh'
    api.sessions = ['fresh', 'obs-session', 'other']
    await create.click()
    await page.waitForFunction(() => document.querySelector('.quick-session[aria-current="true"]')?.textContent.includes('Fresh'))
    assert.equal(await input.inputValue(), '')
    await input.fill('新会话草稿')
    await openSession(page, 'First')
    assert.equal(await input.inputValue(), 'First 草稿')
    await openSession(page, 'Fresh')
    assert.equal(await input.inputValue(), '新会话草稿', 'the new session kept the draft typed after it got its id')

    api.next = 'fail'
    await create.click()
    await page.getByText('新建会话失败，已恢复原会话').waitFor()
    assert.equal(await input.inputValue(), '新会话草稿')
    await openSession(page, 'First')
    assert.equal(await input.inputValue(), 'First 草稿')
    assert.deepEqual(ui.errors, [])
  } finally { await ui.close() }
})

test('an upload finishing after a switch is attached to the session it started in', async () => {
  const api = sessionApi()
  const ui = await createObservabilityBrowser(observabilitySnapshot(), api.handle)
  try {
    const { page } = ui, input = composerInput(page)
    await page.locator('.quick-session').first().waitFor()
    await input.fill('带附件')
    const release = api.hold()
    await page.locator('input[type="file"]').setInputFiles({ name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') })
    await until(() => ui.requests.some(r => r.url.includes('/u1/complete')), 'upload complete request')
    await openSession(page, 'Other')
    release()
    await page.getByText('已上传 1 个附件').first().waitFor()
    assert.equal(await page.locator('.file-attachment').count(), 0, 'nothing attached to Other')
    assert.equal(await input.inputValue(), '')
    await openSession(page, 'First')
    assert.equal(await input.inputValue(), '带附件')
    assert.equal(await page.locator('.file-attachment').count(), 1)
    assert.deepEqual(ui.errors, [])
  } finally { await ui.close() }
})

test('typing on a large draft stays fast', async () => {
  const ui = await createObservabilityBrowser(observabilitySnapshot(), twoSessions, process.env.NEO_WEB_DIST ? { dist: process.env.NEO_WEB_DIST } : {})
  try {
    const { page } = ui
    const input = page.getByRole('textbox', { name: '消息', exact: true })
    await page.locator('.quick-session').first().waitFor()
    await input.fill('长文本草稿。'.repeat(4000))
    const timing = await measureTyping(page)
    console.log(JSON.stringify({ dist: process.env.NEO_WEB_DIST || 'current', ...timing }))
    assert.ok(timing.p95 < 16, `p95 keystroke ${timing.p95.toFixed(2)} ms`)
    assert.equal(timing.longTasks, 0)
    assert.deepEqual(ui.errors, [])
  } finally { await ui.close() }
})
