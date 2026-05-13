import type { CredentialProvider } from "./credentials.js";
import { EnvCredentialProvider, StaticCredentialProvider } from "./credentials.js";
import { ModelAPIError } from "./errors.js";
import { HttpTransport } from "./http-transport.js";
import { supportsImageInput } from "./context-window.js";
import type { ModelGateway, ModelRequest, ModelStreamEvent, ReasoningConfig } from "./model-gateway.js";
import type { ProviderAdapter, ProviderCapabilities } from "./provider-adapter.js";
import { streamWithRetry } from "./retry-runner.js";
import { buildAnthropicRequest, normalizeAnthropicObject, normalizeAnthropicStream } from "./anthropic-mapper.js";

const DEFAULT_ANTHROPIC_VERSION = "2023-06-01";

export interface AnthropicAdapterOptions {
  apiKey?: string;
  apiKeyEnvName?: string;
  credentialProvider?: CredentialProvider;
  baseUrl?: string;
  model: string;
  fallbackModel?: string;
  anthropicVersion?: string;
  timeoutMs?: number;
  streamIdleTimeoutMs?: number;
  maxRetries?: number;
  defaultMaxOutputTokens?: number;
  defaultReasoning?: ReasoningConfig | null;
}

export class AnthropicAdapter implements ProviderAdapter, ModelGateway {
  readonly name = "anthropic";
  readonly capabilities: ProviderCapabilities = {
    streaming: true,
    functionTools: true,
    parallelToolCalls: false,
    structuredOutput: false,
    previousResponseId: false,
    imageInput: true,
    fileInput: false,
    reasoningConfig: true,
    builtInTools: false,
  };

  private readonly credentialProvider: CredentialProvider;
  private readonly transport = new HttpTransport(this.name);
  private readonly baseUrl: string;

  constructor(private readonly options: AnthropicAdapterOptions) {
    this.credentialProvider =
      options.credentialProvider ??
      (options.apiKey ? new StaticCredentialProvider(options.apiKey) : new EnvCredentialProvider(options.apiKeyEnvName ?? "ANTHROPIC_API_KEY"));
    this.baseUrl = stripTrailingSlash(options.baseUrl ?? "https://api.anthropic.com");
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.assertRequestCapabilities(request);
    yield* streamWithRetry((attempt) => this.streamMessages(request, attempt), {
      provider: this.name,
      maxRetries: this.options.maxRetries ?? 2,
      delayMs: 3000,
    });
  }

  private async *streamMessages(request: ModelRequest, attempt: number): AsyncGenerator<ModelStreamEvent> {
    const body = buildAnthropicRequest(request, this.options);
    const headers = await this.authHeaders();
    const timeoutMs = request.timeoutMs ?? this.options.timeoutMs ?? 120000;

    if (attempt > 0) yield { type: "provider_event", event: { type: "anthropic_retry_attempt", attempt } };

    if (request.stream !== false) {
      const response = await this.transport.sendStream({
        method: "POST",
        url: `${this.baseUrl}/v1/messages`,
        headers,
        body: { ...body, stream: true },
        timeoutMs,
        signal: request.cancellation,
      });
      yield* normalizeAnthropicStream(response.body, this.options);
      return;
    }

    const response = await this.transport.sendJson<Record<string, unknown>>({
      method: "POST",
      url: `${this.baseUrl}/v1/messages`,
      headers,
      body: { ...body, stream: false },
      timeoutMs,
      signal: request.cancellation,
    });
    yield* normalizeAnthropicObject(response);
  }

  private assertRequestCapabilities(request: ModelRequest): void {
    const model = request.model ?? this.options.model;
    const supported = supportsImageInput(model);
    if (supported === false && hasImageInput(request)) {
      throw new ModelAPIError({
        category: "unsupported_image_input",
        provider: this.name,
        message: `Model ${model} does not support image input according to static model metadata`,
        retryable: false,
      });
    }
  }

  private async authHeaders(): Promise<Record<string, string>> {
    const credential = await this.credentialProvider.getCredential();
    if (!credential) {
      throw new ModelAPIError({
        category: "auth_unavailable",
        provider: this.name,
        message: "Anthropic API key is not configured",
        retryable: false,
      });
    }
    return {
      "x-api-key": credential,
      "anthropic-version": this.options.anthropicVersion ?? DEFAULT_ANTHROPIC_VERSION,
      Accept: "application/json, text/event-stream",
    };
  }
}

function hasImageInput(request: ModelRequest): boolean {
  return request.messages.some((message) =>
    message.blocks.some((block) => {
      const type = (block as { type: string }).type;
      return type === "image" || type === "input_image" || (block.type === "text" && /!\[[^\]]*\]\([^\)]+\)/.test(block.text));
    }),
  );
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
