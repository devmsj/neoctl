import type { CredentialProvider } from "./credentials.js";
import { EnvCredentialProvider, StaticCredentialProvider } from "./credentials.js";
import type { OpenAIEndpointPreference } from "./config.js";
import { ModelAPIError, normalizeUnknownError } from "./errors.js";
import { HttpTransport } from "./http-transport.js";
import type { ModelGateway, ModelRequest, ModelStreamEvent, ReasoningConfig } from "./model-gateway.js";
import type { ProviderAdapter, ProviderCapabilities } from "./provider-adapter.js";
import { streamWithRetry } from "./retry-runner.js";
import { buildResponsesRequest, normalizeResponsesObject, normalizeResponsesStream } from "./openai-responses-mapper.js";
import { buildChatRequest, normalizeChatObject, normalizeChatStream } from "./openai-chat-mapper.js";

export type { OpenAIEndpointPreference } from "./config.js";

export interface OpenAIAdapterOptions {
  apiKey?: string;
  apiKeyEnvName?: string;
  credentialProvider?: CredentialProvider;
  baseUrl?: string;
  model: string;
  fallbackModel?: string;
  endpoint?: OpenAIEndpointPreference;
  timeoutMs?: number;
  streamIdleTimeoutMs?: number;
  maxRetries?: number;
  defaultMaxOutputTokens?: number;
  defaultReasoning?: ReasoningConfig;
}

export class OpenAIAdapter implements ProviderAdapter, ModelGateway {
  readonly name = "openai";
  readonly capabilities: ProviderCapabilities = {
    streaming: true,
    functionTools: true,
    parallelToolCalls: true,
    structuredOutput: true,
    previousResponseId: true,
    imageInput: false,
    fileInput: false,
    reasoningConfig: true,
    builtInTools: false,
  };

  private readonly credentialProvider: CredentialProvider;
  private readonly transport = new HttpTransport(this.name);
  private readonly baseUrl: string;

  constructor(private readonly options: OpenAIAdapterOptions) {
    this.credentialProvider =
      options.credentialProvider ??
      (options.apiKey ? new StaticCredentialProvider(options.apiKey) : new EnvCredentialProvider(options.apiKeyEnvName ?? "OPENAI_API_KEY"));
    this.baseUrl = stripTrailingSlash(options.baseUrl ?? "https://api.openai.com");
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    const endpoint = this.options.endpoint ?? "auto";
    yield* streamWithRetry((attempt) => this.streamAttempt(request, endpoint, attempt), {
      provider: this.name,
      maxRetries: this.options.maxRetries ?? 2,
      delayMs: 3000,
    });
  }

  private async *streamAttempt(
    request: ModelRequest,
    endpoint: OpenAIEndpointPreference,
    attempt: number,
  ): AsyncGenerator<ModelStreamEvent> {
    if (endpoint === "chat") {
      yield* this.streamChat(request);
      return;
    }

    try {
      yield* this.streamResponses(request);
      return;
    } catch (error) {
      const normalized = normalizeUnknownError(error, this.name);
      if (endpoint === "auto" && shouldFallbackToChat(normalized)) {
        yield { type: "provider_event", event: { type: "endpoint_fallback", from: "responses", to: "chat", reason: normalized.message, attempt } };
        yield* this.streamChat(request);
        return;
      }
      throw normalized;
    }
  }

  private async *streamResponses(request: ModelRequest): AsyncGenerator<ModelStreamEvent> {
    const body = buildResponsesRequest(request, this.options);
    const headers = await this.authHeaders();
    const timeoutMs = request.timeoutMs ?? this.options.timeoutMs ?? 120000;

    if (request.stream !== false) {
      const response = await this.transport.sendStream({
        method: "POST",
        url: `${this.baseUrl}/v1/responses`,
        headers,
        body: { ...body, stream: true },
        timeoutMs,
        signal: request.cancellation,
      });
      yield* normalizeResponsesStream(response.body, this.options);
      return;
    }

    const response = await this.transport.sendJson<Record<string, unknown>>({
      method: "POST",
      url: `${this.baseUrl}/v1/responses`,
      headers,
      body: { ...body, stream: false },
      timeoutMs,
      signal: request.cancellation,
    });
    yield* normalizeResponsesObject(response);
  }

  private async *streamChat(request: ModelRequest): AsyncGenerator<ModelStreamEvent> {
    const body = buildChatRequest(request, this.options);
    const headers = await this.authHeaders();
    const timeoutMs = request.timeoutMs ?? this.options.timeoutMs ?? 120000;

    if (request.stream !== false) {
      const streamOptions = body.stream_options && typeof body.stream_options === "object"
        ? body.stream_options as Record<string, unknown>
        : {};
      const response = await this.transport.sendStream({
        method: "POST",
        url: `${this.baseUrl}/v1/chat/completions`,
        headers,
        body: { ...body, stream: true, stream_options: { include_usage: true, ...streamOptions } },
        timeoutMs,
        signal: request.cancellation,
      });
      yield* normalizeChatStream(response.body, this.options);
      return;
    }

    const response = await this.transport.sendJson<Record<string, unknown>>({
      method: "POST",
      url: `${this.baseUrl}/v1/chat/completions`,
      headers,
      body: { ...body, stream: false },
      timeoutMs,
      signal: request.cancellation,
    });
    yield* normalizeChatObject(response);
  }

  private async authHeaders(): Promise<Record<string, string>> {
    const credential = await this.credentialProvider.getCredential();
    if (!credential) {
      throw new ModelAPIError({
        category: "auth_unavailable",
        provider: this.name,
        message: "OpenAI-compatible API key is not configured",
        retryable: false,
      });
    }
    return { Authorization: `Bearer ${credential}` };
  }
}

function shouldFallbackToChat(error: ModelAPIError): boolean {
  return error.status === 404 || (error.status === 400 && /responses|endpoint|route|not found/i.test(error.message));
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
