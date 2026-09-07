import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizeResponsesObject, normalizeResponsesStream } from "../model/openai-responses-mapper.js";
import type { ModelGateway, ModelStreamEvent } from "../model/model-gateway.js";
import { runAgent, type RunAgentOptions } from "./run-agent.js";
import { SessionStore, type SessionTranscriptEntry } from "../session/session-store.js";
import { ToolRegistry } from "../tools/registry.js";
import type { ToolUseContext } from "../tools/tool.js";
import { createTextMessage, type Message } from "../types/messages.js";
import type { AgentEvent } from "../types/events.js";

async function streamEvents(events: Record<string, unknown>[]): Promise<ModelStreamEvent[]> {
  const stream = new ReadableStream<Uint8Array>({ start(controller) {
    for (const event of events) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
    controller.close();
  } });
  const result: ModelStreamEvent[] = [];
  for await (const event of normalizeResponsesStream(stream, { model: "test" })) result.push(event);
  return result;
}
function visibleText(messages: Message[]): string {
  return messages.flatMap((message) => message.role === "assistant" ? message.blocks : [])
    .filter((block) => block.type === "text" && block.displayChannel === "visible")
    .map((block) => block.type === "text" ? block.text : "").join("");
}
function finalMessages(events: ModelStreamEvent[]): Message[] {
  return events.flatMap((event) => event.type === "assistant_message" ? [event.message] : []);
}
const textDelta = (text: string, displayChannel?: "visible"): ModelStreamEvent => ({ type: "assistant_delta", text, ...(displayChannel ? { displayChannel } : {}) });
const gateway = (events: ModelStreamEvent[]): ModelGateway => ({ async *stream() { yield* structuredClone(events); } });
function options(root: string, events: ModelStreamEvent[]): RunAgentOptions {
  return { agentId: "child-visible", agent: { agentType: "test", whenToUse: "test", tools: [] }, prompt: "INITIAL", maxTurns: 1, workspaceCwd: root,
    parentContext: { session: { sessionId: "parent", sessionDir: root } } as ToolUseContext,
    dependencies: { modelGateway: gateway(events), tools: new ToolRegistry(),
      contextManager: { async build() { return { systemPrompt: "test", promptSections: [], userContext: { currentDate: "2026-09-07" }, systemContext: { cwd: root, platform: process.platform } }; } },
      compactor: { async compact(messages) { return { messages: [...messages], changed: false }; } },
    },
  };
}
async function drain(input: RunAgentOptions): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of runAgent(input)) {
    if (event.type === "error") throw event.error;
    events.push(event);
  }
  return events;
}

test("Responses output_text marks visible; item/event/part analysis, system, hidden and reasoning never do", async () => {
  const sources: Record<string, unknown>[] = [];
  const add = (index: number, text: string, item: Record<string, unknown> = {}, event: Record<string, unknown> = {}, part: Record<string, unknown> = {}) => {
    sources.push({ type: "response.output_item.added", output_index: index, item: { type: "message", id: `m${index}`, role: "assistant", ...item } });
    sources.push({ type: "response.content_part.added", item_id: `m${index}`, content_index: 0, part: { type: "output_text", ...part } });
    sources.push({ type: "response.output_text.delta", item_id: `m${index}`, delta: text, ...event });
  };
  add(0, "COMMENT", { channel: "commentary" });
  add(1, "ANALYSIS", { channel: "analysis" }, { channel: "answer" });
  add(2, "ANSWER", { phase: "final_answer" });
  add(3, "SYSTEM", { role: "system" });
  add(4, "HIDDEN", {}, { channel: "hidden" });
  add(5, "PART_ANALYSIS", {}, {}, { channel: "analysis" });
  add(6, "EVENT_ANALYSIS", { channel: "answer" }, { channel: "analysis" });
  add(7, "UNKNOWN", { channel: "unknown" });
  add(8, "REASONING_ITEM", { type: "reasoning" });
  sources.push({ type: "response.output_text.delta", delta: "CONTRACT" });
  sources.push({ type: "response.reasoning_summary_text.delta", delta: "PRIVATE_THINKING", channel: "answer" });
  sources.push({ type: "response.completed", response: { status: "completed" } });
  const result = await streamEvents(sources);
  const marked = result.filter((event) => event.type === "assistant_delta" && event.displayChannel === "visible");
  assert.equal(marked.map((event) => "text" in event ? event.text : "").join(""), "COMMENTANSWERCONTRACT");
  assert.equal(visibleText(finalMessages(result)), "COMMENTANSWERCONTRACT");
  assert(result.some((event) => event.type === "thinking_delta" && !("displayChannel" in event)));
  assert(finalMessages(result).some((message) => message.blocks.some((block) => block.type === "thinking" && !("displayChannel" in block))));
});

