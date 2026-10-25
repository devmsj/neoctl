import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { test } from 'node:test'
import { contentText } from '../src/agent-content-reader.mjs'

test('generated tool metadata uses lines while user content remains unchanged', () => {
  const text = contentText({ items: [{ kind: 'tool_result', toolName: 'file_read', toolUseId: 'call-1', status: 'success', content: { state: 'complete', text: '用户内容 a·b' } }] }, 'timeline')
  assert.match(text, /调用 ID：call-1\n调用状态：success/)
  assert.ok(text.includes('用户内容 a·b'))
  assert.equal((text.match(/·/g) || []).length, 1)
})

async function sources(url) {
  const result = []
  for (const item of await readdir(url, { withFileTypes: true })) {
    const child = new URL(item.name + (item.isDirectory() ? '/' : ''), url)
    if (item.isDirectory()) result.push(...await sources(child))
    else if (/\.(vue|mjs|js|css)$/.test(item.name)) result.push(child)
  }
  return result
}

test('UI chrome does not introduce middle-dot separators; historical parsers remain compatible', async () => {
  for (const url of await sources(new URL('../src/', import.meta.url))) {
    const text = await readFile(url, 'utf8')
    const rendering = text.split('\n').filter(line => !line.includes('const detailsLine =') && !line.includes('const detailParts =')).join('\n')
    assert.doesNotMatch(rendering, /·|&middot;/, url.pathname)
  }
})

test('image summary reads both historical separators and whitespace without altering payloads', async () => {
  const app = await readFile(new URL('../src/App.vue', import.meta.url), 'utf8')
  const functions = ['parseImageCreateResult','matchImageCreateField','numberField','escapeRegExp'].map(name => {
    const fn = app.match(new RegExp(`^function ${name}\\([^]*?^}`, 'm'))?.[0]
    assert.ok(fn, name)
    return fn
  }).join('\n')
  const parse = Function(functions + '\nreturn parseImageCreateResult')()
  for (const separator of [' · ', '  ']) for (const prefix of ['', 'requested: ']) {
    const result = parse('generated 1 image\n' + prefix + ['openai','gpt-image-2.5-sunburst','1024x1536','png'].join(separator))
    assert.equal(result.provider, 'openai')
    assert.equal(result.model, 'gpt-image-2.5-sunburst')
    assert.equal(result.size, '1024x1536')
    assert.equal(result.outputFormat, 'png')
  }
})
