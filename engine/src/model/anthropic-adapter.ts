import { estimateTextTokens } from "../core/context-metrics.js";
import { streamWithRetry } from "./retry-runner.js";
import { anthropicFastModeBeta, isFastModeUnavailable } from "./fast-mode.js";
import { EnvCredentialProvider, StaticCredentialProvider, type CredentialProvider } from "./credentials.js";
import { categoryForStatus, ModelAPIError, parseRetryAfterMs } from "./errors.js";
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
  private countingUnsupported = false;
  constructor(private readonly options: AnthropicAdapterOptions) {
    this.credentials = options.credentialProvider ?? (options.apiKey ? new StaticCredentialProvider(options.apiKey) : new EnvCredentialProvider("ANTHROPIC_API_KEY"));
    const base = (options.baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "");
    const parsed = new URL(base);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.search || parsed.hash) anthropicInvalid("ANTHROPIC_BASE_URL must be an HTTP(S) origin or API prefix without query/fragment");
    this.url = base.endsWith("/v1/messages") ? base : base.endsWith("/v1") ? `${base}/messages` : `${base}/v1/messages`;
  }

  /** One fixed compromise for every model using this protocol. */
  estimateInputTokens(request: ModelRequest): number | undefined {
    try {
      const body = buildAnthropicRequest(request, this.options);
      const parts: string[] = [];
      let imageTokens = 0;
      const collect = (block: Record<string, unknown>) => {
        if (block.type === "image") imageTokens += 1600; // Coarse fallback; the counting endpoint handles actual image cost.
        else if (block.type === "thinking") parts.push(String(block.thinking ?? ""));
        else if (block.type === "text") parts.push(String(block.text ?? ""));
        else if (block.type === "tool_use") parts.push(JSON.stringify(block.input));
        else if (block.type === "tool_result") parts.push(typeof block.content === "string" ? block.content : JSON.stringify(block.content));
      };
      for (const block of (body.system ?? []) as Record<string, unknown>[]) collect(block);
      for (const tool of (body.tools ?? []) as Record<string, unknown>[]) parts.push(String(tool.name), String(tool.description ?? ""), JSON.stringify(tool.input_schema));
      const messages = body.messages as { content: Record<string, unknown>[] }[];
      for (const message of messages) for (const block of message.content) collect(block);
      return Math.ceil(1.2 * estimateTextTokens(parts.join("\n")) + 3 * messages.length + (request.tools.length ? 400 : 0) + 8 + imageTokens);
    } catch { return undefined; }
  }

  /** Optional optimization: a counting failure must never fail a conversation. */
  async countInputTokens(request: ModelRequest): Promise<number | undefined> {
    if (this.countingUnsupported || request.cancellation?.aborted) return undefined;
    const controller = new AbortController();
    const cancel = () => controller.abort();
    request.cancellation?.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(cancel, 1500);
    try {
      const mapped = buildAnthropicRequest(request, this.options);
      const body = Object.fromEntries(["model", "messages", "system", "tools", "tool_choice", "thinking", "output_config"].filter(key => mapped[key] !== undefined).map(key => [key, mapped[key]]));
      const credential = await this.credentials.getCredential();
      if (!credential || controller.signal.aborted) return undefined;
      const response = await fetch(`${this.url}/count_tokens`, {
        method: "POST", headers: { "Content-Type": "application/json", "User-Agent": "neoctl/anthropic", "x-api-key": credential, "anthropic-version": this.options.apiVersion ?? "2023-06-01" },
        body: JSON.stringify(body), signal: controller.signal,
      });
      if (!response.ok) {
        if ([404, 405, 501].includes(response.status)) this.countingUnsupported = true;
        await response.body?.cancel();
        return undefined;
      }
      const result = await response.json() as { input_tokens?: unknown };
      return Number.isSafeInteger(result.input_tokens) && Number(result.input_tokens) > 0 ? Number(result.input_tokens) : undefined;
    } catch { return undefined; }
    finally { clearTimeout(timer); request.cancellation?.removeEventListener("abort", cancel); }
  }

  async *stream(request: ModelRequest): AsyncGenerator<ModelStreamEvent> {
    const body = buildAnthropicRequest(request, this.options);
    const credential = await this.credentials.getCredential();
    if (!credential) throw new ModelAPIError({ provider: this.name, category: "auth_unavailable", message: "ANTHROPIC_API_KEY (official or gateway key) is not configured" });
    try {
      yield* streamWithRetry(() => this.attempt(request, body, credential), {
        provider: this.name, maxRetries: this.options.maxRetries, signal: request.cancellation,
        skipRetry: request.fastMode ? isFastModeUnavailable : undefined,
      });
    } catch (error) {
      if (request.cancellation?.aborted) throw new ModelAPIError({ provider: this.name, category: "user_abort", message: "Claude request cancelled", retryable: false });
      throw error;
    }
  }

  private async *attempt(request: ModelRequest, body: Record<string, unknown>, credential: string): AsyncGenerator<ModelStreamEvent> {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    if (request.cancellation?.aborted) cancel();
    request.cancellation?.addEventListener("abort", cancel, { once: true });
    const timeoutMs = request.timeoutMs ?? this.options.timeoutMs ?? 120000;
    const timer = timeoutMs > 0 ? setTimeout(cancel, timeoutMs) : undefined;
    const beta = request.fastMode ? anthropicFastModeBeta(request.model ?? this.options.model) : undefined;
    try {
      const response = await fetch(this.url, {
        method: "POST",
        headers: { ...(beta ? { "anthropic-beta": beta } : {}), "Content-Type": "application/json", Accept: request.stream === false ? "application/json" : "text/event-stream", "User-Agent": "neoctl/anthropic", "x-api-key": credential, "anthropic-version": this.options.apiVersion ?? "2023-06-01" },
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
