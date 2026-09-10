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
    let value = isSession ? sessions.get(owner) || { content: '', mode: 'inherit', effectiveContent: global.content, override: false, revision: `session-${owner}-1` } : global
    if (request.method() === 'POST') {
      const body = request.postDataJSON()
      writes.push({ path: url.pathname, owner, body })
      if (failSave) { await route.fulfill({ status: 409, json: { ok: false, errorCode: 'PROMPT_CONFIG_CONFLICT', error: 'conflict' } }); return true }
      assert.equal(body.revision, value.revision)
      value = { content: body.reset ? '' : body.content, revision: `${value.revision}-next`, ...(isSession ? { override: !body.reset, mode: body.reset ? 'inherit' : body.mode, effectiveContent: global.content + (body.reset ? '' : '\n' + body.content) } : {}) }
      if (isSession) sessions.set(owner, value)
      else global = value
    }
    await json({ ok: true, ...value }); return true
  })
  return { ...fixture, writes, getGlobal: () => global, seedSession: value => sessions.set(currentSession, value), setFail: value => { failSave = value }, setSession: value => { currentSession = value } }
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
    assert.equal(f.writes[0].body.mode, 'append')
    assert.equal(f.getGlobal().content, original)
    f.setSession('prompt-session-b')
    await f.page.evaluate(() => sessionStorage.clear())
    await f.page.reload()
    editor = await openSession(f.page)
    assert.equal(await editor.getByRole('textbox').inputValue(), '')
    f.setSession('prompt-session-a')
    await f.page.evaluate(() => sessionStorage.clear())
    await f.page.reload()
    editor = await openSession(f.page)
    assert.equal(await editor.getByRole('textbox').inputValue(), '仅 A 会话使用')
    await editor.getByRole('button', { name: '恢复默认', exact: true }).click()
    await f.page.waitForFunction(() => document.querySelector('.runtime-context-modal textarea')?.value === '')
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

test('runtime preview updates do not overwrite a session draft or its edit revision', async () => {
  const f = await mount()
  try {
    await f.page.addInitScript(() => {
      window.__eventSources = []
      window.EventSource = class extends EventTarget {
        constructor() { super(); window.__eventSources.push(this) }
        close() {}
      }
    })
    await f.page.reload()
    const editor = await openSession(f.page)
    await editor.getByRole('textbox').fill('KEEP_DRAFT')
    await f.page.evaluate(() => {
      const payload = { protocolVersion: 2, revision: 2, sessionId: 'prompt-session-a', prompt: { systemPrompt: 'NEW_TOOL_CAPABILITIES', sections: [], sessionPrompt: { deferred: false } }, tools: [], project: { documents: [] }, capabilities: {} }
      window.__eventSources.at(-1).dispatchEvent(new MessageEvent('runtime.context', { data: JSON.stringify(payload) }))
    })
    await f.page.waitForFunction(() => document.querySelector('.prompt-config-preview pre')?.textContent.includes('NEW_TOOL_CAPABILITIES'))
    assert.equal(await editor.getByRole('textbox').inputValue(), 'KEEP_DRAFT')
    await editor.getByRole('button', { name: '保存', exact: true }).click()
    await f.page.waitForFunction(() => document.querySelector('.toast')?.textContent === '提示词已保存')
    assert.equal(f.writes[0].body.content, 'KEEP_DRAFT')
    assert.equal(f.writes[0].body.revision, 'session-prompt-session-a-1')
    assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})

test('legacy prompt migration requires confirmation and never silently strips the original', async () => {
  const f = await mount()
  try {
    f.seedSession({ content: 'LEGACY_ORIGINAL', effectiveContent: 'LEGACY_ORIGINAL', revision: 'legacy-1', mode: 'legacy_full_override', override: true })
    const editor = await openSession(f.page)
    assert.equal(await editor.getByRole('textbox').inputValue(), 'LEGACY_ORIGINAL')
    await editor.getByRole('combobox').selectOption('append')
    f.page.once('dialog', dialog => dialog.dismiss())
    await editor.getByRole('button', { name: '保存', exact: true }).click()
    assert.equal(f.writes.length, 0)
    assert.equal(await editor.getByRole('textbox').inputValue(), 'LEGACY_ORIGINAL')
    await editor.getByRole('textbox').fill('USER_ONLY')
    f.page.once('dialog', dialog => dialog.accept())
    await editor.getByRole('button', { name: '保存', exact: true }).click()
    await f.page.waitForFunction(() => document.querySelector('.toast')?.textContent === '提示词已保存')
    assert.equal(f.writes[0].body.mode, 'append')
    assert.equal(f.writes[0].body.content, 'USER_ONLY')
    assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})
