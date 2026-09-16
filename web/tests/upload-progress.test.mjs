import test from 'node:test'
import assert from 'node:assert/strict'
import { uploadJson, createUploadProgress } from '../src/upload-progress.mjs'

test('batch progress is size weighted, monotonic, and waits for validated success', () => {
  const values = []
  const progress = createUploadProgress([{ size: 100 }, { size: 300 }], (p) => values.push(p))
  progress.update(0, 0.5)
  assert.equal(values.at(-1), 12)
  progress.complete(0)
  assert.equal(values.at(-1), 25)
  progress.update(1, 0.5)
  assert.equal(values.at(-1), 62)
  progress.update(1, 0.2)
  assert.equal(values.at(-1), 62)
  progress.complete(1)
  assert.equal(values.at(-1), 99)
  progress.succeed()
  assert.equal(values.at(-1), 100)
  progress.fail()
  assert.equal(values.at(-1), 0)
})

test('zero-byte files and retries start at white and finish correctly', () => {
  let value = 100
  const progress = createUploadProgress([{ size: 0 }], (p) => { value = p })
  assert.equal(value, 0)
  progress.complete(0)
  assert.equal(value, 99)
  progress.succeed()
  assert.equal(value, 100)
})

test('XHR forwards actual progress and waits for response; failures reject', async (t) => {
  let xhr
  class FakeXHR {
    upload = {}
    constructor() { xhr = this }
    open(method, url) { this.method = method; this.url = url }
    setRequestHeader(name, value) { this.header = [name, value] }
    send(body) { this.body = body }
  }
  const original = globalThis.XMLHttpRequest
  globalThis.XMLHttpRequest = FakeXHR
  t.after(() => { globalThis.XMLHttpRequest = original })
  let progress = 0
  let resolved = false
  const request = uploadJson('/api/uploads?session=test', { data: 'abc' }, (p) => { progress = p })
  request.then(() => { resolved = true })
  assert.equal(xhr.method, 'POST')
  assert.equal(xhr.url, '/api/uploads?session=test')
  assert.deepEqual(xhr.header, ['Content-Type', 'application/json'])
  assert.equal(xhr.body, '{"data":"abc"}')
  xhr.upload.onprogress({ lengthComputable: true, loaded: 50, total: 100 })
  assert.equal(progress, 0.5)
  xhr.upload.onprogress({ lengthComputable: false, loaded: 70, total: 0 })
  assert.equal(progress, 0.5)
  xhr.upload.onprogress({ lengthComputable: true, loaded: 100, total: 100 })
  await Promise.resolve()
  assert.equal(resolved, false)
  xhr.status = 200
  xhr.responseText = '{"file":{"absolutePath":"/tmp/test"}}'
  xhr.onload()
  assert.equal((await request).file.absolutePath, '/tmp/test')

  for (const [status, body] of [[413, '{"error":"too large"}'], [200, '{"ok":false}'], [200, 'invalid']]) {
    const pending = uploadJson('/api/uploads', {})
    xhr.status = status
    xhr.responseText = body
    xhr.onload()
    await assert.rejects(pending)
  }
  for (const event of ['onerror', 'onabort', 'ontimeout']) {
    const pending = uploadJson('/api/uploads', {})
    xhr[event]()
    await assert.rejects(pending)
  }
})
