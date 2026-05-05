import type { ReasoningConfig } from "./model-gateway";

export type ModelProviderName = "openai";
export type ReasoningEffort = NonNullable<ReasoningConfig["effort"]>;

export interface BaseModelProviderConfig {
  provider: ModelProviderName;
  apiKey?: string;
  baseUrl?: string;
  model: string;
  fallbackModel?: string;
  timeoutMs?: number;
  streamIdleTimeoutMs?: number;
  maxRetries?: number;
  defaultMaxOutputTokens?: number;
  defaultReasoning?: ReasoningConfig;
}

export type OpenAIEndpointPreference = "responses" | "chat" | "auto";

export interface OpenAIProviderConfig extends BaseModelProviderConfig {
  provider: "openai";
  openai?: {
    endpoint?: OpenAIEndpointPreference;
  };
}

export type ModelProviderConfig = OpenAIProviderConfig;

const DEFAULT_OPENAI_MODEL = "gpt-5.5";
const DEFAULT_MAX_OUTPUT_TOKENS = 800;

export function readModelProviderConfig(env: NodeJS.ProcessEnv = process.env): ModelProviderConfig | undefined {
  const provider = parseProvider(env.MODEL_PROVIDER ?? env.OPENAI_PROVIDER ?? "openai");

  switch (provider) {
    case "openai":
      return readOpenAIProviderConfig(env);
  }
}

export function parseReasoning(value: string | undefined): ReasoningConfig | undefined {
  if (!value) return undefined;
  if (value === "minimal" || value === "low" || value === "medium" || value === "high") {
    return { effort: value };
  }
  return undefined;
}

function readOpenAIProviderConfig(env: NodeJS.ProcessEnv): OpenAIProviderConfig | undefined {
  const apiKey = env.MODEL_API_KEY ?? env.OPENAI_API_KEY;
  if (!apiKey) return undefined;

  const endpoint = parseOpenAIEndpoint(env.MODEL_ENDPOINT ?? env.OPENAI_ENDPOINT);

  return {
    provider: "openai",
    apiKey,
    baseUrl: env.MODEL_BASE_URL ?? env.OPENAI_BASE_URL,
    model: env.MODEL_ID ?? env.OPENAI_MODEL ?? DEFAULT_OPENAI_MODEL,
    fallbackModel: env.MODEL_FALLBACK_ID ?? env.OPENAI_FALLBACK_MODEL,
    timeoutMs: parseNumber(env.MODEL_TIMEOUT_MS ?? env.OPENAI_TIMEOUT_MS),
    streamIdleTimeoutMs: parseNumber(env.MODEL_STREAM_IDLE_TIMEOUT_MS ?? env.OPENAI_STREAM_IDLE_TIMEOUT_MS),
    maxRetries: parseNumber(env.MODEL_MAX_RETRIES ?? env.OPENAI_MAX_RETRIES),
    defaultMaxOutputTokens: parseNumber(env.MODEL_MAX_OUTPUT_TOKENS ?? env.OPENAI_MAX_OUTPUT_TOKENS) ?? DEFAULT_MAX_OUTPUT_TOKENS,
    defaultReasoning: parseReasoning(env.MODEL_REASONING_EFFORT ?? env.OPENAI_REASONING_EFFORT),
    openai: endpoint ? { endpoint } : undefined,
  };
}

function parseProvider(value: string): ModelProviderName {
  if (value === "openai") return value;
  throw new Error(`Unsupported MODEL_PROVIDER: ${value}`);
}

function parseOpenAIEndpoint(value: string | undefined): OpenAIEndpointPreference | undefined {
  if (value === "responses" || value === "chat" || value === "auto") return value;
  return undefined;
}

function parseNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
