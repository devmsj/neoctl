import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ModelGateway } from "./model-gateway";
import { createModelGatewayFromProcessEnv } from "./provider-factory";
import { parseReasoning } from "./config";

export interface DotEnvLoadOptions {
  override?: boolean;
}

export function createModelGatewayFromEnv(): ModelGateway {
  loadDotEnvIfPresent(undefined, { override: true });
  return createModelGatewayFromProcessEnv(process.env);
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

function stripQuotes(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}
