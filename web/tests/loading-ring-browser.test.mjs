import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createObservabilityBrowser, observabilitySnapshot } from './observability-browser-fixture.mjs'
import { openGlobalSettings } from './settings-navigation.mjs'

test('pending operations use the shared ring; clocks remain time metadata only', async () => {
  for (const name of ['SettingsSaveButton', 'PromptConfigEditor', 'TaskStatusIcon']) {
    const source = await readFile(new URL(`../src/components/${name}.vue`, import.meta.url), 'utf8')
    assert.ok(source.includes('<LoadingRing'))
    assert.doesNotMatch(source, /name="clock"|\? 'clock'|\['clock'/)
  }
  const source = await readFile(new URL('../src/App.vue', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /\? 'clock'/)
  assert.match(source, /最近结束/)
  let release, started
  const saving = new Promise(resolve => { started = resolve })
  const blocked = new Promise(resolve => { release = resolve })
  let content = 'Initial prompt'
  const ui = await createObservabilityBrowser(observabilitySnapshot(), async route => {
    const req = route.request(), path = new URL(req.url()).pathname
    if (path === '/api/login') { await route.fulfill({json:{provider:'openai',providers:['openai'],fields:[],values:{}}}); return true }
    if (path !== '/api/prompt-config') return false
    if (req.method() === 'POST') { started(); await blocked; content = req.postDataJSON().content }
    await route.fulfill({json:{content,revision:'1'}}); return true
  })
  try {
    const p = ui.page
    await openGlobalSettings(p)
    await p.locator('[data-settings-page="prompt"]').click()
    await p.locator('.prompt-config-textarea').fill('Updated prompt')
    const button = p.locator('.prompt-config-editor .settings-save-button')
    await button.click(); await saving
    assert.equal(await button.getAttribute('aria-busy'), 'true')
    assert.equal(await button.locator('.loading-ring').count(), 1)
    assert.equal(await button.locator('.chrome-icon').count(), 0)
    const ring = await button.locator('.loading-ring').evaluate(el => ({ name:getComputedStyle(el).animationName, duration:getComputedStyle(el).animationDuration, stroke:getComputedStyle(el).stroke }))
    assert.equal(ring.name, 'composer-wait-spin'); assert.equal(ring.duration, '0.75s'); assert.notEqual(ring.stroke, 'none')
    release()
    await p.waitForFunction(()=>document.querySelector('.settings-save-button')?.getAttribute('aria-busy') === 'false')
    assert.equal(await button.locator('.loading-ring').count(), 0)
    assert.deepEqual(ui.errors, [])
  } finally { release(); await ui.close() }
})
