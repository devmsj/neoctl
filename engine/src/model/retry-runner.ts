import { ModelAPIError, normalizeUnknownError } from "./errors.js";
import type { ModelStreamEvent } from "./model-gateway.js";

export interface RetryOptions {
  provider: string;
  maxRetries: number;
  minDelayMs?: number;
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
      const delayMs = computeDelayMs(normalized, attempt, options);
      yield { type: "retrying", error: normalized, attempt, delayMs };
      await sleep(delayMs);
    }
  }
}

function shouldRetry(error: ModelAPIError, attempt: number, maxRetries: number): boolean {
  return error.retryable && attempt <= maxRetries;
}

function computeDelayMs(error: ModelAPIError, attempt: number, options: RetryOptions): number {
  if (error.retryAfterMs !== undefined) return Math.min(error.retryAfterMs, options.maxDelayMs ?? 32000);
  const min = options.minDelayMs ?? 500;
  const max = options.maxDelayMs ?? 32000;
  const base = Math.min(min * 2 ** (attempt - 1), max);
  return Math.round(base + Math.random() * base * 0.25);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
