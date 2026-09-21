import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { marked as standardMarked } from 'marked'
import { marked } from '../src/markdown.mjs'

const sample = JSON.parse(readFileSync(new URL('./fixtures/lianhu-markdown.json', import.meta.url), 'utf8'))

test('renders the original Lianhu response without changing its text', () => {
  const html = marked.parse(sample)
  assert.ok(html.includes('<strong>莲湖区在西安主城区内，可以先参考刚才的西安城区预报。</strong>我另外'))
  assert.ok(html.includes('<strong>在莲湖区出门：</strong>长袖'))
  assert.equal((html.match(/<strong>/g) || []).length, 2)
  assert.equal((html.match(/<tr>/g) || []).length, 6)
  assert.ok(html.includes('href="https://www.weather.com.cn/weather/101110101.shtml"'))
  assert.ok(!html.includes('**'))
})

test('supports CJK punctuation adjacent to following prose, including links inside bold', () => {
  for (const [source, expected] of [
    ['前文**提示：**正文', '前文<strong>提示：</strong>正文'],
    ['**“注意”**接下来', '<strong>“注意”</strong>接下来'],
    ['**参见[说明](https://example.com)：**正文', '<strong>参见<a href="https://example.com">说明</a>：</strong>正文'],
  ]) assert.equal(marked.parse(source).trim(), `<p>${expected}</p>`)
})

test('leaves standard Markdown, literal syntax, code and link destinations alone', () => {
  for (const source of [
    '**正常**文字', '**标题：** 正文', '**English:**next',
    '** 标题：**正文', '**标题： **正文', '**未闭合',
    '\\**标题：**正文', '***标题：***正文',
    '`**标题：**正文`', '`跨行\n**标题：**正文`',
    '    **标题：**正文', '\t**标题：**正文',
    '```md\n**标题：**正文\n```',
    '> ```md\n> **标题：**正文\n> ```',
    '- 示例\n\n  ```md\n  **标题：**正文\n  ```',
    '[链接](https://example.com/**标题：**正文)',
    '<span title="**标题：**正文">text</span>',
    '<pre>**标题：**正文</pre>',
    'foo_bar _baz', '2 ** 3 ** 4',
  ]) assert.equal(marked.parse(source), standardMarked.parse(source), source)
})