test("non-stream response separates visible output_text from analysis and legacy text", () => {
  const result = [...normalizeResponsesObject({ status: 200, headers: new Headers(), body: { status: "completed", output: [
    { type: "message", role: "assistant", channel: "answer", content: [{ type: "output_text", text: "PUBLIC" }, { type: "text", text: "LEGACY" }, { type: "output_text", channel: "analysis", text: "PRIVATE_PART" }] },
    { type: "message", role: "assistant", channel: "analysis", content: [{ type: "output_text", text: "PRIVATE_ITEM" }] },
    { type: "message", role: "system", content: [{ type: "output_text", text: "SYSTEM" }] },
    { type: "reasoning", summary: [{ text: "THINKING" }] },
  ] } })];
  assert.equal(visibleText(finalMessages(result)), "PUBLIC");
  assert.match(JSON.stringify(finalMessages(result)), /LEGACY/);
});

test("query filter preserves per-character provenance across hold-back, tail flush and final text", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "obs04-query-"));
  try {
    for (const [first, second, expected] of [
      [textDelta("W"), textDelta("x", "visible"), "x"],
      [textDelta("W", "visible"), textDelta("x"), "W"],
      [textDelta("W", "visible"), textDelta("", "visible"), "W"],
    ] as const) {
      const input = options(root, [first, second, { type: "response_completed" }]);
      input.parentContext = undefined;
      const events = await drain(input);
      assert.equal(events.filter((event) => event.type === "assistant.delta" && event.displayChannel === "visible").map((event) => "text" in event ? event.text : "").join(""), expected);
    }
    const mapped = await streamEvents([{ type: "response.output_text.delta", delta: "PUBLIC" }, { type: "response.completed", response: { status: "completed" } }]);
    const events = await drain(options(root, mapped));
    assert.equal(visibleText(events.flatMap((event) => event.type === "message" ? [event.message] : [])), "PUBLIC");
    assert.equal(events.filter((event) => event.type === "assistant.delta" && event.displayChannel === "visible").map((event) => "text" in event ? event.text : "").join(""), "PUBLIC");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("child transcript tags only new query messages with actual generation; restore/compact preserve visible blocks", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "obs04-transcript-"));
  try {
    const mapped = await streamEvents([{ type: "response.output_text.delta", delta: "ROUND_ONE" }, { type: "response.completed", response: { status: "completed" } }]);
    const input = options(root, mapped);
    const inherited = createTextMessage("assistant", "PARENT_CONTEXT");
    inherited.blocks = [{ type: "text", text: "PARENT_CONTEXT", displayChannel: "visible" }];
    input.fork = true;
    input.parentMessages = [inherited];
    input.runGeneration = 7;
    input.dependencies.modelGateway = gateway([...mapped, { type: "tool_use", toolUse: { id: "call-new", name: "missing-tool", input: {} } }]);
    input.takePendingMessages = (() => { let sent = false; return () => { if (sent) return []; sent = true; return [createTextMessage("user", "PENDING")]; }; })();
    await drain(input);
    const open = () => SessionStore.open({ rootDir: path.join(root, "subagents"), sessionId: input.agentId, agentId: input.agentId, resume: true });
    let child = await open();
    assert.match(visibleText(child.getInitialMessages()), /ROUND_ONE/);
    child.recordCompactCheckpoint(child.getInitialMessages(), "autocompact");
    child = await open();
    assert.match(visibleText(child.getInitialMessages()), /ROUND_ONE/);
    const next = options(root, [{ type: "assistant_message", message: createTextMessage("assistant", "ROUND_TWO_LEGACY") }, { type: "response_completed" }]);
    next.runGeneration = 11;
    next.resumeDirective = "RESUME";
    await drain(next);
    const legacy = options(root, [{ type: "assistant_message", message: createTextMessage("assistant", "NO_GENERATION") }]);
    await drain(legacy);
    const entries = (await readFile(child.transcriptPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as SessionTranscriptEntry);
    const rows = entries.filter((entry): entry is Extract<SessionTranscriptEntry, { type: "message" }> => entry.type === "message");
    const tagged = rows.filter((entry) => entry.runGeneration !== undefined);
    assert.deepEqual(tagged.map((entry) => entry.runGeneration), [7, 7, 7, 11]);
    assert(tagged.some((entry) => entry.message.role === "tool_result" && entry.runGeneration === 7));
    assert.equal(visibleText(tagged.filter((entry) => entry.runGeneration === 7).map((entry) => entry.message)), "ROUND_ONE");
    assert.equal(visibleText(tagged.filter((entry) => entry.runGeneration === 11).map((entry) => entry.message)), "");
    for (const entry of rows.filter((entry) => /PARENT_CONTEXT|INITIAL|PENDING|RESUME|NO_GENERATION/.test(JSON.stringify(entry.message)))) assert.equal(entry.runGeneration, undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});
