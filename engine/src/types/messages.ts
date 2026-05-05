export type MessageRole = "system" | "user" | "assistant" | "tool_result" | "progress" | "attachment";

export type MessageBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; toolUseId: string; name: string; ok: boolean; output: unknown };

export interface Message {
  id: string;
  role: MessageRole;
  createdAt: string;
  blocks: MessageBlock[];
  metadata?: Record<string, unknown>;
}

export interface ToolUseRequest {
  id: string;
  name: string;
  input: unknown;
}

export function createTextMessage(role: MessageRole, text: string): Message {
  return {
    id: cryptoId(),
    role,
    createdAt: new Date().toISOString(),
    blocks: [{ type: "text", text }],
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

function cryptoId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
