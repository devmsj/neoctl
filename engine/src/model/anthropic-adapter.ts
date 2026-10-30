import { EnvCredentialProvider, StaticCredentialProvider, type CredentialProvider } from "./credentials.js";
import { categoryForStatus, ModelAPIError, normalizeUnknownError, parseRetryAfterMs } from "./errors.js";
import type { ModelRequest, ModelStreamEvent } from "./model-gateway.js";
import type { ProviderAdapter, ProviderCapabilities } from "./provider-adapter.js";
import { anthropicInvalid, buildAnthropicRequest, normalizeAnthropicObject, normalizeAnthropicStream, type AnthropicMapperOptions } from "./anthropic-mapper.js";

export interface AnthropicAdapterOptions extends AnthropicMapperOptions {
  apiKey?: string;
  credentialProvider?: CredentialProvider;
  baseUrl?: string;
  apiVersion?: string;
  timeoutMs?: number;
  streamIdleTimeoutMs?: number;
  maxRetries?: number;
}

/** Native Messages API. CPA owns upstream OAuth; neo only receives its API key. */
export class AnthropicAdapter implements ProviderAdapter {
  readonly name = "anthropic";
  readonly capabilities: ProviderCapabilities = {
    streaming: true, functionTools: true, parallelToolCalls: true, structuredOutput: true,
    previousResponseId: false, imageInput: true, fileInput: false, reasoningConfig: true, builtInTools: false,
  };
  private readonly credentials: CredentialProvider;
  private readonly url: string;
  constructor(private readonly options: AnthropicAdapterOptions) {
    this.credentials = options.credentialProvider ?? (options.apiKey ? new StaticCredentialProvider(options.apiKey) : new EnvCredentialProvider("ANTHROPIC_API_KEY"));
    const base = (options.baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "");
    const parsed = new URL(base);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.search || parsed.hash) anthropicInvalid("ANTHROPIC_BASE_URL must be an HTTP(S) origin or API prefix without query/fragment");
    this.url = base.endsWith("/v1/messages") ? base : base.endsWith("/v1") ? `${base}/messages` : `${base}/v1/messages`;
  }

  async *stream(request: ModelRequest): AsyncGenerator<ModelStreamEvent> {
    const body = buildAnthropicRequest(request, this.options);
    const credential = await this.credentials.getCredential();
    if (!credential) throw new ModelAPIError({ provider: this.name, category: "auth_unavailable", message: "ANTHROPIC_API_KEY (official or gateway key) is not configured" });
    const maxRetries = this.options.maxRetries ?? 2;
    for (let attempt = 0; ; attempt++) {
      let published = false;
      try {
        for await (const event of this.attempt(request, body, credential)) {
          if (["assistant_delta", "thinking_delta", "assistant_message", "tool_call_started", "tool_call_delta", "tool_use"].includes(event.type)) published = true;
          yield event;
        }
        return;
      } catch (error) {
        if (request.cancellation?.aborted) throw new ModelAPIError({ provider: this.name, category: "user_abort", message: "Claude request cancelled", retryable: false });
        const normalized = normalizeUnknownError(error, this.name);
        if (published || !normalized.retryable || attempt >= maxRetries) throw normalized;
        const delayMs = Math.min(normalized.retryAfterMs ?? 3000, 32000);
        yield { type: "retrying", error: normalized, attempt: attempt + 1, delayMs };
        await abortableDelay(delayMs, request.cancellation);
      }
    }
  }

  private async *attempt(request: ModelRequest, body: Record<string, unknown>, credential: string): AsyncGenerator<ModelStreamEvent> {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    if (request.cancellation?.aborted) cancel();
    request.cancellation?.addEventListener("abort", cancel, { once: true });
    const timeoutMs = request.timeoutMs ?? this.options.timeoutMs ?? 120000;
    const timer = timeoutMs > 0 ? setTimeout(cancel, timeoutMs) : undefined;
    try {
      const response = await fetch(this.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: request.stream === false ? "application/json" : "text/event-stream", "User-Agent": "neoctl/anthropic", "x-api-key": credential, "anthropic-version": this.options.apiVersion ?? "2023-06-01" },
        body: JSON.stringify(body), signal: controller.signal,
      });
      if (request.stream !== false && response.ok && timer) clearTimeout(timer);
      if (!response.ok) {
        const raw = await response.text();
        let parsed: Record<string, unknown>;
        try { parsed = JSON.parse(raw); } catch { parsed = { message: raw }; }
        const error = parsed.error && typeof parsed.error === "object" ? parsed.error as Record<string, unknown> : parsed;
        const message = typeof error.message === "string" ? error.message : `HTTP ${response.status} from Claude`;
        throw new ModelAPIError({ provider: this.name, category: /prompt is too long|context.*(?:length|limit)/i.test(message) ? "context_length" : categoryForStatus(response.status, parsed), message, status: response.status, code: typeof error.type === "string" ? error.type : undefined, requestId: response.headers.get("request-id") ?? undefined, retryAfterMs: parseRetryAfterMs(response.headers.get("retry-after")), raw: parsed });
      }
      const model = request.model ?? this.options.model;
      if (request.stream === false) yield* normalizeAnthropicObject(await response.json() as Record<string, unknown>, model);
      else {
        if (!response.body) throw new ModelAPIError({ provider: this.name, category: "provider_bug", message: "Claude streaming response has no body", retryable: false });
        yield* normalizeAnthropicStream(response.body, model, this.options.streamIdleTimeoutMs);
      }
    } finally {
      if (timer) clearTimeout(timer);
      request.cancellation?.removeEventListener("abort", cancel);
      controller.abort();
    }
  }
}

async function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new ModelAPIError({ provider: "anthropic", category: "user_abort", message: "Claude request cancelled", retryable: false });
  await new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(new ModelAPIError({ provider: "anthropic", category: "user_abort", message: "Claude request cancelled", retryable: false })); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}
