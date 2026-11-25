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
  | "unsupported_image_input"
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
  request?: ModelAPIRequestDiagnostics;
  response?: ModelAPIResponseDiagnostics;
  raw?: unknown;
}

export interface ModelAPIRequestDiagnostics {
  method?: string;
  url?: string;
  path?: string;
}

export interface ModelAPIResponseDiagnostics {
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  body?: unknown;
  bodyPreview?: string;
}

export class ModelAPIError extends Error {
  readonly category: ModelAPIErrorCategory;
  readonly provider: string;
  readonly status?: number;
  readonly code?: string;
  readonly requestId?: string;
  readonly retryAfterMs?: number;
  readonly retryable: boolean;
  readonly request?: ModelAPIRequestDiagnostics;
  readonly response?: ModelAPIResponseDiagnostics;
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
    this.request = init.request;
    this.response = init.response;
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

const QUOTA_CODES = new Set([
  "insufficient_quota",
  "credit_balance_exhausted",
  "organization_spend_limit_exceeded",
  "project_spend_limit_exceeded",
  "organization_usage_limit_exceeded",
  "billing_hard_limit_reached",
  "billing_error",
]);

/**
 * Billing/quota exhaustion, where retrying cannot succeed until the account changes.
 * Matched only on explicit error codes or unambiguous phrases, so ordinary 429
 * throttling from any provider or gateway keeps its normal retry behaviour.
 */
export function isQuotaExhausted(body: unknown): boolean {
  const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
  const error = isRecord(body) && isRecord(body.error) ? body.error : body;
  if (!isRecord(error)) return false;
  for (const key of ["code", "type"]) {
    const value = error[key];
    if (typeof value === "string" && QUOTA_CODES.has(value)) return true;
  }
  const message = typeof error.message === "string" ? error.message : "";
  return /exceeded your current quota|credit balance is (?:too low|exhausted)|monthly spend cap|spend limit (?:reached|exceeded)|insufficient (?:balance|credits?)/i.test(message);
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
