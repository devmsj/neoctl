import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createObservabilityBrowser, observabilitySnapshot } from './observability-browser-fixture.mjs'

test('production worker colors an open live code fence using the real theme', async () => {
  const fixture = await createObservabilityBrowser(observabilitySnapshot({
    busy: true, status: { phase: 'responding' },
    lines: [{ id: 'live-code', kind: 'assistant', live: true, text: String.raw`行内 $e^{i\pi}+1=0$。

\[\frac{1}{2}\]

` + '```typescript\nconst title: string = "live";\nconst count = 42;\n' }],
  }))
  try {
    const { page } = fixture
    await page.locator('.streaming-markdown-content .hljs-keyword').first().waitFor()
    assert.equal(await page.locator('.streaming-markdown-content pre').getAttribute('data-lang'), 'typescript')
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme }, theme)
      const colors = await page.locator('.streaming-markdown-content code').evaluate(el => ({
        keyword: getComputedStyle(el.querySelector('.hljs-keyword')).color,
        string: getComputedStyle(el.querySelector('.hljs-string')).color,
        number: getComputedStyle(el.querySelector('.hljs-number')).color,
      }))
      assert.equal(new Set(Object.values(colors)).size, 3)
    }
    await page.waitForFunction(() => document.querySelectorAll('.streaming-markdown-content .katex').length === 2)
    assert.equal(await page.locator('.math-display .katex').count(), 1)
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 })
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    }
    assert.deepEqual(fixture.errors, [])
  } finally { await fixture.close() }
})
