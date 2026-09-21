import assert from "node:assert/strict";
import test from "node:test";
import { normalizeChatStream } from "../../src/model/openai-chat-mapper.js";
import { normalizeResponsesStream } from "../../src/model/openai-responses-mapper.js";
import type { ModelStreamEvent } from "../../src/model/model-gateway.js";

function transport() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
  return { stream, send(event: unknown) { controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)); }, close() { controller.close(); } };
}
async function nextSemantic(iterator: AsyncGenerator<ModelStreamEvent>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => { for (;;) { const item = await iterator.next(); if (item.done || item.value.type !== "provider_event") return item; } })(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("header event waited for arguments")), 1000); }),
    ]);
  } finally { clearTimeout(timer); }
}
for (const api of ["chat", "responses"] as const) {
  test(`${api}: header-only chunk emits before arguments, once per interleaved call`, async () => {
    const source = transport();
    const iterator = api === "chat" ? normalizeChatStream(source.stream, { model: "test" }) : normalizeResponsesStream(source.stream, { model: "test" });
    const header = (index: number, name: string) => api === "chat"
      ? { choices: [{ delta: { tool_calls: [{ index, id: `call_${index}`, function: { name, arguments: "" } }] } }] }
      : { type: "response.output_item.added", output_index: index, item: { type: "function_call", call_id: `call_${index}`, name, arguments: "" } };
    try {
      source.send(header(0, "file_edit"));
      assert.deepEqual((await nextSemantic(iterator)).value, { type: "tool_call_started", callId: "call_0", name: "file_edit" });
      source.send(header(1, "custom_plugin"));
      assert.deepEqual((await nextSemantic(iterator)).value, { type: "tool_call_started", callId: "call_1", name: "custom_plugin" });
      source.send(header(0, "file_edit")); // repeated header is not another start
      if (api === "chat") {
        source.send({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] } }] });
      } else {
        source.send({ type: "response.function_call_arguments.delta", output_index: 0, delta: '{"path":' });
      }
      assert.deepEqual((await nextSemantic(iterator)).value, { type: "tool_call_delta", callId: "call_0", name: "file_edit", argumentsDelta: '{"path":' });
    } finally { source.close(); await iterator.return(undefined); }
  });

  test(`${api}: text-only stream does not invent tool activity`, async () => {
    const source = transport();
    source.send(api === "chat" ? { choices: [{ delta: { content: "I will edit a file" } }] } : { type: "response.output_text.delta", delta: "I will edit a file" });
    source.close();
    const events: ModelStreamEvent[] = [];
    for await (const event of api === "chat" ? normalizeChatStream(source.stream, { model: "test" }) : normalizeResponsesStream(source.stream, { model: "test" })) events.push(event);
    assert(!events.some(event => event.type === "tool_call_started"));
  });
}

test("chat: late name is observed without parsing or completing partial JSON", async () => {
  const source = transport();
  const iterator = normalizeChatStream(source.stream, { model: "test" });
  try {
    source.send({ choices: [{ delta: { tool_calls: [{ index: 0, id: "a", function: { arguments: "{" } }] } }] });
    assert.equal((await nextSemantic(iterator)).value?.type, "tool_call_delta");
    source.send({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "arbitrary_tool" } }] } }] });
    assert.deepEqual((await nextSemantic(iterator)).value, { type: "tool_call_started", callId: "a", name: "arbitrary_tool" });
  } finally { source.close(); await iterator.return(undefined); }
});
