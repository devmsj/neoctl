import { QueryEngine } from "./query-engine.js";
import type { ModelGateway, ModelRequest, ModelStreamEvent } from "../model/model-gateway.js";
import { ToolRegistry } from "../tools/registry.js";
import type { Tool } from "../tools/tool.js";
import { createTextMessage } from "../types/messages.js";
import { stripLeakedReasoningText } from "./assistant-output-filter.js";

const smokePassthroughTool: Tool<{ text: string }> = {
  name: "smoke_passthrough",
  description: "Smoke test passthrough tool.",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
    additionalProperties: false,
  },
  metadata: { readOnly: true, concurrent: true, visible: true },
  validate(input) {
    return input as { text: string };
  },
  async call(input) {
    return { ok: true, output: input.text };
  },
};

class FakeToolCallingGateway implements ModelGateway {
  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    const hasToolResult = request.messages.some((message) =>
      message.blocks.some((block) => block.type === "tool_result"),
    );

    if (!hasToolResult) {
      yield { type: "tool_use", toolUse: { id: "call_smoke_passthrough", name: "smoke_passthrough", input: { text: "pong" } } };
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
  tools.register(smokePassthroughTool);
  const engine = new QueryEngine({ modelGateway: new FakeToolCallingGateway(), tools, maxTurns: 4 });

  const events: string[] = [];
  for await (const event of engine.sendUserText("run tool")) {
    events.push(event.type === "terminal" ? `${event.type}:${event.reason}` : event.type);
  }

  const snapshot = engine.snapshot();
  const sanitized = stripLeakedReasoningText("目录内容：\n- `package-lock.json`We need answer in Chinese likely. Final maybe mention.");
  const ok =
    events.includes("tool.started") &&
    events.includes("tool.finished") &&
    events.includes("terminal:completed") &&
    sanitized === "目录内容：\n- `package-lock.json`" &&
    snapshot.messages >= 3;
  console.log(JSON.stringify({ ok, events, snapshot, sanitized }, null, 2));
  if (!ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
