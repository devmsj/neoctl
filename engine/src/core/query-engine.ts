import type { ContextManager } from "../context/context-manager";
import type { Compactor, ContextBudgetOptions } from "../context/compaction";
import type { ModelGateway } from "../model/model-gateway";
import type { ToolRegistry } from "../tools/registry";
import type { CanUseTool } from "../tools/tool";
import type { QueryOptions } from "./query";
import type { AgentEvent } from "../types/events";
import type { Message } from "../types/messages";
import { createTextMessage } from "../types/messages";
import { query } from "./query";
import type { TerminalReason } from "./state";

export interface QueryEngineOptions {
  agentId?: string;
  model?: string;
  fallbackModel?: string;
  queryOrigin?: string;
  maxOutputTokensOverride?: number;
  maxTurns?: number;
  modelGateway: ModelGateway;
  tools: ToolRegistry;
  contextManager?: ContextManager;
  compactor?: Compactor;
  contextBudget?: ContextBudgetOptions;
  canUseTool?: CanUseTool;
}

export class QueryEngine {
  private readonly agentId: string;
  private readonly history: Message[] = [];
  private lastTerminalReason?: TerminalReason;

  constructor(private readonly options: QueryEngineOptions) {
    this.agentId = options.agentId ?? "main";
  }

  async *sendUserText(text: string): AsyncGenerator<AgentEvent> {
    const userMessage = createTextMessage("user", text);
    this.history.push(userMessage);

    const queryOptions: QueryOptions = {
      agentId: this.agentId,
      model: this.options.model,
      fallbackModel: this.options.fallbackModel,
      queryOrigin: this.options.queryOrigin ?? "repl",
      maxOutputTokensOverride: this.options.maxOutputTokensOverride,
      maxTurns: this.options.maxTurns,
    };

    const stream = query(this.history, this.options, queryOptions);
    for await (const event of stream) {
      if (event.type === "message") {
        this.history.push(event.message);
      }
      if (event.type === "terminal") {
        this.lastTerminalReason = event.reason;
      }
      yield event;
    }
  }

  reset(): void {
    this.history.length = 0;
    this.lastTerminalReason = undefined;
  }

  snapshot(): { agentId: string; messages: number; lastTerminalReason?: TerminalReason } {
    return {
      agentId: this.agentId,
      messages: this.history.length,
      lastTerminalReason: this.lastTerminalReason,
    };
  }
}
