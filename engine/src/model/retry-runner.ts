import { ModelAPIError, normalizeUnknownError } from "./errors.js";
import type { ModelStreamEvent } from "./model-gateway.js";

export interface RetryOptions {
  provider: string;
  maxRetries: number;
  delayMs?: number;
  maxDelayMs?: number;
}

export async function* streamWithRetry(
  operation: (attempt: number) => AsyncIterable<ModelStreamEvent>,
  options: RetryOptions,
): AsyncGenerator<ModelStreamEvent> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      yield* operation(attempt);
      return;
    } catch (error) {
      const normalized = normalizeUnknownError(error, options.provider);
      if (!shouldRetry(normalized, attempt, options.maxRetries)) throw normalized;
      const delayMs = computeDelayMs(normalized, options);
      yield { type: "retrying", error: normalized, attempt, delayMs };
      await sleep(delayMs);
    }
  }
}

function shouldRetry(error: ModelAPIError, attempt: number, maxRetries: number): boolean {
  return error.retryable && attempt <= maxRetries;
}

function computeDelayMs(error: ModelAPIError, options: RetryOptions): number {
  const delayMs = options.delayMs ?? error.retryAfterMs ?? 3000;
  return Math.min(delayMs, options.maxDelayMs ?? 32000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
