import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FileToolResultMemory, PERSISTED_OUTPUT_TAG } from "./tool-result-memory.js";
import { SessionStore } from "./session-store.js";
import type { Message } from "../types/messages.js";

async function main(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-session-smoke-"));
  const sessionId = "smoke-session";
  const messages = createToolMessages();

  const memory = new FileToolResultMemory({ sessionDir: path.join(root, sessionId), thresholdChars: 180, previewChars: 40 });
  const first = await memory.applyBudget(messages);
  const persistedBlocks = first.messages.flatMap((message) =>
    message.blocks.filter((block) => block.type === "tool_result" && String(block.output).startsWith(PERSISTED_OUTPUT_TAG)),
  );

  const second = await memory.applyBudget(messages);
  const store = await SessionStore.open({ agentId: "main", rootDir: root, sessionId });
  for (const message of messages) store.recordMessage(message);
  store.recordContentReplacements(first.records);
  store.recordMessage({ ...messages[0], role: "progress" });

  const resumed = await SessionStore.open({ agentId: "main", rootDir: root, sessionId, resume: true });
  const resumedBudget = await resumed.toolResultMemory.applyBudget(resumed.getInitialMessages(), { maxSerializedLength: 180 });
  const afterReset = await SessionStore.open({ agentId: "main", rootDir: root, sessionId, resume: true });
  afterReset.reset();
  const resetResume = await SessionStore.open({ agentId: "main", rootDir: root, sessionId, resume: true });

  const ok =
    first.records.length === 1 &&
    persistedBlocks.length === 1 &&
    second.records.length === 0 &&
    JSON.stringify(first.messages) === JSON.stringify(second.messages) &&
    resumed.snapshot().resumedMessages === messages.length &&
    resumedBudget.records.length === 0 &&
    resumedBudget.messages.some((message) =>
      message.blocks.some((block) => block.type === "tool_result" && String(block.output).startsWith(PERSISTED_OUTPUT_TAG)),
    ) &&
    resetResume.snapshot().resumedMessages === 0;

  console.log(JSON.stringify({ ok, firstRecords: first.records.length, persistedBlocks: persistedBlocks.length, resumed: resumed.snapshot(), reset: resetResume.snapshot() }, null, 2));
  if (!ok) process.exitCode = 1;
}

function createToolMessages(): Message[] {
  const createdAt = new Date().toISOString();
  return [
    {
      id: "assistant-tools",
      role: "assistant",
      createdAt,
      blocks: [
        { type: "tool_use", id: "call_a", name: "alpha", input: {} },
        { type: "tool_use", id: "call_b", name: "beta", input: {} },
      ],
    },
    {
      id: "result-a",
      role: "tool_result",
      createdAt,
      blocks: [{ type: "tool_result", toolUseId: "call_a", name: "alpha", ok: true, output: "a".repeat(120) }],
    },
    {
      id: "result-b",
      role: "tool_result",
      createdAt,
      blocks: [{ type: "tool_result", toolUseId: "call_b", name: "beta", ok: true, output: "b".repeat(120) }],
    },
  ];
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
