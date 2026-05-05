import { QueryEngine } from "./query-engine";
import type { ModelGateway, ModelRequest, ModelStreamEvent } from "../model/model-gateway";
import { ToolRegistry } from "../tools/registry";
import { echoTool } from "../tools/builtins/echo-tool";
import { createTextMessage } from "../types/messages";

class FakeToolCallingGateway implements ModelGateway {
  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    const hasToolResult = request.messages.some((message) =>
      message.blocks.some((block) => block.type === "tool_result"),
    );

    if (!hasToolResult) {
      yield { type: "tool_use", toolUse: { id: "call_echo", name: "echo", input: { text: "pong" } } };
      yield { type: "response_completed", responseId: "resp_1", stopReason: "tool_calls" };
      return;
    }

    yield { type: "assistant_delta", text: "done" };
    yield { type: "assistant_message", message: createTextMessage("assistant", "done") };
    yield { type: "response_completed", responseId: "resp_2", stopReason: "completed" };
  }
}

async function main(): Promise<void> {
  const tools = new ToolRegistry();
  tools.register(echoTool);
  const engine = new QueryEngine({ modelGateway: new FakeToolCallingGateway(), tools, maxTurns: 4 });

  const events: string[] = [];
  for await (const event of engine.sendUserText("run tool")) {
    events.push(event.type === "terminal" ? `${event.type}:${event.reason}` : event.type);
  }

  const snapshot = engine.snapshot();
  const ok =
    events.includes("tool.started") &&
    events.includes("tool.finished") &&
    events.includes("terminal:completed") &&
    snapshot.messages >= 3;
  console.log(JSON.stringify({ ok, events, snapshot }, null, 2));
  if (!ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
