import { ModelAPIError } from "../model/errors.js";
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runAgent, type RunAgentOptions } from "./run-agent.js";
import { SessionStore } from "../session/session-store.js";
import { FileToolResultMemory, type ToolResultMemory } from "../session/tool-result-memory.js";
import { ToolRegistry } from "../tools/registry.js";
import type { ToolUseContext } from "../tools/tool.js";
import type { ModelGateway, ModelRequest, ModelStreamEvent } from "../model/model-gateway.js";
import type { Compactor, ContextBudgetOptions } from "../context/compaction.js";
import { createTextMessage, type Message } from "../types/messages.js";
import { hasValidToolResultPairing } from "./message-pipeline.js";

const serialized = (messages: readonly Message[]) => JSON.stringify(messages);
async function drain(options: RunAgentOptions) {
  const iterator = runAgent(options);
  while (true) {
    const next = await iterator.next();
    if (next.done) return next.value;
    if (next.value.type === "error") throw next.value.error;
  }
}
class Gateway implements ModelGateway {
  requests: ModelRequest[] = [];
  constructor(private rejectFirst = false) {}
  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(structuredClone({ ...request, cancellation: undefined }));
    if (this.rejectFirst && this.requests.length === 1) throw new ModelAPIError({ category: "context_length", provider: "fake", message: "maximum context length exceeded" });
    yield { type: "assistant_message", message: createTextMessage("assistant", "finished") };
    yield { type: "response_completed", stopReason: "end_turn" };
  }
}
function base(root: string, gateway: ModelGateway): RunAgentOptions {
  return {
    agentId: "child-test", agent: { agentType: "test", whenToUse: "test", tools: [] },
    prompt: "ORIGINAL_DIRECTIVE", model: "gpt-5.4", reasoning: { effort: "high" },
    serviceTier: "priority", contextWindowTokensOverride: 123456, maxOutputTokensOverride: 2048,
    workspaceCwd: root, maxTurns: 2,
    parentContext: { session: { sessionId: "parent-test", sessionDir: root } } as ToolUseContext,
    dependencies: {
      modelGateway: gateway, tools: new ToolRegistry(),
      contextManager: { async build() { return { systemPrompt: "test", promptSections: [], userContext: { currentDate: "2026-01-01" }, systemContext: { cwd: root, platform: process.platform } }; } },
      compactor: { async compact(messages) { return { messages: [...messages], changed: false }; } },
    },
  };
}
async function reopen(root: string) {
  return SessionStore.open({ rootDir: path.join(root, "subagents"), agentId: "child-test", sessionId: "child-test", resume: true });
}
for (const source of ["parent", "dependency", "mock"] as const) {
  test(`child memory inherits effective ${source} threshold without sharing parent storage`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "neo-child-threshold-"));
    try {
      const options = base(root, new Gateway());
      const parent = await SessionStore.open({ rootDir: root, agentId: "parent", sessionId: "parent", toolResultThresholdChars: 128 });
      options.parentContext!.toolResultMemory = parent.toolResultMemory;
      const dependency = new FileToolResultMemory({ sessionDir: path.join(root, "dependency"), thresholdChars: 256 });
      const mock: ToolResultMemory = {
        state: { seenIds: new Set(), replacements: new Map() },
        async processToolResult(_id, output) { return { output }; },
        async applyBudget(messages) { return { messages: [...messages], records: [] }; },
      };
      if (source === "dependency") options.dependencies.toolResultMemory = dependency;
      if (source === "mock") options.dependencies.toolResultMemory = mock;
      const expectedThreshold = source === "parent" ? 128 : source === "dependency" ? 256 : 48000;
      let observed = 0;
      options.dependencies.contextManager = { async build(input) {
        const memory = input.toolUseContext!.toolResultMemory!;
        assert.notEqual(memory, parent.toolResultMemory);
        assert.notEqual(memory, dependency);
        assert.notEqual(memory, mock);
        assert.equal(memory.thresholdChars, expectedThreshold);
        const result = await memory.processToolResult(`threshold-${observed++}`, "x".repeat(300));
        assert.equal(Boolean(result.record), source !== "mock");
        return { systemPrompt: "test", promptSections: [], userContext: { currentDate: "2026-01-01" }, systemContext: { cwd: root, platform: process.platform } };
      } };
      await drain(options);
      assert.ok(observed > 0);
      const childFiles = await fs.readdir(path.join(root, "subagents", "child-test", "tool-results")).catch(() => []);
      assert.equal(childFiles.length > 0, source !== "mock");
      await assert.rejects(fs.stat(path.join(parent.sessionDir, "tool-results")));
      await assert.rejects(fs.stat(path.join(root, "dependency", "tool-results")));
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
}

