import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
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
# Uncomment and fill these values, then run: neo

# MODEL_PROVIDER=openai
# MODEL_API_KEY=your-api-key
# MODEL_BASE_URL=https://api.openai.com
# MODEL_ID=gpt-4.1
# MODEL_ENDPOINT=auto

# Optional
# MODEL_FALLBACK_ID=
# MODEL_REASONING_EFFORT=
# MODEL_MAX_OUTPUT_TOKENS=
`;

export function createModelGatewayFromEnv(): ModelGateway {
  loadDefaultDotEnvFiles({ override: true });
  return createModelGatewayFromProcessEnv(process.env);
}

export function loadDefaultDotEnvFiles(options: DotEnvLoadOptions = {}): DefaultDotEnvLoadResult {
  loadDotEnvIfPresent(resolve(process.cwd(), ".env"), options);

  const userDotEnvPath = getUserDotEnvPath();
  const createdUserDotEnv = ensureUserDotEnvFile(userDotEnvPath);
  loadDotEnvIfPresent(userDotEnvPath, { ...options, override: true });

  const explicitPath = process.env.NEO_ENV_FILE?.trim();
  if (explicitPath) loadDotEnvIfPresent(resolve(explicitPath), { ...options, override: true });

  return { userDotEnvPath, createdUserDotEnv };
}

export function getUserDotEnvPath(): string {
  const baseDir = process.env.APPDATA || resolve(homedir(), ".config");
  return resolve(baseDir, "neo", ".env");
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
