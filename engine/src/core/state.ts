import type { Message } from "../types/messages.js";
import type { ModelUsage } from "../model/model-gateway.js";

export type QueryPhase =
  | "ready"
  | "preparing"
  | "compacting"
  | "calling_model"
  | "running_tools"
  | "injecting_context"
  | "stopped"
  | "failed";

export type ContinueReason =
  | "initial"
  | "next_turn"
  | "fallback_model"
  | "max_output_tokens_escalate"
  | "max_output_tokens_recovery"
  | "reactive_compact_retry"
  | "stop_hook_blocking"
  | "token_budget_continuation";

export type TerminalReason =
  | "completed"
  | "blocking_limit"
  | "model_error"
  | "image_error"
  | "prompt_too_long"
  | "aborted_streaming"
  | "aborted_tools"
  | "hook_stopped"
  | "stop_hook_prevented"
  | "max_turns";

export interface QueryTracking {
  chainId: string;
  depth: number;
  turnId: string;
  turnCounter: number;
}

export interface LoopTransition {
  reason: ContinueReason;
  detail?: string;
}

export interface QueryState {
  phase: QueryPhase;
  messages: Message[];
  modelInputMessages?: Message[];
  previousResponseId?: string;
  currentModel?: string;
  fallbackModel?: string;
  queryTracking: QueryTracking;
  maxOutputTokensRecoveryCount: number;
  hasAttemptedReactiveCompact: boolean;
  maxOutputTokensOverride?: number;
  pendingToolSummary?: string;
  stopHookActive?: boolean;
  turnCount: number;
  transition: LoopTransition;
  lastUsage?: ModelUsage;
}

export function createInitialState(messages: Message[], options?: { model?: string; fallbackModel?: string }): QueryState {
  const chainId = cryptoId("chain");
  return {
    phase: "ready",
    messages: [...messages],
    currentModel: options?.model,
    fallbackModel: options?.fallbackModel,
    queryTracking: {
      chainId,
      depth: 0,
      turnId: cryptoId("turn"),
      turnCounter: 0,
    },
    maxOutputTokensRecoveryCount: 0,
    hasAttemptedReactiveCompact: false,
    turnCount: 0,
    transition: { reason: "initial" },
  };
}

export function nextTracking(previous: QueryTracking): QueryTracking {
  return {
    chainId: previous.chainId,
    depth: previous.depth,
    turnCounter: previous.turnCounter + 1,
    turnId: cryptoId("turn"),
  };
}

function cryptoId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
