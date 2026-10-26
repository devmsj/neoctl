import test from 'node:test'
import assert from 'node:assert/strict'
import { createObservabilityBrowser, observabilitySnapshot } from './observability-browser-fixture.mjs'

const text = '\n  first line\nsecond line\n\n\tindented  text\n<script>alert(1)</script>\nhttps://example.com/path\n'

test('pasted text is submitted unchanged and keeps whitespace after reload', async () => {
  const snapshot = observabilitySnapshot()
  let submitted
  const ui = await createObservabilityBrowser(() => snapshot, async route => {
    if (new URL(route.request().url()).pathname !== '/api/submit') return false
    submitted = route.request().postDataJSON()
    snapshot.lines = [{ id: 1, kind: 'user', text: submitted.text }]
    await route.fulfill({ json: { ok: true } })
    return true
  })
  try {
    const composer = ui.page.getByRole('textbox', { name: '消息', exact: true })
    await composer.waitFor()
    // Real browser paste, not a synthetic input event.
    await ui.page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
    await ui.page.evaluate(value => navigator.clipboard.writeText(value), text)
    await composer.focus()
    await composer.press('Control+V')
    await ui.page.waitForFunction(value => document.querySelector('textarea[aria-label="消息"]').value === value, text)
    await Promise.all([
      ui.page.waitForResponse(response => new URL(response.url()).pathname === '/api/submit'),
      composer.press('Enter'),
    ])
    assert.equal(submitted.text, text)
    await ui.page.reload()
    const message = ui.page.locator('.message.user .message-text')
    await message.waitFor()
    assert.equal(await message.textContent(), text)
    assert.equal(await message.evaluate(el => getComputedStyle(el).whiteSpace), 'pre-wrap')
    assert.equal(await message.locator('script').count(), 0)
    assert.equal(await message.locator('a').getAttribute('href'), 'https://example.com/path')
  } finally { await ui.close() }
})
