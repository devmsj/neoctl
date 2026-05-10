import { QueryEngine } from "./query-engine.js";
import type { ModelGateway, ModelRequest, ModelStreamEvent } from "../model/model-gateway.js";
import { ToolRegistry } from "../tools/registry.js";
import type { Tool } from "../tools/tool.js";
import { createTextMessage, type MessageBlock } from "../types/messages.js";
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
  readonly requests: ModelRequest[] = [];

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
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

class CapturingGateway implements ModelGateway {
  requests: ModelRequest[] = [];

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    yield { type: "assistant_message", message: createTextMessage("assistant", "ok") };
    yield { type: "response_completed", responseId: "capture_1", stopReason: "completed" };
  }
}

async function main(): Promise<void> {
  const tools = new ToolRegistry();
  tools.register(smokePassthroughTool);
  const gateway = new FakeToolCallingGateway();
  const engine = new QueryEngine({ modelGateway: gateway, tools, maxTurns: 4 });

  const events: string[] = [];
  for await (const event of engine.sendUserText("run tool")) {
    events.push(event.type === "terminal" ? `${event.type}:${event.reason}` : event.type);
  }

  const snapshot = engine.snapshot();
  const sanitized = stripLeakedReasoningText("目录内容：\n- `package-lock.json`We need answer in Chinese likely. Final maybe mention.");

  const imageGateway = new CapturingGateway();
  const imageEngine = new QueryEngine({ model: "gpt-5.4", modelGateway: imageGateway, tools: new ToolRegistry(), maxTurns: 1 });
  const imageBlocks: MessageBlock[] = [
    { type: "text", text: "look" },
    { type: "image", mimeType: "image/png", data: "ZmFrZQ==", label: "[img#1]" },
  ];
  for await (const _event of imageEngine.sendUserText("look [img#1]", { blocks: imageBlocks })) {
    // drain first turn so the image remains in history
  }
  imageEngine.setModel("deepseek-chat");
  const downgradeEvents: string[] = [];
  for await (const event of imageEngine.sendUserText("continue")) {
    downgradeEvents.push(event.type === "terminal" ? `${event.type}:${event.reason}` : event.type);
  }
  const finalImageRequest = imageGateway.requests.at(-1);
  const finalBlocks = finalImageRequest?.messages.flatMap((message) => message.blocks) ?? [];
  const historyImageDowngraded =
    downgradeEvents.includes("terminal:completed") &&
    !finalBlocks.some((block) => block.type === "image") &&
    finalBlocks.some((block) => block.type === "text" && block.text.includes("[img#1]") && block.text.includes("does not support image input"));

  const ok =
    events.includes("tool.started") &&
    events.includes("tool.finished") &&
    events.includes("terminal:completed") &&
    sanitized === "目录内容：\n- `package-lock.json`" &&
    snapshot.messages >= 3 &&
    historyImageDowngraded;
  console.log(JSON.stringify({ ok, events, snapshot, sanitized, downgradeEvents, historyImageDowngraded }, null, 2));
  if (!ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
