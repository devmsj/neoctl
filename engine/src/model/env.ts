import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getNeoctlHome } from "../paths.js";
import type { ModelGateway } from "./model-gateway.js";
import { createModelGatewayFromProcessEnv } from "./provider-factory.js";
import { parseReasoning } from "./config.js";

export interface DotEnvLoadOptions {
  override?: boolean;
}

export interface DefaultDotEnvLoadResult {
  userDotEnvPath: string;
  createdUserDotEnv: boolean;
}

const USER_DOT_ENV_TEMPLATE = `# Neo CLI model configuration
# Keep provider-specific credentials/settings isolated. Choose the active provider here.

MODEL_PROVIDER=openai

# OpenAI provider settings
# OPENAI_API_KEY=your-openai-api-key
# OPENAI_BASE_URL=https://api.openai.com
# OPENAI_MODEL=gpt-5.5
# OPENAI_FALLBACK_MODEL=
# OPENAI_ENDPOINT=auto

# Anthropic provider settings
# ANTHROPIC_API_KEY=your-anthropic-api-key
# ANTHROPIC_BASE_URL=https://api.anthropic.com
# ANTHROPIC_MODEL=claude-sonnet-4-6
# ANTHROPIC_FALLBACK_MODEL=
# ANTHROPIC_VERSION=2023-06-01

# Shared model runtime settings
# MODEL_REASONING_EFFORT=high
# MODEL_REASONING_SUMMARY=auto
# MODEL_MAX_OUTPUT_TOKENS=800
# MODEL_TIMEOUT_MS=120000
# MODEL_STREAM_IDLE_TIMEOUT_MS=120000
# MODEL_MAX_RETRIES=2
`;

export function createModelGatewayFromEnv(): ModelGateway {
  loadDefaultDotEnvFiles({ override: true });
  return createModelGatewayFromProcessEnv(process.env);
}

export function loadDefaultDotEnvFiles(options: DotEnvLoadOptions = {}): DefaultDotEnvLoadResult {
  const userDotEnvPath = getUserDotEnvPath();
  const createdUserDotEnv = ensureUserDotEnvFile(userDotEnvPath);
  loadDotEnvIfPresent(userDotEnvPath, options);

  const explicitPath = process.env.NEO_ENV_FILE?.trim();
  if (explicitPath) loadDotEnvIfPresent(resolve(explicitPath), { ...options, override: true });

  return { userDotEnvPath, createdUserDotEnv };
}

export function getUserDotEnvPath(): string {
  return resolve(getNeoctlHome(), ".env");
}

export function loadDotEnvIfPresent(
  path = getUserDotEnvPath(),
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

export { parseReasoning };

function ensureUserDotEnvFile(path: string): boolean {
  if (existsSync(path)) return false;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, USER_DOT_ENV_TEMPLATE, { encoding: "utf8", flag: "wx" });
  return true;
}

function stripQuotes(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}
