import type { CredentialProvider } from "./credentials.js";
import { EnvCredentialProvider, StaticCredentialProvider } from "./credentials.js";
import { ModelAPIError } from "./errors.js";
import { HttpTransport } from "./http-transport.js";
import { supportsImageInput } from "./context-window.js";
import type { ModelGateway, ModelRequest, ModelStreamEvent, ReasoningConfig } from "./model-gateway.js";
import type { ProviderAdapter, ProviderCapabilities } from "./provider-adapter.js";
import { streamWithRetry } from "./retry-runner.js";
import { buildChatRequest, normalizeChatObject, normalizeChatStream } from "./openai-chat-mapper.js";

export interface DeepSeekAdapterOptions {
  apiKey?: string;
  apiKeyEnvName?: string;
  credentialProvider?: CredentialProvider;
  baseUrl?: string;
  model: string;
  fallbackModel?: string;
  timeoutMs?: number;
  streamIdleTimeoutMs?: number;
  maxRetries?: number;
  defaultMaxOutputTokens?: number;
  defaultReasoning?: ReasoningConfig;
}

export class DeepSeekAdapter implements ProviderAdapter, ModelGateway {
  readonly name = "deepseek";
  readonly capabilities: ProviderCapabilities = {
    streaming: true,
    functionTools: true,
    parallelToolCalls: false,
    structuredOutput: false,
    previousResponseId: false,
    imageInput: false,
    fileInput: false,
    reasoningConfig: true,
    builtInTools: false,
  };

  private readonly credentialProvider: CredentialProvider;
  private readonly transport = new HttpTransport(this.name);
  private readonly baseUrl: string;

  constructor(private readonly options: DeepSeekAdapterOptions) {
    this.credentialProvider =
      options.credentialProvider ??
      (options.apiKey ? new StaticCredentialProvider(options.apiKey) : new EnvCredentialProvider(options.apiKeyEnvName ?? "DEEPSEEK_API_KEY"));
    this.baseUrl = stripTrailingSlash(options.baseUrl ?? "https://api.deepseek.com");
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.assertRequestCapabilities(request);
    yield* streamWithRetry((attempt) => this.streamChat(request, attempt), {
      provider: this.name,
      maxRetries: this.options.maxRetries ?? 2,
      delayMs: 3000,
    });
  }

  private async *streamChat(request: ModelRequest, attempt: number): AsyncGenerator<ModelStreamEvent> {
    const body = buildChatRequest(request, {
      ...this.options,
      includeMetadata: false,
      includeReasoningContent: true,
    });
    const headers = await this.authHeaders();
    const timeoutMs = request.timeoutMs ?? this.options.timeoutMs ?? 120000;

    if (attempt > 0) yield { type: "provider_event", event: { type: "deepseek_retry_attempt", attempt } };

    if (request.stream !== false) {
      const streamOptions = body.stream_options && typeof body.stream_options === "object"
        ? body.stream_options as Record<string, unknown>
        : {};
      const response = await this.transport.sendStream({
        method: "POST",
        url: `${this.baseUrl}/chat/completions`,
        headers,
        body: { ...body, stream: true, stream_options: { include_usage: true, ...streamOptions } },
        timeoutMs,
        signal: request.cancellation,
      });
      yield* normalizeChatStream(response.body, { ...this.options, includeReasoningContent: true });
      return;
    }

    const response = await this.transport.sendJson<Record<string, unknown>>({
      method: "POST",
      url: `${this.baseUrl}/chat/completions`,
      headers,
      body: { ...body, stream: false },
      timeoutMs,
      signal: request.cancellation,
    });
    yield* normalizeChatObject(response);
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
        message: "DeepSeek API key is not configured",
        retryable: false,
      });
    }
    return { Authorization: `Bearer ${credential}` };
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
