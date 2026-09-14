import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export const UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024
const prefix = '/api/uploads/chunks'

// No total file-size limit. Only individual requests are bounded, keeping memory
// usage constant. Each chunk is appended to one file; completion is an atomic rename.
export function createChunkUploadHandler({ uploadsDir, baseDir }) {
  const sessions = new Map()
  const partialDir = path.join(uploadsDir, '.partial')
  const reply = (res, value, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(value))
  }
  const fail = (message, status = 400) => Object.assign(new Error(message), { status })
  async function metadata(req) {
    const chunks = []
    let bytes = 0
    for await (const chunk of req) {
      bytes += chunk.length
      if (bytes > 16384) throw fail('上传元数据过大')
      chunks.push(chunk)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  }
  async function discard(id, session) {
    await fs.rm(session.partialPath, { force: true })
    sessions.delete(id)
  }
  // Only abandoned incomplete uploads are cleaned up; completed files never expire.
  const cleanup = setInterval(() => {
    for (const [id, session] of sessions) {
      if (!session.busy && Date.now() - session.updated > 24 * 60 * 60 * 1000) {
        session.busy = true
        void discard(id, session).catch(() => { session.busy = false })
      }
    }
  }, 60 * 60 * 1000)
  cleanup.unref()

  const handle = async (req, res, url) => {
    if (url.pathname !== prefix && !url.pathname.startsWith(prefix + '/')) return false
    try {
      if (url.pathname === prefix && req.method === 'POST') {
        const body = await metadata(req)
        const name = path.basename(String(body.name || '').replace(/\\/g, '/')).replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '-').trim().slice(0, 180)
        if (!name || name === '.' || name === '..') throw fail('文件名无效')
        if (!Number.isSafeInteger(body.size) || body.size < 0) throw fail('文件大小无效')
        const id = randomUUID()
        await fs.mkdir(partialDir, { recursive: true })
        const partialPath = path.join(partialDir, id + '.part')
        const file = await fs.open(partialPath, 'wx')
        await file.close()
        sessions.set(id, { name, size: body.size, mimeType: String(body.mimeType || 'application/octet-stream'), partialPath, offset: 0, busy: false, updated: Date.now() })
        reply(res, { ok: true, uploadId: id, offset: 0, chunkBytes: UPLOAD_CHUNK_BYTES })
        return true
      }
      const match = url.pathname.slice(prefix.length).match(/^\/([a-f0-9-]{36})(\/complete)?$/)
      if (!match) throw fail('上传地址无效', 404)
      const id = match[1]
      const session = sessions.get(id)
      if (!session) throw fail('未完成的上传不存在，请重新上传', 404)
      session.updated = Date.now()
      if (session.busy) throw fail('上一分片仍在处理中，请重试', 409)
      if (req.method === 'GET' && !match[2]) {
        reply(res, { ok: true, offset: session.offset })
        return true
      }
      session.busy = true
      try {
        if (req.method === 'DELETE' && !match[2]) {
          await discard(id, session)
          reply(res, { ok: true })
        } else if (req.method === 'PATCH' && !match[2]) {
          const offset = Number(req.headers['x-upload-offset'])
          if (!Number.isSafeInteger(offset) || offset !== session.offset) throw fail('分片偏移不匹配', 409)
          const file = await fs.open(session.partialPath, 'r+')
          let received = 0
          try {
            for await (const chunk of req) {
              if (received + chunk.length > UPLOAD_CHUNK_BYTES || offset + received + chunk.length > session.size) throw fail('分片大小无效', 413)
              let written = 0
              while (written < chunk.length) {
                const result = await file.write(chunk, written, chunk.length - written, offset + received + written)
                if (!result.bytesWritten) throw new Error('磁盘写入失败')
                written += result.bytesWritten
              }
              received += chunk.length
            }
            if (!received) throw fail('分片为空')
            session.offset += received
          } catch (error) {
            await file.truncate(offset)
            throw error
          } finally {
            await file.close()
          }
          reply(res, { ok: true, offset: session.offset })
        } else if (req.method === 'POST' && match[2]) {
          if (session.offset !== session.size) throw fail('文件尚未上传完整', 409)
          const storedName = `${new Date().toISOString().replace(/[:.]/g, '-')}-${id}-${session.name}`
          const absolutePath = path.join(uploadsDir, storedName)
          await fs.rename(session.partialPath, absolutePath)
          sessions.delete(id)
          reply(res, { ok: true, file: {
            id: `upload-${id}`, name: session.name, storedName, size: session.size,
            mimeType: session.mimeType, absolutePath,
            relativePath: path.relative(baseDir, absolutePath) || storedName,
            url: `/api/uploads/${encodeURIComponent(storedName)}`,
          } })
        } else throw fail('不支持的上传操作', 405)
      } finally {
        session.busy = false
      }
    } catch (error) {
      if (!res.destroyed && !res.headersSent) reply(res, { ok: false, error: error.message || '上传失败' }, error.status || 500)
    }
    return true
  }
  handle.close = () => clearInterval(cleanup)
  return handle
}
