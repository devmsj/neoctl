import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { QueryEngine, type QueryEngineOptions } from "../../src/core/query-engine.js";
import { query } from "../../src/core/query.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { SessionStore } from "../../src/session/session-store.js";
import { buildResponsesInput } from "../../src/model/openai-mappers.js";
import type { ModelRequest, ModelStreamEvent } from "../../src/model/model-gateway.js";
import { createTextMessage, type Message, type ToolUseRequest } from "../../src/types/messages.js";
import type { AgentEvent } from "../../src/types/events.js";

const contextManager: NonNullable<QueryEngineOptions["contextManager"]> = { async build() { return {
  systemPrompt: "Tool history regression fixture", promptSections: [],
  userContext: { currentDate: "2026-09-23" }, systemContext: { cwd: "fixture", platform: "win32" },
}; } };
const unchanged = { async compact(messages: readonly Message[]) { return { messages: [...messages], changed: false }; } };

async function drain(stream: AsyncIterable<AgentEvent>): Promise<Message[]> {
  const messages: Message[] = [];
  for await (const event of stream) if (event.type === "message") messages.push(event.message);
  return messages;
}

function assertToolHistory(messages: readonly Message[], calls: readonly ToolUseRequest[], label: string): void {
  const blocks = messages.flatMap(message => message.blocks);
  assert.deepEqual(blocks.filter(block => block.type === "tool_use").map(block => block.id), calls.map(call => call.id), `${label}: one call record per ID`);
  const results = blocks.filter(block => block.type === "tool_result").map(block => block.toolUseId).sort();
  assert.deepEqual(results, calls.map(call => call.id).sort(), `${label}: one result per ID`);
  const wire = buildResponsesInput(messages) as Array<{ type?: string; call_id?: string }>;
  assert.deepEqual(wire.filter(item => item.type === "function_call").map(item => item.call_id), calls.map(call => call.id), `${label}: no duplicate calls on the wire`);
}

for (const concurrent of [false, true]) {
  for (const count of [1, 2]) {
    test(`QueryEngine records tools once across history, compaction and resume (concurrent=${concurrent}, count=${count})`, async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "neo-tool-history-"));
      try {
        const calls = Array.from({ length: count }, (_, index) => ({ id: `call-${index}`, name: "probe", input: {} }));
        const tools = new ToolRegistry();
        let executions = 0;
        tools.register({ name: "probe", description: "In-memory counter only", inputSchema: { type: "object" },
          metadata: { concurrent, readOnly: true, visible: true },
          async execute() { executions += 1; return { ok: true, output: "ok" }; },
        });
        const requests: ModelRequest[] = [];
        const exported: ToolUseRequest[][] = [];
        const compactInputs: Message[][] = [];
        const options: QueryEngineOptions = {
          agentId: "test", cwd: root, tools, contextManager, maxTurns: 3,
          session: { rootDir: root, sessionId: "tool-history", resume: true },
          compactor: {
            ...unchanged,
            async manualCompact(messages) { compactInputs.push(structuredClone([...messages])); return { messages: [...messages], changed: false }; },
          },
          exportToolCalls: batch => { exported.push(structuredClone(batch)); },
          modelGateway: { async *stream(request): AsyncIterable<ModelStreamEvent> {
            requests.push(request);
            if (requests.length === 1) {
              for (const toolUse of calls) yield { type: "tool_use", toolUse };
            } else yield { type: "assistant_message", message: createTextMessage("assistant", "done") };
          } },
        };
        // Avoid asynchronous title generation: this fixture exercises only the query loop.
        const store = await SessionStore.open({ agentId: "test", rootDir: root, sessionId: "tool-history" });
        store.recordTitle("Tool history fixture", "initial");
        store.recordTitle("Tool history fixture", "refinement");
        const engine = new QueryEngine(options);
        const emitted = await drain(engine.sendUserText("Run independent mock probes"));
        assert.equal(executions, count, "each mock tool executes once");
        assert.deepEqual(exported, [calls], "export callback fires once per batch");
        assertToolHistory(emitted, calls, "emitted messages");
        assertToolHistory(requests[1].messages, calls, "next model turn");
        assertToolHistory(engine.getHistoryMessages(), calls, "engine history");

        await engine.compact();
        assert.equal(compactInputs.length, 1);
        assertToolHistory(compactInputs[0], calls, "manual compaction input");
        const entries = (await readFile(path.join(root, "tool-history", "transcript.jsonl"), "utf8"))
          .trim().split("\n").map(line => JSON.parse(line));
        assertToolHistory(entries.filter(entry => entry.type === "message").map(entry => entry.message), calls, "transcript");
        const resumed = new QueryEngine(options);
        await resumed.initialize();
        assertToolHistory(resumed.getHistoryMessages(), calls, "restored history");
        await drain(resumed.sendUserText("Continue without running more tools"));
        assertToolHistory(requests[2].messages, calls, "resumed model input");
        assert.equal(executions, count, "restoring history must not execute old calls");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
}

test("direct query owns synthetic tool messages even without QueryEngine", async () => {
  const tools = new ToolRegistry();
  const call = { id: "direct-call", name: "probe", input: {} };
  tools.register({ name: "probe", description: "mock", inputSchema: { type: "object" },
    metadata: { concurrent: false, readOnly: true, visible: true },
    async execute() { return { ok: true, output: "ok" }; },
  });
  const messages = await drain(query([createTextMessage("user", "probe")], {
    tools, contextManager, compactor: unchanged,
    modelGateway: { async *stream() { yield { type: "tool_use", toolUse: call }; } },
  }, { agentId: "test", maxTurns: 1 }));
  assertToolHistory(messages, [call], "direct query");
});

test("provider assistant tool blocks are persisted once and exported without synthesizing another message", async () => {
  const call = { id: "native-call", name: "probe", input: {} };
  const tools = new ToolRegistry();
  let executions = 0;
  tools.register({ name: "probe", description: "mock", inputSchema: { type: "object" },
    metadata: { concurrent: true, readOnly: true, visible: true },
    async execute() { executions += 1; return { ok: true, output: "ok" }; },
  });
  const exported: ToolUseRequest[][] = [];
  const engine = new QueryEngine({ tools, contextManager, compactor: unchanged, maxTurns: 1, session: { enabled: false },
    exportToolCalls: calls => { exported.push(calls); },
    modelGateway: { async *stream() {
      yield { type: "assistant_message", message: {
        ...createTextMessage("assistant", ""), blocks: [{ type: "tool_use", ...call }],
      } };
    } },
  });
  const emitted = await drain(engine.sendUserText("probe"));
  assert.equal(executions, 1);
  assertToolHistory(emitted, [call], "provider message");
  assertToolHistory(engine.getHistoryMessages(), [call], "provider history");
  assert.deepEqual(exported, [[call]]);
  assert.equal(engine.getHistoryMessages().some(message => message.metadata?.syntheticToolUse), false);
});