for (const reactive of [false, true]) {
  test(`${reactive ? "reactive" : "proactive"} checkpoint survives fresh runAgent and overrides stale task messages`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "neo-child-compact-"));
    try {
      const gateway = new Gateway(reactive);
      const options = base(root, gateway);
      const stale = createTextMessage("user", "OLD_LARGE_PAYLOAD_" + "x".repeat(60000));
      options.existingMessages = [stale];
      let current: Message[] = [];
      options.onContextMessagesChanged = (messages) => { current = messages; };
      let compressed = false;
      const budgets: ContextBudgetOptions[] = [];
      const compress = (budget?: ContextBudgetOptions) => {
        budgets.push(budget ?? {}); compressed = true;
        return { messages: [createTextMessage("user", "CHECKPOINT_ONLY")], changed: true, reason: reactive ? "reactive_compact" as const : "autocompact" as const };
      };
      const compactor: Compactor = {
        async compact(messages, budget) { return !reactive && !compressed ? compress(budget) : { messages: [...messages], changed: false }; },
        async reactiveCompact(_messages, _error, budget) { return compress(budget); },
      };
      options.dependencies.compactor = compactor;
      await drain(options);
      assert.equal(compressed, true);
      assert.equal(budgets[0].contextWindowTokens, 123456);
      assert.match(serialized(current), /CHECKPOINT_ONLY/);
      assert.doesNotMatch(serialized(current), /OLD_LARGE_PAYLOAD/);
      const session = await reopen(root);
      assert.equal(session.sessionDir, path.join(root, "subagents", "child-test"));
      assert.doesNotMatch(serialized(session.getInitialMessages()), /OLD_LARGE_PAYLOAD/);
      const output = await session.toolResultMemory.processToolResult("large-tool", "z".repeat(60000));
      assert.ok(output.record);
      session.recordContentReplacements([output.record!]);
      assert.equal((await fs.readdir(path.join(session.sessionDir, "tool-results"))).length, 1);
      const memoryRestored = await reopen(root);
      assert.equal((await memoryRestored.toolResultMemory.processToolResult("large-tool", "different")).output, output.output);
      const restartGateway = new Gateway();
      const resumed = base(root, restartGateway);
      resumed.existingMessages = [stale]; // Deliberately stale task-store copy.
      resumed.resumeDirective = "NEW_DIRECTIVE";
      await drain(resumed);
      const request = restartGateway.requests[0];
      assert.match(serialized(request.messages), /CHECKPOINT_ONLY/);
      assert.doesNotMatch(serialized(request.messages), /OLD_LARGE_PAYLOAD|ORIGINAL_DIRECTIVE/);
      assert.equal(serialized(request.messages).split("NEW_DIRECTIVE").length - 1, 1);
      for (const call of [...gateway.requests, ...restartGateway.requests]) {
        assert.equal(call.model, options.model);
        assert.deepEqual(call.reasoning, options.reasoning);
        assert.equal(call.serviceTier, options.serviceTier);
        assert.equal(call.maxOutputTokens, 2048);
        assert.equal(call.queryOrigin, "subagent");
      }
      const thirdGateway = new Gateway();
      await drain(base(root, thirdGateway));
      assert.equal(serialized(thirdGateway.requests[0].messages).split("NEW_DIRECTIVE").length - 1, 1);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
}

test("initial directive is persisted once; interrupted tool calls get durable failure pairing, not replay", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "neo-child-pair-"));
  try {
    await drain(base(root, new Gateway()));
    const session = await reopen(root);
    const toolUse = { ...createTextMessage("assistant", ""), blocks: [{ type: "tool_use" as const, id: "interrupted-side-effect", name: "file_write", input: { path: "must-not-exist" } }] };
    session.recordMessage(toolUse);
    const gateway = new Gateway();
    await drain(base(root, gateway));
    const messages = gateway.requests[0].messages;
    assert.equal(serialized(messages).split("ORIGINAL_DIRECTIVE").length - 1, 1);
    assert.equal(hasValidToolResultPairing(messages), true);
    const result = messages.flatMap((message) => message.blocks).find((block) => block.type === "tool_result" && block.toolUseId === "interrupted-side-effect");
    assert.ok(result && result.type === "tool_result" && result.ok === false);
    assert.match(JSON.stringify(result), /synthetic failure/);
    const stored = (await reopen(root)).getInitialMessages();
    assert.equal(hasValidToolResultPairing(stored), true);
    assert.equal(stored.filter((message) => message.metadata?.syntheticToolResult).length, 1);
    await assert.rejects(fs.stat(path.join(root, "must-not-exist")));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("empty durable checkpoint does not fall back to stale existingMessages", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "neo-child-empty-"));
  try {
    const session = await reopen(root);
    session.recordCompactCheckpoint([], "autocompact");
    const gateway = new Gateway();
    const options = base(root, gateway);
    options.existingMessages = [createTextMessage("user", "STALE_EMPTY_CHECKPOINT")];
    options.resumeDirective = "CONTINUE_EMPTY";
    await drain(options);
    assert.doesNotMatch(serialized(gateway.requests[0].messages), /STALE_EMPTY_CHECKPOINT|ORIGINAL_DIRECTIVE/);
    assert.match(serialized(gateway.requests[0].messages), /CONTINUE_EMPTY/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("report retry uses compacted current context instead of original initial messages", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "neo-child-report-"));
  try {
    const gateway = new Gateway();
    const options = base(root, gateway);
    options.agent = { ...options.agent, requiresReport: true, reportRetryTurns: 1 };
    options.prompt = "OLD_REPORT_PAYLOAD";
    let compacted = false;
    options.dependencies.compactor = { async compact(messages) {
      if (compacted) return { messages: [...messages], changed: false };
      compacted = true;
      return { messages: [createTextMessage("user", "REPORT_CHECKPOINT")], changed: true, reason: "autocompact" };
    } };
    await drain(options);
    assert.ok(gateway.requests.length >= 2);
    for (const request of gateway.requests) assert.doesNotMatch(serialized(request.messages), /OLD_REPORT_PAYLOAD/);
    assert.match(serialized(gateway.requests[1].messages), /REPORT_CHECKPOINT|REQUIRED FINALIZATION/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
