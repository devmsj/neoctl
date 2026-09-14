// Keep the existing JSON upload protocol while exposing actual transport progress.
export function uploadJson(url, body, onProgress, makeError = (value, status) => new Error(value?.error || `上传失败 (${status})`)) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress?.(Math.min(1, event.loaded / event.total))
    }
    xhr.onload = () => {
      let value
      try {
        value = JSON.parse(xhr.responseText)
      } catch {
        reject(new Error('上传失败：服务器返回无效响应'))
        return
      }
      if (xhr.status < 200 || xhr.status >= 300 || value?.error || value?.ok === false) {
        reject(makeError(value, xhr.status))
        return
      }
      resolve(value)
    }
    xhr.onerror = () => reject(new Error('上传失败：网络连接异常，请重试'))
    xhr.onabort = () => reject(new Error('上传已取消'))
    xhr.ontimeout = () => reject(new Error('上传超时，请重试'))
    xhr.open('POST', url)
    xhr.setRequestHeader('Content-Type', 'application/json')
    xhr.send(JSON.stringify(body))
  })
}

// Weight multiple files by size; 100% is reserved for validated batch success.
export function createUploadProgress(files, onProgress) {
  const weights = files.map((file) => Math.max(1, Number(file.size) || 0))
  const total = weights.reduce((sum, weight) => sum + weight, 0)
  let completed = 0
  let last = 0
  onProgress(0)
  return {
    update(index, fraction) {
      const progress = Math.floor(100 * (completed + weights[index] * Math.max(0, Math.min(1, fraction))) / total)
      last = Math.max(last, Math.min(99, progress))
      onProgress(last)
    },
    complete(index) {
      this.update(index, 1)
      completed += weights[index]
    },
    succeed() { onProgress(100) },
    fail() { onProgress(0) },
  }
}
