import type { Message } from "../types/messages.js";

export type QueryPhase =
  | "ready"
  | "preparing"
  | "compacting"
  | "calling_model"
  | "running_tools"
  | "injecting_context";

export type ContinueReason =
  | "initial"
  | "next_turn"
  | "max_output_tokens_escalate"
  | "reactive_compact_retry";

export type TerminalReason =
  | "completed"
  | "model_error"
  | "image_error"
  | "prompt_too_long"
  | "aborted_streaming"
  | "aborted_tools"
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
  turnCount: number;
  transition: LoopTransition;
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
