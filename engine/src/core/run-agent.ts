import type { QueryDependencies } from "./query";
import { query } from "./query";
import type { AgentEvent } from "../types/events";
import type { Message } from "../types/messages";

export interface RunAgentOptions {
  agentId: string;
  messages: Message[];
  dependencies: QueryDependencies;
  abortSignal?: AbortSignal;
}

export async function* runAgent(options: RunAgentOptions): AsyncGenerator<AgentEvent> {
  yield* query(options.messages, options.dependencies, {
    agentId: options.agentId,
    abortSignal: options.abortSignal,
  });
}
