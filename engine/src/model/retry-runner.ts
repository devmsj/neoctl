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
    const pending: ModelStreamEvent[] = [];
    try {
      for await (const event of operation(attempt)) {
        if (event.type === "error") throw event.error;
        if (!["provider_event", "retrying", "retry"].includes(event.type)) published = true;
        if (event.type === "assistant_message" || event.type === "tool_use" || event.type === "response_completed" || event.type === "response_incomplete" || (event.type === "usage" && !event.provisional)) pending.push(event);
        else yield event;
      }
      // Only the successful attempt may commit history or executable tool calls.
      const incomplete = pending.some(event => event.type === "response_incomplete");
      for (const event of pending) {
        if (incomplete && event.type === "tool_use") continue;
        if (incomplete && event.type === "assistant_message") {
          yield { ...event, message: { ...event.message, blocks: event.message.blocks.filter(block => block.type !== "tool_use") } };
        } else yield event;
      }
      return;
    } catch (error) {
      const normalized = normalizeUnknownError(error, options.provider);
      if (options.signal?.aborted || options.skipRetry?.(normalized) || !shouldRetry(normalized, attempt, options.maxRetries ?? DEFAULT_MAX_RETRIES)) throw normalized;
      const delayMs = retryDelayMs(attempt, normalized.retryAfterMs, options.delayMs, options.maxDelayMs);
      yield { type: "retrying", error: normalized, attempt, delayMs, ...(published ? { resetOutput: true } : {}) };
      await waitForRetry(delayMs, options.signal);
    }
  }
}

function shouldRetry(error: ModelAPIError, attempt: number, maxRetries: number): boolean {
  return error.retryable && attempt <= maxRetries;
}
