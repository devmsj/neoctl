import type { ReasoningConfig, ReasoningEffort } from "./model-gateway.js";

export type ModelProviderName = "openai" | "anthropic";
export type ReasoningSummary = NonNullable<ReasoningConfig["summary"]>;

export interface BaseModelProviderConfig {
  provider: ModelProviderName;
  apiKey?: string;
  baseUrl?: string;
  model: string;
  timeoutMs?: number;
  streamIdleTimeoutMs?: number;
  maxRetries?: number;
  defaultMaxOutputTokens?: number;
  defaultReasoning?: ReasoningConfig | null;
}

export type OpenAIEndpointPreference = "responses" | "chat" | "auto";

export interface OpenAIProviderConfig extends BaseModelProviderConfig {
  provider: "openai";
  openai?: {
    endpoint?: OpenAIEndpointPreference;
  };
}

export interface AnthropicProviderConfig extends BaseModelProviderConfig {
  provider: "anthropic";
  anthropic?: { apiVersion?: string; thinkingBudgetTokens?: number };
}
export type ModelProviderConfig = OpenAIProviderConfig | AnthropicProviderConfig;

const DEFAULT_OPENAI_MODEL = "gpt-5.6";

export function readModelProviderConfig(env: NodeJS.ProcessEnv = process.env): ModelProviderConfig | undefined {
  const provider = parseProvider(env.MODEL_PROVIDER ?? "openai");

  return provider === "anthropic" ? readAnthropicProviderConfig(env) : readOpenAIProviderConfig(env);
}

export function parseReasoning(
  effortValue: string | undefined,
  summaryValue?: string | undefined,
): ReasoningConfig | null | undefined {
  if (effortValue?.trim() === "off") return null;
  const effort = parseReasoningEffort(effortValue);
  const summary = parseReasoningSummary(summaryValue);
  if (!effort && !summary) return undefined;
  return {
    effort,
    summary,
  };
}

function readOpenAIProviderConfig(env: NodeJS.ProcessEnv): OpenAIProviderConfig | undefined {
  const apiKey = firstNonEmpty(env.OPENAI_API_KEY);
  if (!apiKey) return undefined;

  // The application uses Responses only; ignore legacy OPENAI_ENDPOINT values.

  return {
    provider: "openai",
    apiKey,
    baseUrl: firstNonEmpty(env.OPENAI_BASE_URL),
    model: firstNonEmpty(env.OPENAI_MODEL) ?? DEFAULT_OPENAI_MODEL,
    timeoutMs: parseNumber(firstNonEmpty(env.MODEL_TIMEOUT_MS)),
    streamIdleTimeoutMs: parseNumber(firstNonEmpty(env.MODEL_STREAM_IDLE_TIMEOUT_MS)),
    maxRetries: parseNumber(firstNonEmpty(env.MODEL_MAX_RETRIES)),
    defaultMaxOutputTokens: parseNumber(firstNonEmpty(env.MODEL_MAX_OUTPUT_TOKENS)),
    defaultReasoning: parseReasoning(
      firstNonEmpty(env.MODEL_REASONING_EFFORT),
      firstNonEmpty(env.MODEL_REASONING_SUMMARY),
    ),
    openai: { endpoint: "responses" },
  };
}

function readAnthropicProviderConfig(env: NodeJS.ProcessEnv): AnthropicProviderConfig | undefined {
  const apiKey = firstNonEmpty(env.ANTHROPIC_API_KEY);
  if (!apiKey) return undefined;
  return {
    provider: "anthropic", apiKey,
    baseUrl: firstNonEmpty(env.ANTHROPIC_BASE_URL),
    model: firstNonEmpty(env.ANTHROPIC_MODEL) ?? "claude-sonnet-4-6",
    timeoutMs: parseNumber(firstNonEmpty(env.MODEL_TIMEOUT_MS)),
    streamIdleTimeoutMs: parseNumber(firstNonEmpty(env.MODEL_STREAM_IDLE_TIMEOUT_MS)),
    maxRetries: parseNumber(firstNonEmpty(env.MODEL_MAX_RETRIES)),
    defaultMaxOutputTokens: parseNumber(firstNonEmpty(env.MODEL_MAX_OUTPUT_TOKENS)),
    // OpenAI summary settings can remain configured when switching providers.
    defaultReasoning: parseReasoning(firstNonEmpty(env.MODEL_REASONING_EFFORT)),
    anthropic: {
      apiVersion: firstNonEmpty(env.ANTHROPIC_API_VERSION),
      thinkingBudgetTokens: parseNumber(firstNonEmpty(env.ANTHROPIC_THINKING_BUDGET_TOKENS)),
    },
  };
}

function parseReasoningEffort(value: string | undefined): ReasoningEffort | undefined {
  if (value === "none" || value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max") return value;
  return undefined;
}

function parseReasoningSummary(value: string | undefined): ReasoningSummary | undefined {
  if (value === "auto" || value === "concise" || value === "detailed") return value;
  return undefined;
}

function parseProvider(value: string): ModelProviderName {
  if (value === "openai" || value === "anthropic") return value;
  throw new Error(`Unsupported MODEL_PROVIDER: ${value}`);
}

function parseNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (value?.trim()) return value.trim();
  }
  return undefined;
}
