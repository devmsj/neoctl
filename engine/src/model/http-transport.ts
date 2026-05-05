import { categoryForStatus, ModelAPIError, parseRetryAfterMs } from "./errors.js";

export interface HttpJsonRequest {
  method: "GET" | "POST";
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface HttpJsonResponse<T = unknown> {
  status: number;
  headers: Headers;
  body: T;
}

export interface HttpStreamResponse {
  status: number;
  headers: Headers;
  body: ReadableStream<Uint8Array>;
}

export class HttpTransport {
  constructor(private readonly provider: string) {}

  async sendJson<T = unknown>(request: HttpJsonRequest): Promise<HttpJsonResponse<T>> {
    const response = await this.fetch(request);
    const bodyText = await response.text();
    const body = bodyText ? safeJson(bodyText) : undefined;
    if (!response.ok) throw this.toHttpError(response, body, request);
    return { status: response.status, headers: response.headers, body: body as T };
  }

  async sendStream(request: HttpJsonRequest): Promise<HttpStreamResponse> {
    const response = await this.fetch(request);
    if (!response.ok) {
      const text = await response.text();
      throw this.toHttpError(response, text ? safeJson(text) : undefined, request);
    }
    if (!response.body) {
      throw new ModelAPIError({ category: "provider_bug", provider: this.provider, message: "Streaming response did not include a body" });
    }
    return { status: response.status, headers: response.headers, body: response.body };
  }

  private async fetch(request: HttpJsonRequest): Promise<Response> {
    const controller = new AbortController();
    const timeout = request.timeoutMs
      ? setTimeout(() => controller.abort(), request.timeoutMs)
      : undefined;
    const abortListener = () => controller.abort();
    request.signal?.addEventListener("abort", abortListener, { once: true });

    try {
      return await fetch(request.url, {
        method: request.method,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "User-Agent": "agent-scaffold/0.1.0",
          ...request.headers,
        },
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
        signal: controller.signal,
      });
    } finally {
      if (timeout) clearTimeout(timeout);
      request.signal?.removeEventListener("abort", abortListener);
    }
  }

  private toHttpError(response: Response, body: unknown, request: HttpJsonRequest): ModelAPIError {
    const providerError = typeof body === "object" && body && "error" in body ? (body as { error?: Record<string, unknown> }).error : undefined;
    const message = typeof providerError?.message === "string" ? providerError.message : `HTTP ${response.status} from ${this.provider}`;
    return new ModelAPIError({
      category: categoryForStatus(response.status, body),
      provider: this.provider,
      status: response.status,
      code: typeof providerError?.code === "string" ? providerError.code : undefined,
      message,
      requestId: response.headers.get("x-request-id") ?? response.headers.get("openai-request-id") ?? undefined,
      retryAfterMs: parseRetryAfterMs(response.headers.get("retry-after")),
      request: requestDiagnostics(request),
      response: {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeadersForDiagnostics(response.headers),
        body,
        bodyPreview: previewBody(body),
      },
      raw: body,
    });
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

function requestDiagnostics(request: HttpJsonRequest): { method: string; url: string; path: string } {
  const parsed = new URL(request.url);
  return {
    method: request.method,
    url: parsed.search ? `${parsed.origin}${parsed.pathname}?[redacted-query]` : `${parsed.origin}${parsed.pathname}`,
    path: parsed.pathname,
  };
}

function responseHeadersForDiagnostics(headers: Headers): Record<string, string> {
  const names = [
    "content-type",
    "retry-after",
    "x-request-id",
    "openai-request-id",
    "x-ratelimit-limit-requests",
    "x-ratelimit-remaining-requests",
    "x-ratelimit-reset-requests",
    "x-ratelimit-limit-tokens",
    "x-ratelimit-remaining-tokens",
    "x-ratelimit-reset-tokens",
  ];
  const result: Record<string, string> = {};
  for (const name of names) {
    const value = headers.get(name);
    if (value) result[name] = value;
  }
  return result;
}

function previewBody(body: unknown): string | undefined {
  if (body === undefined) return undefined;
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return text.length > 2000 ? `${text.slice(0, 2000)}... [truncated ${text.length - 2000} chars]` : text;
}
