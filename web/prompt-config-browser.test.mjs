import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createObservabilityBrowser, observabilitySnapshot } from './observability-browser-fixture.mjs'

async function mount() {
  let global = { content: '## Agent Scaffold\nVersion default prompt', revision: 'global-1' }
  let currentSession = 'prompt-session-a'
  const sessions = new Map()
  const writes = []
  let failSave = false
  const fixture = await createObservabilityBrowser(() => observabilitySnapshot({ session: { sessionId: currentSession, title: currentSession } }), async route => {
    const request = route.request()
    const url = new URL(request.url())
    const json = value => route.fulfill({ json: value })
    if (url.pathname === '/api/login') { await json({ provider: 'openai', providers: ['openai'], fields: [], values: {} }); return true }
    if (url.pathname === '/api/runtime-context') {
      await json({ protocolVersion: 2, revision: 1, sessionId: currentSession, prompt: { sections: [], systemPrompt: global.content }, tools: [], project: { documents: [] }, capabilities: {} }); return true
    }
    if (url.pathname !== '/api/prompt-config' && url.pathname !== '/api/session-prompt') return false
    const isSession = url.pathname === '/api/session-prompt'
    const owner = url.searchParams.get('sessionId')
    let value = isSession ? sessions.get(owner) || { ...global, override: false, revision: `session-${owner}-1` } : global
    if (request.method() === 'POST') {
      const body = request.postDataJSON()
      writes.push({ path: url.pathname, owner, body })
      if (failSave) { await route.fulfill({ status: 409, json: { ok: false, errorCode: 'PROMPT_CONFIG_CONFLICT', error: 'conflict' } }); return true }
      assert.equal(body.revision, value.revision)
      value = { content: body.reset ? global.content : body.content, revision: `${value.revision}-next`, ...(isSession ? { override: !body.reset } : {}) }
      if (isSession) sessions.set(owner, value)
      else global = value
    }
    await json({ ok: true, ...value }); return true
  })
  return { ...fixture, writes, getGlobal: () => global, setFail: value => { failSave = value }, setSession: value => { currentSession = value } }
}

async function openGlobal(page) {
  await page.getByRole('button', { name: '模型配置', exact: true }).first().click()
  await page.getByRole('button', { name: '提示词配置', exact: true }).click()
  const editor = page.locator('.settings-page .prompt-config-editor')
  await editor.getByRole('textbox', { name: '系统提示词' }).waitFor()
  await page.waitForFunction(() => !document.querySelector('.settings-page .prompt-config-textarea')?.disabled)
  return editor
}
async function openSession(page) {
  await page.locator('.runtime-context-bar button').filter({ hasText: '系统提示词' }).click()
  const editor = page.locator('.runtime-context-modal .prompt-config-editor')
  await editor.getByRole('textbox', { name: '系统提示词' }).waitFor()
  await page.waitForFunction(() => !document.querySelector('.runtime-context-modal .prompt-config-textarea')?.disabled)
  return editor
}

test('model settings opens a clean secondary prompt form and reloads saved content', async () => {
  const f = await mount()
  try {
    const editor = await openGlobal(f.page)
    assert.equal(await editor.locator('small, p, [class*="hint"], [class*="description"]').count(), 0)
    assert.equal(await editor.getByRole('textbox').inputValue(), f.getGlobal().content)
    if (process.env.PROMPT_UI_SCREENSHOT_DIR) await f.page.screenshot({ path: `${process.env.PROMPT_UI_SCREENSHOT_DIR}/prompt-settings.png`, fullPage: true })
    await editor.getByRole('textbox').fill('## Agent Scaffold\n新的版本提示词')
    await editor.getByRole('button', { name: '保存', exact: true }).click()
    await f.page.waitForFunction(() => document.querySelector('.toast')?.textContent === '提示词已保存')
    assert.equal(f.getGlobal().content, '## Agent Scaffold\n新的版本提示词')
    await f.page.getByRole('button', { name: '返回模型配置' }).click()
    assert.equal(await f.page.locator('.prompt-config-editor').count(), 0)
    await f.page.getByRole('button', { name: '提示词配置', exact: true }).click()
    await f.page.waitForFunction(() => document.querySelector('.prompt-config-textarea')?.value.includes('新的版本提示词'))
    assert.equal(f.writes.length, 1)
    assert.equal(f.writes[0].path, '/api/prompt-config')
    assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})

test('session prompt saves only its owner and can reset without changing the version file', async () => {
  const f = await mount()
  try {
    const original = f.getGlobal().content
    let editor = await openSession(f.page)
    if (process.env.PROMPT_UI_SCREENSHOT_DIR) await f.page.screenshot({ path: `${process.env.PROMPT_UI_SCREENSHOT_DIR}/session-prompt.png`, fullPage: true })
    await editor.getByRole('textbox').fill('仅 A 会话使用')
    await editor.getByRole('button', { name: '保存', exact: true }).click()
    await f.page.waitForFunction(() => !Array.from(document.querySelectorAll('.runtime-context-modal button')).find(b => b.textContent === '恢复默认')?.disabled)
    assert.equal(f.writes[0].owner, 'prompt-session-a')
    assert.equal(f.getGlobal().content, original)
    f.setSession('prompt-session-b')
    await f.page.evaluate(() => sessionStorage.clear())
    await f.page.reload()
    editor = await openSession(f.page)
    assert.equal(await editor.getByRole('textbox').inputValue(), original)
    f.setSession('prompt-session-a')
    await f.page.evaluate(() => sessionStorage.clear())
    await f.page.reload()
    editor = await openSession(f.page)
    assert.equal(await editor.getByRole('textbox').inputValue(), '仅 A 会话使用')
    await editor.getByRole('button', { name: '恢复默认', exact: true }).click()
    await f.page.waitForFunction(original => document.querySelector('.runtime-context-modal textarea')?.value === original, original)
    assert.equal(f.writes.at(-1).body.reset, true)
    assert.equal(f.getGlobal().content, original)
    assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})

test('failed saves retain the draft and offer reload', async () => {
  const f = await mount()
  try {
    const editor = await openGlobal(f.page)
    f.setFail(true)
    await editor.getByRole('textbox').fill('保留此草稿')
    await editor.getByRole('button', { name: '保存', exact: true }).click()
    await editor.getByRole('alert').waitFor()
    assert.equal(await editor.getByRole('textbox').inputValue(), '保留此草稿')
    assert.match(await editor.getByRole('alert').innerText(), /重新加载/)
    await editor.getByRole('button', { name: '重新加载' }).click()
    await f.page.waitForFunction(() => document.querySelector('.prompt-config-textarea')?.value.includes('Version default prompt'))
    assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})

test('mobile prompt form stays within the viewport in dark mode', async () => {
  const f = await mount()
  try {
    await openGlobal(f.page)
    await f.page.setViewportSize({ width: 390, height: 844 })
    await f.page.evaluate(() => { document.documentElement.dataset.theme = 'dark' })
    assert.ok(await f.page.locator('.prompt-config-textarea').isVisible())
    assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true)
    const box = await f.page.locator('.prompt-config-textarea').boundingBox()
    assert.ok(box.x >= 0 && box.x + box.width <= 391)
    assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})
