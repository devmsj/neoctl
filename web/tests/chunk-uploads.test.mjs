import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createChunkUploadHandler, UPLOAD_CHUNK_BYTES } from '../chunk-uploads.mjs'
import { uploadFileChunks } from '../src/chunk-upload.mjs'

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'neo-chunks-'))
  const handler = createChunkUploadHandler({ uploadsDir: root, baseDir: root })
  const server = http.createServer(async (req, res) => {
    if (!await handler(req, res, new URL(req.url, 'http://localhost'))) { res.writeHead(404); res.end() }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { handler.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(root, { recursive: true, force: true }) })
  const base = `http://127.0.0.1:${server.address().port}/api/uploads/chunks`
  const start = async (size, name = '测试视频.mp4') => {
    const response = await fetch(base, { method: 'POST', body: JSON.stringify({ name, size }) })
    assert.equal(response.status, 200)
    return response.json()
  }
  const patch = (id, offset, body) => fetch(`${base}/${id}`, { method: 'PATCH', headers: { 'X-Upload-Offset': String(offset) }, body })
  return { root, base, start, patch }
}

test('32 MiB upload exceeds former limit, uses one file, preserves SHA256 and renames on completion', async t => {
  const { root, base, start, patch } = await fixture(t)
  const size = 32 * 1024 * 1024 + 17
  const { uploadId, chunkBytes } = await start(size)
  assert.equal(chunkBytes, UPLOAD_CHUNK_BYTES)
  const hash = createHash('sha256')
  for (let offset = 0; offset < size; offset += chunkBytes) {
    const data = Buffer.alloc(Math.min(chunkBytes, size - offset), offset / chunkBytes)
    hash.update(data)
    const res = await patch(uploadId, offset, data)
    assert.equal(res.status, 200)
    assert.equal((await res.json()).offset, offset + data.length)
  }
  assert.deepEqual((await fs.readdir(root)).sort(), ['.partial'])
  assert.equal((await fs.readdir(path.join(root, '.partial'))).length, 1)
  const res = await fetch(`${base}/${uploadId}/complete`, { method: 'POST' })
  assert.equal(res.status, 200)
  const { file } = await res.json()
  assert.equal(file.name, '测试视频.mp4')
  assert.equal(file.size, size)
  assert.equal(createHash('sha256').update(await fs.readFile(file.absolutePath)).digest('hex'), hash.digest('hex'))
  assert.deepEqual(await fs.readdir(path.join(root, '.partial')), [])
})

test('no total cap, offset checks prevent duplicates, incomplete completion rejected, cancel removes partial', async t => {
  const { root, base, start, patch } = await fixture(t)
  const huge = await start(10 * 1024 ** 4)
  assert.equal((await fetch(`${base}/${huge.uploadId}`, { method: 'DELETE' })).status, 200)
  const { uploadId } = await start(8)
  assert.equal((await patch(uploadId, 0, Buffer.from('1234'))).status, 200)
  assert.equal((await patch(uploadId, 0, Buffer.from('1234'))).status, 409)
  assert.equal((await (await fetch(`${base}/${uploadId}`)).json()).offset, 4)
  assert.equal((await fetch(`${base}/${uploadId}/complete`, { method: 'POST' })).status, 409)
  assert.equal((await fetch(`${base}/${uploadId}`, { method: 'DELETE' })).status, 200)
  assert.deepEqual(await fs.readdir(path.join(root, '.partial')), [])
})

test('zero-byte file is supported and invalid sizes/names are rejected', async t => {
  const { base, start } = await fixture(t)
  const { uploadId } = await start(0)
  const res = await fetch(`${base}/${uploadId}/complete`, { method: 'POST' })
  assert.equal((await res.json()).file.size, 0)
  for (const body of [{ name: 'file', size: -1 }, { name: '..', size: 0 }]) {
    assert.equal((await fetch(base, { method: 'POST', body: JSON.stringify(body) })).status, 400)
  }
})

test('client slices binary blobs, recovers lost chunk response without duplication, preserves URL query', async t => {
  const oldFetch = globalThis.fetch
  const oldXHR = globalThis.XMLHttpRequest
  t.after(() => { globalThis.fetch = oldFetch; globalThis.XMLHttpRequest = oldXHR })
  let offset = 0
  let sends = 0
  const chunks = []
  globalThis.fetch = async (url, options) => {
    assert.equal(new URL(url).search, '?workspace=test')
    let value
    if (String(url).includes('/complete')) value = { file: { absolutePath: '/tmp/test' } }
    else if (options.method === 'GET') value = { offset }
    else value = { uploadId: 'test-id', chunkBytes: 4 }
    return { ok: true, json: async () => value }
  }
  globalThis.XMLHttpRequest = class {
    upload = {}
    open(method, url) { assert.equal(method, 'PATCH'); assert.equal(new URL(url).search, '?workspace=test') }
    setRequestHeader(name, value) { if (name === 'X-Upload-Offset') assert.equal(Number(value), offset) }
    async send(blob) {
      assert.ok(blob instanceof Blob)
      chunks.push(await blob.text())
      offset += blob.size
      this.upload.onprogress({ lengthComputable: true, loaded: blob.size, total: blob.size })
      if (++sends === 1) { this.onerror(); return }
      this.status = 200; this.responseText = JSON.stringify({ offset }); this.onload()
    }
  }
  const values = []
  const file = new File(['0123456789'], 'test.bin')
  const result = await uploadFileChunks('http://localhost/api/uploads?workspace=test', file, value => values.push(value))
  assert.equal(result.file.absolutePath, '/tmp/test')
  assert.deepEqual(chunks, ['0123', '4567', '89'])
  assert.equal(values.at(-1), 1)
})
