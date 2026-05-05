import type { Message, ToolUseRequest } from "./messages";

export type AgentEvent =
  | { type: "state"; phase: string; detail?: string }
  | { type: "assistant.delta"; text: string }
  | { type: "message"; message: Message }
  | { type: "tool.started"; toolUse: ToolUseRequest }
  | { type: "tool.finished"; toolUse: ToolUseRequest; ok: boolean }
  | { type: "error"; error: Error };
