// Archival display paging is independent of model context. Keep fetched rows across SSE snapshots.
export function createTranscriptHistory({ fetchPage, changed = () => {} }) {
  let session = '', epoch = '', before = 0, hasMore = false, prefix = []
  let version = 0, pending, controller, ready, error = '', snapshotBoundary
  const state = () => ({ hasMore, loading: !!pending, error })
  function reset() {
    version++; controller?.abort(); controller = undefined; pending = undefined; ready = undefined
    session = ''; epoch = ''; before = 0; hasMore = false; prefix = []; error = ''; snapshotBoundary = undefined
  }
  function sync(id, page, lines) {
    if (id !== session || (page?.epoch || '') !== epoch || page?.before !== snapshotBoundary) {
      reset(); session = id; epoch = page?.epoch || ''; before = page?.before || 0; hasMore = page?.hasMore === true; snapshotBoundary = page?.before
    }
    // A rebuilt runtime can move the initial boundary. Keep only rows older than its snapshot.
    const boundary = page?.before
    if (Number.isSafeInteger(boundary)) prefix = prefix.filter(line => line.historyOffset < boundary)
    changed(state())
    return [...prefix, ...lines]
  }
  async function prefetch() {
    if (!hasMore || ready || pending) return pending
    const generation = version, id = session, cursor = before, currentEpoch = epoch
    controller = new AbortController(); const signal = controller.signal
    error = ''
    const operation = (async () => {
      try {
        const page = await fetchPage({ sessionId: id, before: cursor, epoch: currentEpoch, signal })
        if (generation !== version) return
        if (page.sessionId !== id || page.epoch !== currentEpoch || !Number.isSafeInteger(page.before) || page.before >= cursor || !Array.isArray(page.lines)) throw new Error('历史页已变化，请重试')
        ready = page
      } catch (cause) {
        if (generation === version && cause.name !== 'AbortError') error = cause.message || '加载历史失败'
      } finally {
        if (generation === version) { pending = undefined; controller = undefined; changed(state()) }
      }
    })()
    pending = operation; changed(state())
    return operation
  }
  async function take() {
    const generation = version
    if (!ready) await prefetch()
    if (generation !== version || !ready) return []
    const page = ready; ready = undefined; before = page.before; hasMore = page.hasMore === true
    const known = new Set(prefix.map(line => String(line.id)))
    const rows = page.lines.filter(line => !known.has(String(line.id)))
    prefix = [...rows, ...prefix]; changed(state())
    return rows
  }
  return { sync, prefetch, take, reset, get state() { return state() } }
}
