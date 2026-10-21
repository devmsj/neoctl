/** Stop consuming immediately even if a provider ignores cancellation while awaiting I/O. */
export async function* abortableStream<T>(source: AsyncIterable<T>, signal?: AbortSignal): AsyncGenerator<T> {
  const iterator = source[Symbol.asyncIterator]();
  let ended = false;
  let wake!: () => void;
  const aborted = new Promise<{ done: true; value: undefined }>(resolve => {
    wake = () => resolve({ done: true, value: undefined });
  });
  signal?.addEventListener("abort", wake, { once: true });
  if (signal?.aborted) wake();
  try {
    while (!signal?.aborted) {
      const result = await Promise.race([iterator.next(), aborted]);
      if (signal?.aborted) return;
      if (result.done) { ended = true; return; }
      yield result.value;
    }
  } finally {
    signal?.removeEventListener("abort", wake);
    // return() may itself wait for a stalled next(). Never await it on cancellation.
    if (!ended) {
      try { void Promise.resolve(iterator.return?.()).catch(() => undefined); }
      catch { /* Provider cleanup is best effort after cancellation. */ }
    }
  }
}
