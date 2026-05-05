import type { TerminalReason } from "../core/state";
import type { ModelUsage } from "../model/model-gateway";
import type { Message, ToolUseRequest } from "./messages";

export type AgentEvent =
  | { type: "state"; phase: string; detail?: string }
  | { type: "assistant.delta"; text: string }
  | { type: "message"; message: Message }
  | { type: "tool.started"; toolUse: ToolUseRequest }
  | { type: "tool.finished"; toolUse: ToolUseRequest; ok: boolean }
  | { type: "usage"; usage: ModelUsage }
  | { type: "retrying"; attempt: number; delayMs: number; error: Error }
  | { type: "terminal"; reason: TerminalReason; detail?: string }
  | { type: "error"; error: Error };
