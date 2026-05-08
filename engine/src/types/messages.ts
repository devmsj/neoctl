import type { ModelUsage } from "../model/model-gateway.js";

export type MessageRole = "system" | "user" | "assistant" | "tool_result" | "progress" | "attachment" | "tombstone";

export type MessageBlock =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: string; label?: string }
  | { type: "thinking"; text: string; signature?: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; toolUseId: string; name: string; ok: boolean; output: unknown };

export interface Message {
  id: string;
  role: MessageRole;
  createdAt: string;
  blocks: MessageBlock[];
  providerMessageId?: string;
  requestId?: string;
  usage?: ModelUsage;
  isMeta?: boolean;
  isApiErrorMessage?: boolean;
  metadata?: Record<string, unknown>;
}

export interface ToolUseRequest {
  id: string;
  name: string;
  input: unknown;
}

export interface SystemInitPayload {
  agentId: string;
  tools: string[];
  model?: string;
  commands?: string[];
  agents?: string[];
  skills?: string[];
  plugins?: string[];
}

export function createTextMessage(role: MessageRole, text: string): Message {
  return {
    id: cryptoId(),
    role,
    createdAt: new Date().toISOString(),
    blocks: [{ type: "text", text }],
  };
}

export function createThinkingMessage(text: string, signature?: string): Message {
  return {
    id: cryptoId(),
    role: "assistant",
    createdAt: new Date().toISOString(),
    blocks: [{ type: "thinking", text, signature }],
  };
}

export function createToolResultMessage(request: ToolUseRequest, ok: boolean, output: unknown): Message {
  return {
    id: cryptoId(),
    role: "tool_result",
    createdAt: new Date().toISOString(),
    blocks: [{ type: "tool_result", toolUseId: request.id, name: request.name, ok, output }],
  };
}

export function createTombstoneMessage(reason: string): Message {
  return {
    ...createTextMessage("tombstone", reason),
    isMeta: true,
    metadata: { tombstone: true },
  };
}

export function createSystemInitMessage(payload: SystemInitPayload): Message {
  return {
    ...createTextMessage("system", `System initialized for ${payload.agentId}`),
    isMeta: true,
    metadata: { systemInit: true, ...payload },
  };
}

function cryptoId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
