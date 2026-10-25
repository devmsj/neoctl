import assert from 'node:assert/strict'
import { test } from 'node:test'
import { marked } from '../src/markdown.mjs'

test('math tokenization preserves TeX before markdown and supports four delimiters', () => {
  const html = marked.parse(String.raw`行内 $x_1^2 + \alpha$ 和 \(\frac{a}{b}\)。

$$
\begin{pmatrix}1 & 2 \\ 3 & 4\end{pmatrix}
$$

\[E = mc^2\]
`)
  assert.equal((html.match(/language-neo-math-inline/g) || []).length, 2)
  assert.equal((html.match(/language-neo-math-display/g) || []).length, 2)
  assert.ok(html.includes(String.raw`x_1^2 + \alpha`))
  assert.ok(html.includes('1 &amp; 2'))
})

test('code, escaped dollars, prices and incomplete formulas stay literal', () => {
  for (const source of ['`$x$`', '```js\nconst price = "$5"; // $x$\n```', String.raw`\$x\$`, '$5 and $10', '$ x $', '$x', '$$\n\\frac{x}{']) {
    assert.ok(!marked.parse(source).includes('language-neo-math'), source)
  }
})

test('math does not emit arbitrary markup before sanitization', () => {
  const html = marked.parse('$<img src=x onerror=alert(1)>$')
  assert.ok(html.includes('&lt;img'))
  assert.ok(!html.includes('<img'))
})
