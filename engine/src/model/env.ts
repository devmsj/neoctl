import type { ModelGateway } from "./model-gateway";
import { NotConfiguredModelGateway } from "./model-gateway";
import { OpenAIResponsesAdapter, type OpenAIEndpointPreference } from "./openai-responses-adapter";

export function createModelGatewayFromEnv(): ModelGateway {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return new NotConfiguredModelGateway();

  return new OpenAIResponsesAdapter({
    apiKey,
    baseUrl: process.env.OPENAI_BASE_URL,
    model: process.env.OPENAI_MODEL ?? "gpt-5.4-mini",
    fallbackModel: process.env.OPENAI_FALLBACK_MODEL,
    endpoint: parseEndpoint(process.env.OPENAI_ENDPOINT),
    timeoutMs: parseNumber(process.env.OPENAI_TIMEOUT_MS),
    streamIdleTimeoutMs: parseNumber(process.env.OPENAI_STREAM_IDLE_TIMEOUT_MS),
    maxRetries: parseNumber(process.env.OPENAI_MAX_RETRIES),
    defaultMaxOutputTokens: parseNumber(process.env.OPENAI_MAX_OUTPUT_TOKENS) ?? 800,
  });
}

function parseEndpoint(value: string | undefined): OpenAIEndpointPreference | undefined {
  if (value === "responses" || value === "chat" || value === "auto") return value;
  return undefined;
}

function parseNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
