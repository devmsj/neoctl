import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ModelGateway } from "./model-gateway";
import { NotConfiguredModelGateway } from "./model-gateway";
import { OpenAIResponsesAdapter, type OpenAIEndpointPreference } from "./openai-responses-adapter";

export interface DotEnvLoadOptions {
  override?: boolean;
}

export function createModelGatewayFromEnv(): ModelGateway {
  loadDotEnvIfPresent(undefined, { override: true });

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

export function loadDotEnvIfPresent(
  path = resolve(process.cwd(), ".env"),
  options: DotEnvLoadOptions = {},
): void {
  if (!existsSync(path)) return;
  const content = readFileSync(path, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim();
    const value = stripQuotes(line.slice(separator + 1).trim());
    if (!key) continue;
    if (!options.override && process.env[key] !== undefined) continue;
    process.env[key] = value;
  }
}

function stripQuotes(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
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
