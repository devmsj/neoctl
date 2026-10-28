import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { brotliDecompressSync } from 'node:zlib'
import { normalizeAppearance, emptyAppearance, assetReferences, ASSET_ID } from './shared/appearance.mjs'

const error = (status, message) => Object.assign(new Error(message), { status })
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const types = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf' }
// Validate table bounds, not the extension/MIME supplied by a client. Browser font
// loading performs the final sanitizer pass before any font becomes selectable.
export function fontExtension(b) {
  if (b.length < 12) throw error(400, '字体文件损坏')
  const signature = b.toString('ascii', 0, 4)
  if (signature === 'wOFF' || signature === 'wOF2') {
    const woff2 = signature === 'wOF2', header = woff2 ? 48 : 44
    if (b.length < header || b.readUInt32BE(8) !== b.length || !b.readUInt16BE(12) || b.readUInt16BE(14) !== 0) throw error(400, '字体文件损坏')
    if (woff2) {
      // Validate variable-length table directory and the complete Brotli stream.
      // Collections are not offered as selectable single-family uploads.
      if (b.toString('ascii', 4, 8) === 'ttcf') throw error(400, '请选择单字体文件')
      let cursor = 48, expected = 0
      const uint = () => {
        let n = 0
        for (let i = 0; i < 5; i++) {
          if (cursor >= b.length) throw error(400, '字体索引损坏')
          const byte = b[cursor++]
          if ((!i && byte === 0x80) || n > 0x1ffffff) throw error(400, '字体索引损坏')
          n = n * 128 + (byte & 127)
          if (!(byte & 128)) return n
        }
        throw error(400, '字体索引损坏')
      }
      for (let i = 0; i < b.readUInt16BE(12); i++) {
        if (cursor >= b.length) throw error(400, '字体索引损坏')
        const flags = b[cursor++], tag = flags & 63, transform = flags >> 6
        let name = tag === 10 ? 'glyf' : tag === 11 ? 'loca' : ''
        if (tag === 63) { if (cursor + 4 > b.length) throw error(400, '字体索引损坏'); name = b.toString('ascii', cursor, cursor + 4); cursor += 4 }
        const original = uint(), transformed = name === 'glyf' || name === 'loca' ? transform !== 3 : transform !== 0
        const length = transformed ? uint() : original
        if (name === 'loca' && transformed && length !== 0) throw error(400, '字体索引损坏')
        expected += length
      }
      const compressed = b.readUInt32BE(20)
      if (!compressed || cursor + compressed > b.length || !expected) throw error(400, '字体数据损坏')
      try { if (brotliDecompressSync(b.subarray(cursor, cursor + compressed), { maxOutputLength: expected }).length !== expected) throw new Error() }
      catch { throw error(400, '字体压缩数据损坏') }
    } else {
      const count = b.readUInt16BE(12)
      if (44 + count * 20 > b.length) throw error(400, '字体索引损坏')
      for (let i = 0; i < count; i++) { const p = 44 + i * 20, offset = b.readUInt32BE(p + 4), length = b.readUInt32BE(p + 8); if (offset < 44 + count * 20 || offset + length > b.length || length > b.readUInt32BE(p + 12)) throw error(400, '字体数据损坏') }
    }
    return woff2 ? 'woff2' : 'woff'
  }
  if (signature !== 'OTTO' && b.readUInt32BE(0) !== 0x00010000) throw error(400, '请选择 WOFF、WOFF2、TTF 或 OTF 字体')
  const count = b.readUInt16BE(4)
  if (!count || 12 + count * 16 > b.length) throw error(400, '字体索引损坏')
  for (let i = 0; i < count; i++) { const p = 12 + i * 16, offset = b.readUInt32BE(p + 8), length = b.readUInt32BE(p + 12); if (offset < 12 + count * 16 || offset + length > b.length) throw error(400, '字体数据损坏') }
  return signature === 'OTTO' ? 'otf' : 'ttf'
}
export function createAppearanceStore(directory, { validateImage } = {}) {
  const filename = path.join(directory, 'settings.json'), assets = path.join(directory, 'assets')
  let queue = Promise.resolve()
  const serialize = fn => { const result = queue.then(fn); queue = result.catch(() => {}); return result }
  async function atomic(file, bytes) {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
    const temp = file + '.' + randomUUID() + '.tmp'
    try { const handle = await fs.open(temp, 'wx', 0o600); try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }; await fs.rename(temp, file) }
    finally { await fs.rm(temp, { force: true }).catch(() => {}) }
  }
  async function read() {
    try {
      const raw = await fs.readFile(filename), config = normalizeAppearance(JSON.parse(raw.toString('utf8')))
      return { config, revision: hash(raw) }
    } catch (e) { if (e.code === 'ENOENT') return { config: emptyAppearance(), revision: '0' }; throw error(500, '外观配置读取失败，原文件已保留') }
  }
  async function asset(id) {
    if (!ASSET_ID.test(id)) throw error(404, '资源不存在')
    const file = path.join(assets, id)
    const stat = await fs.lstat(file).catch(() => { throw error(404, '资源不存在') })
    if (!stat.isFile() || stat.isSymbolicLink()) throw error(404, '资源不存在')
    return { file, size: stat.size, type: types[id.split('.').at(-1)] }
  }
  return {
    read,
    asset,
    save: (value, revision) => serialize(async () => {
      let config
      try { config = normalizeAppearance(value) } catch (e) { throw error(400, e.message) }
      const current = await read()
      if (revision !== current.revision) throw error(409, '外观已在其他窗口更新，请重新载入')
      for (const id of assetReferences(config)) await asset(id)
      const raw = Buffer.from(JSON.stringify(config, null, 2) + '\n')
      await atomic(filename, raw)
      return { config, revision: hash(raw) }
    }),
    upload: (bytes, kind) => serialize(async () => {
      let ext
      if (kind === 'background') {
        try { ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }[await validateImage(bytes)] } catch { throw error(400, '图片内容无效') }
        if (!ext) throw error(400, '请选择 PNG、JPEG、WebP 或 GIF 图片')
      } else if (kind === 'font') ext = fontExtension(bytes)
      else throw error(400, '资源类型无效')
      const id = hash(bytes) + '.' + ext
      await atomic(path.join(assets, id), bytes)
      return { id, type: types[ext], size: bytes.length }
    }),
    remove: id => serialize(async () => {
      const current = await read()
      if (assetReferences(current.config).includes(id)) throw error(409, '资源正在被主题使用')
      await asset(id); await fs.unlink(path.join(assets, id))
    }),
  }
}
export function createAppearanceRoute(store) {
  const send = (res, body, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)) }
  async function bytes(req, limit = Infinity) {
    const chunks = []; let count = 0
    for await (const b of req) { count += b.length; if (count > limit) throw error(413, '配置内容过长'); chunks.push(b) }
    return Buffer.concat(chunks)
  }
  return async (req, res, url) => {
    if (url.pathname !== '/api/appearance' && !url.pathname.startsWith('/api/appearance/')) return false
    try {
      // Cross-site form posts cannot mutate local settings. No wildcard CORS.
      if (!['GET', 'HEAD'].includes(req.method) && (req.headers['sec-fetch-site'] === 'cross-site' || (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host))) throw error(403, '外观请求来源无效')
      if (url.pathname === '/api/appearance') {
        if (req.method === 'GET') send(res, await store.read())
        else if (req.method === 'PUT') {
          if (!String(req.headers['content-type']).startsWith('application/json')) throw error(415, '请求格式无效')
          let body; try { body = JSON.parse((await bytes(req, 256 * 1024)).toString('utf8')) } catch (e) { if (e.status) throw e; throw error(400, '配置格式无效') }
          send(res, await store.save(body.config, body.revision))
        } else throw error(405, '请求方法无效')
      } else if (url.pathname === '/api/appearance/assets' && req.method === 'POST') {
        // Deliberately no new image/font file-size limit. Existing reverse proxy limits remain unchanged.
        if (req.headers['content-type'] !== 'application/octet-stream') throw error(415, '资源请求格式无效')
        send(res, await store.upload(await bytes(req), url.searchParams.get('kind')), 201)
      } else if (url.pathname.startsWith('/api/appearance/assets/')) {
        const id = url.pathname.slice('/api/appearance/assets/'.length)
        if (req.method === 'DELETE') { await store.remove(id); send(res, { ok: true }) }
        else if (['GET', 'HEAD'].includes(req.method)) {
          const a = await store.asset(id)
          // Open before sending headers. Pipeline owns backpressure/disconnect cleanup;
          // no accumulating drain/close listeners for large background/font files.
          const file = await fs.open(a.file, 'r')
          try {
            const stat = await file.stat()
            if (!stat.isFile()) throw error(404, '资源不存在')
            res.writeHead(200, { 'Content-Type': a.type, 'Content-Length': stat.size, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" })
            if (req.method === 'HEAD') res.end()
            else await pipeline(file.createReadStream({ autoClose: false }), res)
          } finally { await file.close() }
        } else throw error(405, '请求方法无效')
      } else throw error(404, '外观接口不存在')
    } catch (e) { if (!res.headersSent) send(res, { error: e.status ? e.message : '外观操作失败' }, e.status || 500); else res.destroy() }
    return true
  }
}
