import { DEFAULT_MAX_RETRIES, retryDelayMs, waitForRetry } from "./retry-policy.js";
import { ModelAPIError, normalizeUnknownError } from "./errors.js";
import type { ModelStreamEvent } from "./model-gateway.js";

export interface RetryOptions {
  provider: string;
  maxRetries?: number;
  signal?: AbortSignal;
  delayMs?: number;
  maxDelayMs?: number;
  skipRetry?: (error: ModelAPIError) => boolean;
}

export async function* streamWithRetry(
  operation: (attempt: number) => AsyncIterable<ModelStreamEvent>,
  options: RetryOptions,
): AsyncGenerator<ModelStreamEvent> {
  for (let attempt = 1; ; attempt += 1) {
    options.signal?.throwIfAborted();
    let published = false;
    try {
      for await (const event of operation(attempt)) {
        if (!["provider_event", "retrying", "retry"].includes(event.type)) published = true;
        yield event;
      }
      return;
    } catch (error) {
      const normalized = normalizeUnknownError(error, options.provider);
      if (options.signal?.aborted || published || options.skipRetry?.(normalized) || !shouldRetry(normalized, attempt, options.maxRetries ?? DEFAULT_MAX_RETRIES)) throw normalized;
      const delayMs = retryDelayMs(attempt, normalized.retryAfterMs, options.delayMs, options.maxDelayMs);
      yield { type: "retrying", error: normalized, attempt, delayMs };
      await waitForRetry(delayMs, options.signal);
    }
  }
}

function shouldRetry(error: ModelAPIError, attempt: number, maxRetries: number): boolean {
  return error.retryable && attempt <= maxRetries;
}
