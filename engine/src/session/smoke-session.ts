import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FileToolResultMemory, PERSISTED_OUTPUT_TAG } from "./tool-result-memory.js";
import { SessionStore } from "./session-store.js";
import { writeSessionMarkdownExport } from "./session-export.js";
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
  store.recordTitle("Smoke Session Title", "initial");
  store.recordTitle("Refined Smoke Session Title", "refinement");
  store.recordMessage({ ...messages[0], role: "progress" });

  const resumed = await SessionStore.open({ agentId: "main", rootDir: root, sessionId, resume: true });
  const latest = await SessionStore.open({ agentId: "main", rootDir: root, resume: true });
  const listed = await SessionStore.list({ agentId: "main", rootDir: root });
  const resumedBudget = await resumed.toolResultMemory.applyBudget(resumed.getInitialMessages(), { maxSerializedLength: 180 });
  const exportPath = path.join(root, "exports", "session.md");
  const exportResult = await writeSessionMarkdownExport({
    outputPath: exportPath,
    session: resumed.snapshot(),
    agentId: "main",
    promptSnapshot: {
      model: "smoke-model",
      systemPrompt: "system prompt smoke",
      userContextPrompt: "User context:\ncurrentDate: 2026-05-09",
      toolDefinitions: [{ name: "alpha", description: "Alpha tool", inputSchema: { type: "object" } }],
      commands: ["/export <absolute-md-path>"],
    },
    maxToolResultLines: 3,
  });
  const exportedMarkdown = await fs.readFile(exportPath, "utf8");
  const afterReset = await SessionStore.open({ agentId: "main", rootDir: root, sessionId, resume: true });
  afterReset.reset();
  const resetResume = await SessionStore.open({ agentId: "main", rootDir: root, sessionId, resume: true });
  const deleted = await SessionStore.delete({ rootDir: root, sessionId });
  const listedAfterDelete = await SessionStore.list({ agentId: "main", rootDir: root });

  const ok =
    first.records.length === 1 &&
    persistedBlocks.length === 1 &&
    second.records.length === 0 &&
    JSON.stringify(first.messages) === JSON.stringify(second.messages) &&
    resumed.snapshot().resumedMessages === messages.length &&
    resumed.snapshot().title === "Refined Smoke Session Title" &&
    resumed.snapshot().titleKind === "refinement" &&
    resumed.snapshot().hasInitialTitle &&
    resumed.snapshot().hasTitleRefinement &&
    latest.snapshot().sessionId === sessionId &&
    latest.snapshot().resumedMessages === messages.length &&
    latest.snapshot().title === "Refined Smoke Session Title" &&
    latest.snapshot().titleKind === "refinement" &&
    listed.length === 1 &&
    listed[0]?.sessionId === sessionId &&
    listed[0]?.title === "Refined Smoke Session Title" &&
    resumedBudget.records.length === 0 &&
    resumedBudget.messages.some((message) =>
      message.blocks.some((block) => block.type === "tool_result" && String(block.output).startsWith(PERSISTED_OUTPUT_TAG)),
    ) &&
    exportResult.bytes > 0 &&
    exportedMarkdown.includes("# Neo Session Export") &&
    exportedMarkdown.includes("system prompt smoke") &&
    exportedMarkdown.includes("## Transcript") &&
    exportedMarkdown.includes("Tool use ID: call_a") &&
    resetResume.snapshot().resumedMessages === 0 &&
    deleted &&
    listedAfterDelete.length === 0;

  console.log(JSON.stringify({ ok, firstRecords: first.records.length, persistedBlocks: persistedBlocks.length, exportResult, resumed: resumed.snapshot(), latest: latest.snapshot(), listed, reset: resetResume.snapshot(), deleted, listedAfterDelete }, null, 2));
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
      blocks: [{ type: "tool_result", toolUseId: "call_b", name: "beta", ok: true, output: "b".repeat(220) }],
    },
  ];
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
