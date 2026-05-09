import { createTextMessage } from "../types/messages.js";
import type { ModelStreamEvent } from "./model-gateway.js";
import { buildChatRequest, normalizeChatStream } from "./openai-chat-mapper.js";

async function main(): Promise<void> {
  const request = buildChatRequest({
    model: "deepseek-reasoner",
    instructions: "Be brief.",
    messages: [createTextMessage("user", "Say pong")],
    tools: [],
    stream: true,
    reasoning: { effort: "high" },
    maxOutputTokens: 16,
  }, {
    model: "deepseek-chat",
    defaultMaxOutputTokens: 800,
    includeMetadata: false,
    includeReasoningContent: true,
  });

  assertEqual(request.model, "deepseek-reasoner", "model override");
  assertDeepEqual(request.thinking, { type: "enabled" }, "deepseek thinking option");
  assertEqual(request.reasoning_effort, "high", "reasoning effort");
  assertEqual("metadata" in request, false, "metadata omitted for deepseek");

  const stream = sseStream([
    { id: "chatcmpl_1", choices: [{ delta: { reasoning_content: "think" } }] },
    { id: "chatcmpl_1", choices: [{ delta: { content: "pong" } }] },
    { id: "chatcmpl_1", choices: [{ finish_reason: "stop", delta: {} }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } },
  ]);

  const events: ModelStreamEvent[] = [];
  events.push(...await collect(normalizeChatStream(stream, { model: "deepseek-reasoner", includeReasoningContent: true })));

  assertEqual(events.some((event) => event.type === "thinking_delta" && event.text === "think"), true, "thinking delta emitted");
  assertEqual(events.some((event) => event.type === "assistant_delta" && event.text === "pong"), true, "assistant delta emitted");
  assertEqual(events.some((event) => event.type === "assistant_message" && event.message.blocks.some((block) => block.type === "thinking" && block.text === "think")), true, "thinking message emitted");
  assertEqual(events.some((event) => event.type === "response_completed" && event.usage?.totalTokens === 5), true, "usage normalized");

  console.log(JSON.stringify({ ok: true, events: events.map((event) => event.type) }, null, 2));
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) items.push(item);
  return items;
}

function sseStream(events: Record<string, unknown>[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const chunks = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
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
