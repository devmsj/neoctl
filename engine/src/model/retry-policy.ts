export const DEFAULT_MAX_RETRIES = 5;
export const MAX_RETRY_DELAY_MS = 60_000;

/** Retry-After may lengthen a delay, never shorten the backoff or exceed the cap. */
export function retryDelayMs(attempt: number, retryAfterMs?: number, baseDelayMs = 5_000, maxDelayMs = MAX_RETRY_DELAY_MS): number {
  const cap = Math.max(0, Math.min(maxDelayMs, MAX_RETRY_DELAY_MS));
  const backoff = Math.max(0, baseDelayMs) * 2 ** Math.min(30, Math.max(0, attempt - 1));
  return Math.min(cap, Math.max(backoff, Number.isFinite(retryAfterMs) ? Math.max(0, retryAfterMs!) : 0));
}

export async function waitForRetry(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(signal?.reason ?? new DOMException("Aborted", "AbortError")); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}
