import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createObservabilityBrowser, observabilitySnapshot } from './observability-browser-fixture.mjs'

const code = '// 柔和配色，保留代码原文\nconst greeting = "Hello, neo";\nfunction welcome(name) {\n  return { message: greeting, count: 42, name };\n}\nconst dollars = "$x$";\n// ' + 'long-code-'.repeat(45)
const text = '## 更轻的阅读体验\n\n正文与 **重点**，使用 `npm run dev` 启动。[参考文档](https://example.com)。\n\n> 引用保留轻线条，不再套厚重卡片。\n\n- 第一项\n- 第二项\n\n```js\n' + code + '\n```\n\n| 字段 | 值 |\n| --- | --- |\n| model | neo |\n| path | ' + 'long_path_'.repeat(25) + ' |\n\n' + String.raw`行内公式 $E=mc^2$ 与 \(\frac{a}{b}\)。

$$
\int_0^1 x^2\,dx = \frac{1}{3}
$$

\[\begin{pmatrix}1 & 2 \\ 3 & 4\end{pmatrix}\]

错误公式 $\notARealCommand{x}$ 不影响其余消息。

$\href{javascript:alert(1)}{bad}$

<img src=x onerror="window.richXss=1"><script>window.richXss=2</script>
`

function contrast(a, b) {
  const lum = color => color.match(/[\d.]+/g).slice(0, 3).map(Number).map(v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4 }).reduce((s, v, i) => s + v * [.2126, .7152, .0722][i], 0)
  const x = lum(a), y = lum(b)
  return (Math.max(x, y) + .05) / (Math.min(x, y) + .05)
}

test('rich text, math, native scrollbars and icon-only queue work in both themes and narrow layouts', async () => {
  let releaseSend
  const fixture = await createObservabilityBrowser(observabilitySnapshot({
    queuedInput: '接着检查排队消息与代码样式。'.repeat(12),
    lines: [{ id: 'rich', kind: 'assistant', text }],
  }), async route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/prompt-library') { await route.fulfill({ json: { items: [{ id: 'review', title: '代码审查', content: '检查代码' }] } }); return true }
    if (path === '/api/queue/send-now') { await new Promise(r => { releaseSend = r }); await route.fulfill({ json: { interrupted: false } }); return true }
    if (path === '/api/queue/cancel') { await route.fulfill({ json: { cancelled: true } }); return true }
  })
  try {
    const { page } = fixture
    await page.locator('.message-text .katex').first().waitFor()
    const pre = page.locator('.message-text pre').first()
    assert.equal(await pre.locator('code').textContent(), code + '\n')
    assert.equal(await pre.locator('.katex').count(), 0)
    assert.equal(await page.locator('.math-display .katex').count(), 2)
    assert.ok(await page.locator('.katex-mathml math').count() >= 4)
    assert.equal(await page.locator('.math-fallback').first().textContent(), '$\\notARealCommand{x}$')
    assert.equal(await page.locator('.message-text a[href^="javascript:"], .message-text img, .message-text script').count(), 0)
    assert.equal(await page.evaluate(() => window.richXss), undefined)
    assert.equal(await pre.getAttribute('tabindex'), '0')
    assert.equal(await page.locator('.markdown-table-scroll').getAttribute('tabindex'), '0')
    for (const name of ['应用', '编辑']) {
      const button = page.locator('.prompt-card-actions').getByRole('button', { name, exact: true })
      assert.equal(await button.textContent(), '')
      assert.equal(await button.locator('svg').count(), 1)
    }
    const queue = page.getByRole('group', { name: '排队消息' })
    assert.deepEqual(await queue.locator('button').allTextContents(), ['', ''])
    assert.equal(await queue.locator('svg').count(), 3)
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme }, theme)
      const colors = await pre.evaluate(el => {
        const s = getComputedStyle(el)
        return { bg: s.backgroundColor, border: s.borderTopWidth, shadow: s.boxShadow, radius: s.borderRadius, tokens: [...el.querySelectorAll('[class^="hljs-"]')].map(t => getComputedStyle(t).color) }
      })
      assert.equal(colors.bg, theme === 'light' ? 'rgb(246, 247, 250)' : 'rgb(28, 34, 43)')
      assert.equal(colors.border, '1px'); assert.equal(colors.shadow, 'none'); assert.equal(colors.radius, '6px')
      assert.ok(new Set(colors.tokens).size >= 5)
      for (const color of colors.tokens) assert.ok(contrast(color, colors.bg) >= 4.5, `${theme}: ${color} on ${colors.bg}`)
      assert.equal(await queue.evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)')
      const scrollbar = await page.locator('.transcript').evaluate(el => ({ width: getComputedStyle(el, '::-webkit-scrollbar').width, track: getComputedStyle(el, '::-webkit-scrollbar-track').backgroundColor, arrow: getComputedStyle(el, '::-webkit-scrollbar-button').display }))
      assert.deepEqual(scrollbar, { width: '10px', track: 'rgba(0, 0, 0, 0)', arrow: 'none' })
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 1000 })
        await pre.scrollIntoViewIfNeeded()
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
        assert.equal(await page.locator('.transcript').evaluate(el => el.scrollWidth <= el.clientWidth + 1), true)
        await pre.focus()
        await pre.press('ArrowRight')
        await page.waitForTimeout(150)
        assert.ok(await pre.evaluate(el => el.scrollLeft > 0), 'long code scrolls with keyboard')
        await pre.evaluate(el => { el.scrollLeft = 0 })
        await mkdir(join(tmpdir(), 'neo-ui-review'), { recursive: true })
        await page.screenshot({ path: join(tmpdir(), 'neo-ui-review', `rich-${theme}-${width}.png`) })
        const table = page.locator('.markdown-table-scroll')
        assert.ok(await table.evaluate(el => el.scrollWidth > el.clientWidth), 'wide tables scroll rather than crushing columns')
        await table.focus()
        await table.press('ArrowRight')
        await page.waitForTimeout(150)
        assert.ok(await table.evaluate(el => el.scrollLeft > 0))
        await page.locator('.math-display').first().scrollIntoViewIfNeeded()
        await page.evaluate(() => document.fonts.ready)
        assert.equal(await page.locator('.math-display').first().evaluate(el => el.scrollWidth <= el.clientWidth + 1), true)
        await page.screenshot({ path: join(tmpdir(), 'neo-ui-review', `math-${theme}-${width}.png`) })
      }
    }
    await queue.getByRole('button', { name: '立即发送', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('.queued-message').getAttribute('aria-busy') === 'true')
    assert.equal(await queue.locator('button:disabled').count(), 2)
    releaseSend()
    await page.waitForFunction(() => !document.querySelector('.queued-message button').disabled)
    await queue.getByRole('button', { name: '取消排队', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('.toast')?.textContent.includes('已撤回'))
    assert.equal(fixture.requests.filter(r => r.url.includes('/api/queue/send-now')).length, 1)
    assert.equal(fixture.requests.filter(r => r.url.includes('/api/queue/cancel')).length, 1)
    assert.deepEqual(fixture.errors, [])
  } finally { releaseSend?.(); await fixture.close() }
})
