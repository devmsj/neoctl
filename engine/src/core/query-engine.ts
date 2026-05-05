import type { ContextManager } from "../context/context-manager";
import type { ModelGateway } from "../model/model-gateway";
import type { ToolRegistry } from "../tools/registry";
import type { AgentEvent } from "../types/events";
import type { Message } from "../types/messages";
import { createTextMessage } from "../types/messages";
import { query } from "./query";

export interface QueryEngineOptions {
  agentId?: string;
  modelGateway: ModelGateway;
  tools: ToolRegistry;
  contextManager?: ContextManager;
}

export class QueryEngine {
  private readonly agentId: string;
  private readonly history: Message[] = [];

  constructor(private readonly options: QueryEngineOptions) {
    this.agentId = options.agentId ?? "main";
  }

  async *sendUserText(text: string): AsyncGenerator<AgentEvent> {
    const userMessage = createTextMessage("user", text);
    this.history.push(userMessage);

    for await (const event of query(this.history, this.options, { agentId: this.agentId })) {
      if (event.type === "message") {
        this.history.push(event.message);
      }
      yield event;
    }
  }

  reset(): void {
    this.history.length = 0;
  }

  snapshot(): { agentId: string; messages: number } {
    return { agentId: this.agentId, messages: this.history.length };
  }
}
