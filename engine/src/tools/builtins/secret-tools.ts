import type { Tool, ToolUseContext } from "../tool.js";

function requireSecrets(context: ToolUseContext) {
  if (!context.secrets) throw new Error("Secret store is not available in this runtime.");
  return context.secrets;
}

function normalizeReason(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 500) : undefined;
}

export const secretListTool: Tool<Record<string, never>> = {
  name: "secret_list",
  description: "List available secret keys, statuses, and value lengths. Secret values are never returned.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  metadata: { readOnly: true, concurrent: true, visible: true },
  async execute(_input, context) {
    const secrets = await requireSecrets(context).list();
    return { ok: true, output: { secrets } };
  },
};

export const secretInfoTool: Tool<{ key: string }> = {
  name: "secret_info",
  description: "Inspect one secret key's existence, status, and value length. Secret values are never returned.",
  inputSchema: {
    type: "object",
    properties: { key: { type: "string", description: "Secret key to inspect." } },
    required: ["key"],
    additionalProperties: false,
  },
  metadata: { readOnly: true, concurrent: true, visible: true },
  validate(input) {
    const raw = input as { key?: unknown };
    if (typeof raw.key !== "string" || !raw.key.trim()) throw new Error("key is required");
    return { key: raw.key.trim() };
  },
  async execute(input, context) {
    const info = await requireSecrets(context).info(input.key);
    return { ok: true, output: info ? { exists: true, ...info } : { exists: false, key: input.key } };
  },
};

export const secretRequestTool: Tool<{ key: string; reason?: string }> = {
  name: "secret_request",
  description: "Create an empty secret placeholder by key so the user can fill it later in REPL. Non-interactive; never asks for or returns a secret value.",
  inputSchema: {
    type: "object",
    properties: {
      key: { type: "string", description: "Secret key to request, e.g. github_token." },
      reason: { type: "string", description: "Why this secret is needed." },
    },
    required: ["key"],
    additionalProperties: false,
  },
  metadata: { readOnly: false, concurrent: false, visible: true },
  validate(input) {
    const raw = input as { key?: unknown; reason?: unknown };
    if (typeof raw.key !== "string" || !raw.key.trim()) throw new Error("key is required");
    return { key: raw.key.trim(), reason: normalizeReason(raw.reason) };
  },
  async execute(input, context) {
    const meta = await requireSecrets(context).requestEmpty(input.key, { reason: input.reason, requestedBy: "agent" });
    return {
      ok: true,
      output: {
        ...meta,
        message: meta.status === "set"
          ? "Secret already exists."
          : `Secret placeholder is empty. Fill it in REPL with: /secret set ${meta.key} <value>`,
      },
    };
  },
};

export function createSecretTools(): Tool<any>[] {
  return [secretListTool, secretInfoTool, secretRequestTool];
}
