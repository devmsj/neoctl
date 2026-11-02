/** One HTTP request per capability; publish each result without waiting for peers. */
export async function runIndependentModelTests({ request, payload, signal, onResult }) {
  const snapshot = structuredClone(payload);
  await Promise.all([...new Set(snapshot.selection)].map(async id => {
    const started = Date.now();
    let result;
    try {
      signal?.throwIfAborted();
      const data = await request('/test', { ...snapshot, selection: [id] }, signal);
      const item = data?.results?.find(item => item.id === id);
      if (!item || typeof item.ok !== 'boolean') throw new Error('检测未返回有效结果。');
      result = { ...item, id };
    } catch (error) {
      result = {
        id, ok: false, cancelled: signal?.aborted === true,
        detail: signal?.aborted ? '已取消' : (error?.message || String(error)),
        durationMs: Date.now() - started,
      };
    }
    onResult(result);
  }));
}
