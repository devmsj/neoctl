import { isFastModeUnavailable } from "./fast-mode.js";
import type { CredentialProvider } from "./credentials.js";
import { EnvCredentialProvider, StaticCredentialProvider } from "./credentials.js";
import type { OpenAIEndpointPreference } from "./config.js";
import { ModelAPIError, normalizeUnknownError } from "./errors.js";
import { HttpTransport } from "./http-transport.js";
import { PayloadRefs, withPayloadRefs } from "../core/image-payload-refs.js";
import { supportsImageInput } from "./context-window.js";
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
  endpoint?: OpenAIEndpointPreference;
  timeoutMs?: number;
  streamIdleTimeoutMs?: number;
  maxRetries?: number;
  defaultMaxOutputTokens?: number;
  defaultReasoning?: ReasoningConfig | null;
}

export class OpenAIAdapter implements ProviderAdapter, ModelGateway {
  readonly name = "openai";
  readonly capabilities: ProviderCapabilities = {
    streaming: true,
    functionTools: true,
    parallelToolCalls: true,
    structuredOutput: true,
    previousResponseId: true,
    imageInput: true,
    fileInput: false,
    reasoningConfig: true,
    builtInTools: false,
  };

  private readonly credentialProvider: CredentialProvider;
  private readonly transport = new HttpTransport(this.name);
  /** Runtime-learned (not a setting): this backend rejected allowed_tools. */
  private allowedToolsUnsupported = false;
  private readonly baseUrl: string;

  constructor(private readonly options: OpenAIAdapterOptions) {
    this.credentialProvider =
      options.credentialProvider ??
      (options.apiKey ? new StaticCredentialProvider(options.apiKey) : new EnvCredentialProvider(options.apiKeyEnvName ?? "OPENAI_API_KEY"));
    // Accept an origin or one trailing /v1; do not repair repeated /v1 segments.
    this.baseUrl = stripTrailingSlash(options.baseUrl ?? "https://api.openai.com").replace(/\/v1$/, "");
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.assertRequestCapabilities(request);
    const endpoint = this.options.endpoint ?? "auto";
    for (;;) {
      // Same condition under which buildResponsesRequest emits allowed_tools.
      const allowedToolsSent = !this.allowedToolsUnsupported && endpoint !== "chat" && request.tools.length > 0
        && request.toolChoice !== "none" && typeof request.toolChoice !== "object";
      try {
        yield* streamWithRetry((attempt) => this.streamAttempt(request, endpoint, attempt), {
          provider: this.name,
          maxRetries: this.options.maxRetries,
          signal: request.cancellation,
          skipRetry: request.fastMode ? isFastModeUnavailable : undefined,
        });
        return;
      } catch (error) {
        // allowed_tools stays on whenever the backend accepts it; a backend that
        // rejects it (a validation error, before any output) gets the standard
        // tool_choice values, and this adapter stops sending it.
        if (allowedToolsSent && !request.cancellation?.aborted && rejectsAllowedTools(normalizeUnknownError(error, this.name))) {
          this.allowedToolsUnsupported = true;
          continue;
        }
        throw error;
      }
    }
  }

  private async *streamAttempt(
    request: ModelRequest,
    endpoint: OpenAIEndpointPreference,
    attempt: number,
  ): AsyncGenerator<ModelStreamEvent> {
    if (endpoint === "chat") {
      this.assertChatCompatibility(request);
      yield* this.streamChat(request);
      return;
    }

    try {
      yield* this.streamResponses(request);
      return;
    } catch (error) {
      const normalized = normalizeUnknownError(error, this.name);
      if (endpoint === "auto" && !(request.fastMode && isFastModeUnavailable(normalized)) && shouldFallbackToChat(normalized)) {
        this.assertChatCompatibility(request);
        yield { type: "provider_event", event: { type: "endpoint_fallback", from: "responses", to: "chat", reason: normalized.message, attempt } };
        yield* this.streamChat(request);
        return;
      }
      throw normalized;
    }
  }

  private async *streamResponses(request: ModelRequest): AsyncGenerator<ModelStreamEvent> {
    const payloadRefs = new PayloadRefs();
    const body = withPayloadRefs(payloadRefs, () => buildResponsesRequest(request, this.options, { allowedTools: !this.allowedToolsUnsupported }));
    const headers = await this.authHeaders();
    const timeoutMs = request.timeoutMs ?? this.options.timeoutMs ?? 120000;

    if (request.stream !== false) {
      const response = await this.transport.sendStream({
        method: "POST",
        url: `${this.baseUrl}/v1/responses`,
        headers,
        body: { ...body, stream: true },
        payloadRefs,
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
      payloadRefs,
      timeoutMs,
      signal: request.cancellation,
    });
    yield* normalizeResponsesObject(response);
  }

  private async *streamChat(request: ModelRequest): AsyncGenerator<ModelStreamEvent> {
    const payloadRefs = new PayloadRefs();
    const body = withPayloadRefs(payloadRefs, () => buildChatRequest(request, this.options));
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
        payloadRefs,
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
      payloadRefs,
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

  private assertChatCompatibility(request: ModelRequest): void {
    const summary = this.reasoningFor(request)?.summary;
    if (!summary) return;
    throw new ModelAPIError({
      category: "invalid_request",
      provider: this.name,
      code: "reasoning_summary_requires_responses",
      message: `Reasoning summary '${summary}' requires the Responses API endpoint`,
      retryable: false,
    });
  }

  private reasoningFor(request: ModelRequest): ReasoningConfig | undefined {
    if (request.reasoning === null) return undefined;
    return request.reasoning ?? this.options.defaultReasoning ?? undefined;
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

function hasImageInput(request: ModelRequest): boolean {
  return request.messages.some((message) =>
    message.blocks.some((block) => {
      const type = (block as { type: string }).type;
      return type === "image" || type === "input_image" || (block.type === "text" && /!\[[^\]]*\]\([^\)]+\)/.test(block.text));
    }),
  );
}

/** A request-validation error about tool_choice/allowed_tools (sent only while the request used allowed_tools). */
function rejectsAllowedTools(error: ModelAPIError): boolean {
  if (error.status !== 400 && error.status !== 422) return false;
  return /allowed_tools|tool_choice/i.test(`${error.message} ${JSON.stringify(error.raw ?? "")}`);
}

function shouldFallbackToChat(error: ModelAPIError): boolean {
  return error.status === 404 || (error.status === 400 && /responses|endpoint|route|not found/i.test(error.message));
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
