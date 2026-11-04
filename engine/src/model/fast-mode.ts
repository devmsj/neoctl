import { ModelAPIError } from "./errors.js";
import type { ModelGateway, ModelRequest, ModelStreamEvent } from "./model-gateway.js";

/** Only explicit speed/tier rejection. Ordinary rate limits/auth/network failures stay errors. */
export function isFastModeUnavailable(error: unknown): boolean {
  if (!(error instanceof ModelAPIError) || ![400, 403, 422, 429, 529].includes(error.status ?? 0)) return false;
  const text = `${error.code ?? ""} ${error.message}`;
  const fast = error.provider === "anthropic"
    ? /\bfast[ _-](?:mode|speed|tier)\b|\bspeed\b/i.test(text)
    : error.provider === "openai" && /\bpriority\b|\bservice[ _-]tier\b/i.test(text);
  return !!fast && /not support|unsupported|not available|unavailable|not enabled|not allowed|not eligible|not permitted|access|permission|credits?|quota|capacity|rate[ _-]?limit|overload|invalid.*(?:speed|tier)|(?:speed|tier).*invalid|unknown.*(?:speed|tier)/i.test(text);
}

/** At most one downgrade, and never replay a stream that has started producing output. */
export async function* streamWithFastModeFallback(gateway: ModelGateway, request: ModelRequest): AsyncGenerator<ModelStreamEvent> {
  let published = false;
  try {
    for await (const event of gateway.stream(request)) {
      if (event.type === "error") throw event.error;
      if (!["provider_event", "retrying", "retry"].includes(event.type)) published = true;
      yield event;
    }
    return;
  } catch (error) {
    if (!request.fastMode || published || request.cancellation?.aborted || !isFastModeUnavailable(error)) throw error;
  }
  yield { type: "fast_mode_fallback" };
  request.cancellation?.throwIfAborted();
  yield* gateway.stream({ ...request, fastMode: false });
}

export function anthropicFastModeBeta(model: string): string | undefined {
  return /^claude-opus-(?:5|4-8)(?:-\d{8})?$/.test(model) ? "fast-mode-2026-02-01" : undefined;
}
