import type { Message } from "../types/messages";
import { buildEffectiveSystemPrompt } from "./prompts";

export interface ContextBuildInput {
  agentId: string;
  messages: readonly Message[];
}

export interface RuntimeContext {
  systemPrompt: string;
  userContext: Record<string, unknown>;
  systemContext: Record<string, unknown>;
}

export interface ContextManager {
  build(input: ContextBuildInput): Promise<RuntimeContext>;
}

export class NoopContextManager implements ContextManager {
  async build(input: ContextBuildInput): Promise<RuntimeContext> {
    return {
      systemPrompt: buildEffectiveSystemPrompt([
        {
          name: "Agent Scaffold",
          content: "You are running inside the TypeScript scaffold. Core behavior is intentionally not implemented yet.",
          cacheStable: true,
        },
        {
          name: "Runtime",
          content: `agentId=${input.agentId}; messages=${input.messages.length}`,
          cacheStable: false,
        },
      ]),
      userContext: {},
      systemContext: {},
    };
  }
}
