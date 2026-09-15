import { appFetch } from './app-url.mjs'
// Upload bounded Blob slices, never read/encode the entire file in memory.
export async function uploadFileChunks(url, file, onProgress) {
  const endpoint = new URL(url, globalThis.location?.href || 'http://localhost')
  endpoint.pathname += '/chunks'
  const request = async (target, method, body) => {
    const res = await appFetch(target, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined })
    const value = await res.json()
    if (!res.ok || value?.ok === false || value?.error) throw new Error(value?.error || `上传失败 (${res.status})`)
    return value
  }
  const start = await request(endpoint, 'POST', { name: file.name, size: file.size, mimeType: file.type || 'application/octet-stream' })
  if (!start.uploadId || !Number.isSafeInteger(start.chunkBytes) || start.chunkBytes <= 0) throw new Error('上传初始化响应无效')
  endpoint.pathname += '/' + encodeURIComponent(start.uploadId)
  let offset = 0
  try {
    while (offset < file.size) {
      const end = Math.min(file.size, offset + start.chunkBytes)
      let uploaded = false
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const result = await sendChunk(endpoint, file.slice(offset, end), offset, (fraction) => onProgress?.((offset + fraction * (end - offset)) / file.size))
          if (result.offset !== end) throw new Error('分片确认偏移无效')
          uploaded = true
          break
        } catch (error) {
          if (attempt === 2) throw error
          await new Promise(resolve => setTimeout(resolve, 400 * (attempt + 1)))
          // A lost response may mean the chunk was already stored. Query before
          // retrying so the same bytes are never appended twice.
          const status = await request(endpoint, 'GET')
          if (status.offset === end) { uploaded = true; break }
          if (status.offset !== offset) throw new Error('上传进度不一致，请重新上传')
        }
      }
      if (!uploaded) throw new Error('分片上传失败')
      offset = end
      onProgress?.(file.size ? offset / file.size : 1)
    }
    const complete = new URL(endpoint)
    complete.pathname += '/complete'
    const result = await request(complete, 'POST')
    if (!result.file?.absolutePath) throw new Error('上传完成响应无效')
    return result
  } catch (error) {
    await request(endpoint, 'DELETE').catch(() => {})
    throw error
  }
}

function sendChunk(url, blob, offset, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.upload.onprogress = event => {
      if (event.lengthComputable && event.total) onProgress(event.loaded / event.total)
    }
    xhr.onload = () => {
      try {
        const value = JSON.parse(xhr.responseText)
        if (xhr.status < 200 || xhr.status >= 300 || value?.ok === false || value?.error) throw new Error(value?.error || `上传失败 (${xhr.status})`)
        resolve(value)
      } catch (error) { reject(error) }
    }
    xhr.onerror = () => reject(new Error('上传失败：网络连接异常'))
    xhr.onabort = () => reject(new Error('上传已取消'))
    xhr.ontimeout = () => reject(new Error('分片上传超时'))
    xhr.open('PATCH', url)
    xhr.setRequestHeader('Content-Type', 'application/octet-stream')
    xhr.setRequestHeader('X-Upload-Offset', String(offset))
    xhr.send(blob)
  })
}
