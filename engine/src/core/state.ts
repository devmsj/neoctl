import type { Message } from "../types/messages";

export type QueryPhase = "ready" | "compacting" | "calling_model" | "running_tools" | "stopped" | "failed";

export interface QueryState {
  phase: QueryPhase;
  turnCount: number;
  messages: Message[];
  maxTokenRecoveries: number;
  reactiveCompactAttempted: boolean;
  pendingToolSummary?: string;
}

export function createInitialState(messages: Message[]): QueryState {
  return {
    phase: "ready",
    turnCount: 0,
    messages: [...messages],
    maxTokenRecoveries: 0,
    reactiveCompactAttempted: false,
  };
}
