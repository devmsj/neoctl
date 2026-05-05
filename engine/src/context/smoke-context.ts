import { ModelAPIError } from "../model/errors";
import type { ModelGateway, ModelRequest, ModelStreamEvent } from "../model/model-gateway";
import { QueryEngine } from "../core/query-engine";
import { applyToolResultBudget, appendSystemContext, prependUserContext } from "../core/message-pipeline";
import { ToolRegistry } from "../tools/registry";
import { createTextMessage, createToolResultMessage } from "../types/messages";
import { DeterministicCompactor } from "./compaction";
import { DefaultContextManager } from "./context-manager";
import { buildEffectiveSystemPrompt, splitSystemPromptPrefix, SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from "./prompts";

class ContextOverflowThenSuccessGateway implements ModelGateway {
  calls = 0;
  sawBoundaryOnRetry = false;
  sawUserContext = false;
  sawSystemContext = false;

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.calls += 1;
    this.sawUserContext ||= request.messages.some((message) => message.metadata?.userContext === true);
    this.sawSystemContext ||= Boolean(request.systemPrompt?.includes("## System Context"));

    if (this.calls === 1) {
      throw new ModelAPIError({
        category: "context_length",
        provider: "fake",
        message: "context length exceeded",
        retryable: false,
      });
    }

    this.sawBoundaryOnRetry = request.messages.some((message) => message.metadata?.compactBoundary === true);
    yield { type: "assistant_message", message: createTextMessage("assistant", "compacted") };
    yield { type: "response_completed", responseId: "resp_context", stopReason: "completed" };
  }
}

async function main(): Promise<void> {
  const prompt = buildEffectiveSystemPrompt([
    { name: "Stable", content: "cache me", cacheStable: true },
    { name: "Dynamic", content: "session only", cacheStable: false },
  ]);
  const split = splitSystemPromptPrefix(prompt);
  const promptOk =
    prompt.includes(SYSTEM_PROMPT_DYNAMIC_BOUNDARY) &&
    split.stablePrefix.includes("cache me") &&
    split.dynamicSuffix.includes("session only");

  const contextManager = new DefaultContextManager({ currentDate: () => "2026-05-05" });
  const runtime = await contextManager.build({ agentId: "main", messages: [createTextMessage("user", "hello")] });
  const contextOk =
    runtime.userContext.currentDate === "2026-05-05" &&
    Boolean(runtime.systemContext.cwd) &&
    appendSystemContext(runtime.systemPrompt, runtime.systemContext).includes("## System Context") &&
    prependUserContext([], runtime.userContext)[0]?.metadata?.userContext === true;

  const toolResult = createToolResultMessage({ id: "call_big", name: "big", input: {} }, true, "x".repeat(120));
  const budgeted = applyToolResultBudget([toolResult], { maxSerializedLength: 20 });
  const budgetOk = budgeted[0].metadata?.budgeted === true;

  const compactor = new DeterministicCompactor();
  const longHistory = Array.from({ length: 12 }, (_, index) => createTextMessage(index % 2 ? "assistant" : "user", `${index}: ${"x".repeat(600)}`));
  const compacted = await compactor.compact(longHistory, {
    snipMaxChars: 2000,
    microCompactMaxChars: 1800,
    autoCompactMaxChars: 1500,
    keepRecentMessages: 4,
  });
  const compactOk = compacted.changed && compacted.messages.some((message) => message.metadata?.compactBoundary === true);

  const gateway = new ContextOverflowThenSuccessGateway();
  const engine = new QueryEngine({
    modelGateway: gateway,
    tools: new ToolRegistry(),
    contextManager,
    compactor,
    contextBudget: { keepRecentMessages: 3, summaryMaxChars: 1000 },
    maxTurns: 4,
  });

  const events: string[] = [];
  for await (const event of engine.sendUserText("trigger reactive compact")) {
    events.push(event.type === "terminal" ? `${event.type}:${event.reason}` : event.type);
  }

  const reactiveOk =
    gateway.calls === 2 &&
    gateway.sawBoundaryOnRetry &&
    gateway.sawUserContext &&
    gateway.sawSystemContext &&
    events.includes("terminal:completed");

  const ok = promptOk && contextOk && budgetOk && compactOk && reactiveOk;
  console.log(JSON.stringify({ ok, promptOk, contextOk, budgetOk, compactOk, reactiveOk, events, calls: gateway.calls }, null, 2));
  if (!ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
