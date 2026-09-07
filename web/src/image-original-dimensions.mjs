// Original resources only: never feed this helper a thumbnail URL.
export function createOriginalDimensions({ maxEntries = 64, timeoutMs = 15000, createImage, fetchOriginal = createImage ? null : (url, signal) => fetch(url, { cache: 'no-store', signal }) } = {}) {
  createImage ||= () => new Image()
  if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 512) throw new RangeError('maxEntries must be 1..512')
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new RangeError('timeoutMs must be positive')
  const cache = new Map()
  let session = ''
  const keyOf = (sessionId, originalUrl) => JSON.stringify([sessionId, originalUrl])
  function discard(key) {
    const entry = cache.get(key)
    cache.delete(key)
    entry?.cancel()
  }
  function clear() { for (const key of cache.keys()) discard(key) }
  function setSession(sessionId) {
    if (sessionId !== session) { clear(); session = sessionId }
  }
  function invalidate(originalUrl) { discard(keyOf(session, originalUrl)) }
  function load({ sessionId, originalUrl, available = true }) {
    const identity = { sessionId, originalUrl }
    const result = state => Object.freeze({ ...identity, state })
    if (!sessionId || sessionId !== session) return Promise.resolve(result('stale'))
    const key = keyOf(sessionId, originalUrl)
    if (available === false) { discard(key); return Promise.resolve(result('unavailable')) }
    if (typeof originalUrl !== 'string' || !originalUrl.trim()) return Promise.resolve(result('unknown'))
    const found = cache.get(key)
    if (found) { cache.delete(key); cache.set(key, found); return found.promise }
    while (cache.size >= maxEntries) discard(cache.keys().next().value)
    let image, timer, objectUrl, done = false, finish
    const controller = new AbortController()
    const promise = new Promise(resolve => { finish = resolve })
    const settle = value => {
      if (done) return
      done = true
      clearTimeout(timer)
      controller.abort()
      if (objectUrl) URL.revokeObjectURL(objectUrl)
      finish(Object.freeze(value))
    }
    const entry = { promise, cancel: () => {
      settle(result('stale'))
      if (image) image.src = ''
    } }
    cache.set(key, entry)
    timer = setTimeout(() => {
      settle(result('unknown'))
      if (image) image.src = ''
    }, timeoutMs)
    void (async () => {
      try {
        let source = originalUrl
        // Revalidate HTTP originals, avoiding the browser's decoded-image cache
        // falsely reporting an expired resource as still available.
        if (fetchOriginal && !/^(data:|blob:)/i.test(originalUrl)) {
          const response = await fetchOriginal(originalUrl, controller.signal)
          if (!response.ok) throw new Error('Original unavailable')
          const blob = await response.blob()
          if (done) return
          source = objectUrl = URL.createObjectURL(blob)
        }
        if (done) return
        image = createImage()
        image.src = source
        await image.decode()
        const width = image.naturalWidth, height = image.naturalHeight
        if (Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0) {
          settle({ ...identity, state: 'actual', width, height, source: 'original-decode' })
        } else settle(result('unknown'))
      } catch { settle(result('unknown')) }
    })()
    return promise
  }
  return { setSession, load, invalidate, clear, get size() { return cache.size } }
}

// Presentation facts only. No requested value can become an actual value.
export function originalDimensionFacts(requested, actual) {
  const match = typeof requested === 'string' && /^(\d+)x(\d+)$/.exec(requested)
  const known = actual?.state === 'actual' && Number.isInteger(actual.width) && actual.width > 0 && Number.isInteger(actual.height) && actual.height > 0
  return {
    requested: requested === 'auto' ? 'auto（自动策略）' : (typeof requested === 'string' && requested ? requested : '未提供'),
    actual: known ? `${actual.width} × ${actual.height}` : actual?.state === 'unavailable' ? '不可获取' : '未知',
    mismatch: Boolean(known && match && (+match[1] !== actual.width || +match[2] !== actual.height)),
  }
}
