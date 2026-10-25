import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createObservabilityBrowser, observabilitySnapshot } from './observability-browser-fixture.mjs'

test('IME composition keeps its anchor and never submits or consumes candidate Escape', async () => {
  const fixture = await createObservabilityBrowser(observabilitySnapshot())
  try {
    const { page } = fixture
    const input = page.getByRole('textbox', { name: '消息', exact: true })
    await input.fill('draft')
    await input.focus()
    const result = await input.evaluate(el => {
      const original = el.getBoundingClientRect().toJSON()
      el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
      el.value = '中文候选\n'.repeat(12)
      el.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true, inputType: 'insertCompositionText' }))
      const during = el.getBoundingClientRect().toJSON()
      const keys = [
        { key: 'Enter', isComposing: true },
        { key: 'Enter', keyCode: 229 },
        { key: 'Enter' }, // Vue's composing flag guards WebViews with unreliable isComposing.
        { key: 'Escape', isComposing: true },
      ].map(options => {
        const event = new KeyboardEvent('keydown', { ...options, bubbles: true, cancelable: true })
        el.dispatchEvent(event)
        return event.defaultPrevented
      })
      el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中文候选' }))
      return { original, during, keys }
    })
    assert.deepEqual(result.keys, [false, false, false, false])
    assert.equal(result.original.y, result.during.y)
    assert.equal(result.original.height, result.during.height)
    await page.waitForTimeout(100)
    assert.ok(await input.evaluate(el => el.getBoundingClientRect().height) > result.during.height)
    assert.equal(await input.inputValue(), '中文候选\n'.repeat(12))
    await input.fill('line one')
    await page.keyboard.press('Shift+Enter')
    assert.match(await input.inputValue(), /\n/)
    assert.ok(fixture.requests.every(request => request.method === 'GET'), 'no mutation or submission during IME')
    assert.deepEqual(fixture.errors, [])
  } finally { await fixture.close() }
})
