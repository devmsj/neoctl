import { createTextMessage } from "../types/messages.js";
import type { ModelStreamEvent } from "./model-gateway.js";
import { buildAnthropicRequest, normalizeAnthropicObject, normalizeAnthropicStream } from "./anthropic-mapper.js";

async function main(): Promise<void> {
  const request = buildAnthropicRequest({
    model: "claude-sonnet-4-6",
    instructions: "Be brief.",
    messages: [createTextMessage("user", "Say pong")],
    tools: [{ name: "echo", description: "Echo text", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false } }],
    stream: true,
    reasoning: { effort: "minimal" },
    maxOutputTokens: 128,
    toolChoice: "required",
  }, {
    model: "claude-sonnet-4-6",
    defaultMaxOutputTokens: 800,
  });

  assertEqual(request.model, "claude-sonnet-4-6", "model override");
  assertEqual(request.max_tokens, 128, "max tokens");
  assertDeepEqual(request.tool_choice, { type: "any" }, "tool choice any");
  assertEqual(Array.isArray(request.tools), true, "tools included");
  assertDeepEqual(request.thinking, { type: "enabled", budget_tokens: 1024 }, "thinking option");
  assertEqual(request.system, "Be brief.", "system prompt mapped");

  const stream = sseStream([
    { type: "message_start", message: { id: "msg_1", usage: { input_tokens: 5, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "think" } },
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "echo", input: {} } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"text":"pong"}' } },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { input_tokens: 0, output_tokens: 7 } },
    { type: "message_stop" },
  ]);

  const events: ModelStreamEvent[] = [];
  events.push(...await collect(normalizeAnthropicStream(stream, { model: "claude-sonnet-4-6" })));
  assertEqual(events.some((event) => event.type === "thinking_delta" && event.text === "think"), true, "thinking delta emitted");
  assertEqual(events.some((event) => event.type === "tool_call_delta" && event.callId === "toolu_1"), true, "tool call delta emitted");
  assertEqual(events.some((event) => event.type === "tool_use" && event.toolUse.id === "toolu_1" && (event.toolUse.input as { text: string }).text === "pong"), true, "tool use emitted");
  const usageEvents = events.filter((event) => event.type === "usage");
  const lastUsageEvent = usageEvents[usageEvents.length - 1];
  assertEqual(lastUsageEvent?.type === "usage" ? lastUsageEvent.usage.inputTokens : undefined, 5, "stream usage preserves input tokens when delta reports zero");
  assertEqual(lastUsageEvent?.type === "usage" ? lastUsageEvent.usage.outputTokens : undefined, 7, "stream usage updates output tokens");
  assertEqual(events.some((event) => event.type === "response_completed" && event.responseId === "msg_1" && event.usage?.inputTokens === 5 && event.usage.outputTokens === 7), true, "response completed with merged usage");

  const objectEvents = [...normalizeAnthropicObject({
    status: 200,
    headers: new Headers(),
    body: {
      id: "msg_2",
      content: [
        { type: "text", text: "done" },
        { type: "tool_use", id: "toolu_2", name: "echo", input: { text: "pong" } },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 3, output_tokens: 4 },
    },
  })];
  assertEqual(objectEvents.some((event) => event.type === "assistant_message" && event.message.blocks.some((block) => block.type === "text" && block.text === "done")), true, "object assistant message");
  assertEqual(objectEvents.some((event) => event.type === "tool_use" && event.toolUse.id === "toolu_2"), true, "object tool use");

  console.log(JSON.stringify({ ok: true, streamEventTypes: events.map((event) => event.type), objectEventTypes: objectEvents.map((event) => event.type) }, null, 2));
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) items.push(item);
  return items;
}

function sseStream(events: Record<string, unknown>[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const chunks = events.map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join("");
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(chunks));
      controller.close();
    },
  });
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
}

function assertDeepEqual(actual: unknown, expected: unknown, label: string): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) throw new Error(`${label}: expected ${expectedJson}, got ${actualJson}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
