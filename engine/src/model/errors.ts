export type ModelAPIErrorCategory =
  | "network"
  | "timeout"
  | "rate_limit"
  | "overloaded"
  | "invalid_request"
  | "auth_unavailable"
  | "permission_denied"
  | "context_length"
  | "max_output_tokens"
  | "server_error"
  | "provider_bug"
  | "user_abort";

export interface ModelAPIErrorInit {
  category: ModelAPIErrorCategory;
  provider: string;
  message: string;
  status?: number;
  code?: string;
  requestId?: string;
  retryAfterMs?: number;
  retryable?: boolean;
  raw?: unknown;
}

export class ModelAPIError extends Error {
  readonly category: ModelAPIErrorCategory;
  readonly provider: string;
  readonly status?: number;
  readonly code?: string;
  readonly requestId?: string;
  readonly retryAfterMs?: number;
  readonly retryable: boolean;
  readonly raw?: unknown;

  constructor(init: ModelAPIErrorInit) {
    super(init.message);
    this.name = "ModelAPIError";
    this.category = init.category;
    this.provider = init.provider;
    this.status = init.status;
    this.code = init.code;
    this.requestId = init.requestId;
    this.retryAfterMs = init.retryAfterMs;
    this.retryable = init.retryable ?? defaultRetryable(init.category, init.status);
    this.raw = init.raw;
  }
}

export function normalizeUnknownError(error: unknown, provider: string): ModelAPIError {
  if (error instanceof ModelAPIError) return error;
  if (error instanceof DOMException && error.name === "AbortError") {
    return new ModelAPIError({ category: "timeout", provider, message: "Request aborted or timed out", retryable: true, raw: error });
  }
  if (error instanceof Error) {
    return new ModelAPIError({ category: "network", provider, message: error.message, retryable: true, raw: error });
  }
  return new ModelAPIError({ category: "provider_bug", provider, message: String(error), retryable: false, raw: error });
}

export function categoryForStatus(status: number, body?: unknown): ModelAPIErrorCategory {
  const text = JSON.stringify(body ?? {}).toLowerCase();
  if (status === 401) return "auth_unavailable";
  if (status === 403) return "permission_denied";
  if (status === 408) return "timeout";
  if (status === 409) return "overloaded";
  if (status === 429) return "rate_limit";
  if (status >= 500) return text.includes("overloaded") ? "overloaded" : "server_error";
  if (text.includes("context") && text.includes("length")) return "context_length";
  if (text.includes("max_output_tokens")) return "max_output_tokens";
  return "invalid_request";
}

export function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}

function defaultRetryable(category: ModelAPIErrorCategory, status?: number): boolean {
  if (["network", "timeout", "rate_limit", "overloaded", "server_error"].includes(category)) return true;
  return status === 408 || status === 409 || status === 429 || (status !== undefined && status >= 500);
}
