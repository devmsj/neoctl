import type { ContextManager } from "../context/context-manager";
import { NoopContextManager } from "../context/context-manager";
import type { ModelGateway } from "../model/model-gateway";
import type { ToolRegistry } from "../tools/registry";
import { runToolUse } from "../tools/run-tool-use";
import type { AgentEvent } from "../types/events";
import type { Message } from "../types/messages";
import { createInitialState } from "./state";
import { InMemoryAppState } from "../app/app-state";

export interface QueryOptions {
  agentId: string;
  abortSignal?: AbortSignal;
}

export interface QueryDependencies {
  modelGateway: ModelGateway;
  tools: ToolRegistry;
  contextManager?: ContextManager;
}

export async function* query(
  messages: Message[],
  dependencies: QueryDependencies,
  options: QueryOptions,
): AsyncGenerator<AgentEvent> {
  const state = createInitialState(messages);
  const contextManager = dependencies.contextManager ?? new NoopContextManager();
  const appState = new InMemoryAppState(options.agentId);

  yield { type: "state", phase: state.phase, detail: "query initialized" };

  state.phase = "compacting";
  const context = await contextManager.build({ agentId: options.agentId, messages: state.messages });
  yield { type: "state", phase: state.phase, detail: "context assembled" };

  state.phase = "calling_model";
  yield { type: "state", phase: state.phase, detail: "model stream opened" };

  for await (const event of dependencies.modelGateway.stream({
    messages: state.messages,
    systemPrompt: context.systemPrompt,
    tools: dependencies.tools.definitions(),
    stream: true,
  })) {
    if (event.type === "assistant_delta") {
      yield { type: "assistant.delta", text: event.text };
      continue;
    }

    if (event.type === "assistant_message") {
      state.messages.push(event.message);
      appState.appendMessage(event.message);
      yield { type: "message", message: event.message };
      continue;
    }

    if (event.type === "tool_use") {
      state.phase = "running_tools";
      yield { type: "tool.started", toolUse: event.toolUse };
      const result = await runToolUse(event.toolUse, {
        agentId: options.agentId,
        abortSignal: options.abortSignal,
        tools: dependencies.tools,
        appState,
        emit: () => undefined,
      });
      state.messages.push(result);
      yield { type: "message", message: result };
      yield { type: "tool.finished", toolUse: event.toolUse, ok: true };
    }
  }

  state.phase = "stopped";
  yield { type: "state", phase: state.phase, detail: "no pending tool use" };
}
