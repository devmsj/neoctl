import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FileToolResultMemory, PERSISTED_OUTPUT_TAG } from "./tool-result-memory.js";
import { SessionStore } from "./session-store.js";
import { writeSessionMarkdownExport } from "./session-export.js";
import { createTextMessage, createThinkingMessage, type Message } from "../types/messages.js";

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
  store.recordMessage(createThinkingMessage("persisted visible reasoning"));
  store.recordMessage(createTextMessage("assistant", "assistant before compact"));
  store.recordContentReplacements(first.records);
  store.recordTitle("Smoke Session Title", "initial");
  store.recordTitle("Refined Smoke Session Title", "refinement");
  store.recordFastMode(true);
  store.recordContextWindowTokens(256000);
  store.recordMessage({ ...messages[0], role: "progress" });
  const compactionBoundary = {
    ...createTextMessage("system", "<compact_state>persisted compact state</compact_state>"),
    isMeta: true,
    metadata: { compactBoundary: true, compactionReason: "manualcompact", modelDriven: true },
  };
  const preservedUser = { ...createTextMessage("user", "preserved user request"), metadata: { compactPreservedUser: true } };
  store.recordCompactCheckpoint([preservedUser, compactionBoundary], "manualcompact", {
    reason: "manualcompact",
    summary: "persisted compact summary",
    continuationState: "persisted compact state",
    sourceMessages: messages.length + 2,
    preservedUserMessages: 1,
    newWindowMessages: 2,
    charsFreed: 1234,
    modelDriven: true,
    imageCount: 0,
  });
  store.recordMessage(createTextMessage("assistant", "assistant between compacts"));
  const secondCompactionBoundary = {
    ...createTextMessage("system", "<compact_state>second compact state</compact_state>"),
    isMeta: true,
    metadata: { compactBoundary: true, compactionReason: "manualcompact", modelDriven: true },
  };
  store.recordCompactCheckpoint([preservedUser, secondCompactionBoundary], "manualcompact", {
    reason: "manualcompact",
    summary: "second compact summary",
    continuationState: "second compact state",
    sourceMessages: 3,
    preservedUserMessages: 1,
    newWindowMessages: 2,
    charsFreed: 2345,
    modelDriven: true,
    imageCount: 0,
  });
  store.recordMessage(createTextMessage("assistant", "assistant after second compact"));

  const resumed = await SessionStore.open({ agentId: "main", rootDir: root, sessionId, resume: true });
  const latest = await SessionStore.open({ agentId: "main", rootDir: root, resume: true });
  const listed = await SessionStore.list({ agentId: "main", rootDir: root });
  const resumedBudget = await resumed.toolResultMemory.applyBudget(resumed.getInitialMessages(), { maxSerializedLength: 180 });
  const displayEntries = resumed.getDisplayEntries();
  const displayMessages = displayEntries.filter((entry) => entry.type === "message").map((entry) => entry.message);
  const displayCompactions = displayEntries.filter((entry) => entry.type === "compact");
  const displayCompactionIndexes = displayEntries.flatMap((entry, index) => entry.type === "compact" ? [index] : []);
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

  const truncatedTailSessionId = "truncated-tail-session";
  const truncatedTailStore = await SessionStore.open({ agentId: "main", rootDir: root, sessionId: truncatedTailSessionId });
  truncatedTailStore.recordMessage(createTextMessage("user", "durable before partial tail"));
  await fs.appendFile(truncatedTailStore.transcriptPath, '{"type":"message","sessionId":"truncated-tail-session"', "utf8");
  const recoveredTailStore = await SessionStore.open({ agentId: "main", rootDir: root, sessionId: truncatedTailSessionId, resume: true });
  const recoveredTailMessagesBeforeAppend = recoveredTailStore.getInitialMessages();
  const repairedTailText = await fs.readFile(truncatedTailStore.transcriptPath, "utf8");
  recoveredTailStore.recordMessage(createTextMessage("assistant", "durable after partial tail"));
  const recoveredTailAgain = await SessionStore.open({ agentId: "main", rootDir: root, sessionId: truncatedTailSessionId, resume: true });

  const unterminatedValidSessionId = "unterminated-valid-session";
  const unterminatedValidStore = await SessionStore.open({ agentId: "main", rootDir: root, sessionId: unterminatedValidSessionId });
  unterminatedValidStore.recordMessage(createTextMessage("user", "valid record without final newline"));
  const validTranscript = await fs.readFile(unterminatedValidStore.transcriptPath, "utf8");
  await fs.writeFile(unterminatedValidStore.transcriptPath, validTranscript.replace(/\n$/u, ""), "utf8");
  const recoveredValidTail = await SessionStore.open({ agentId: "main", rootDir: root, sessionId: unterminatedValidSessionId, resume: true });
  const repairedValidText = await fs.readFile(unterminatedValidStore.transcriptPath, "utf8");

  const corruptMiddleSessionId = "corrupt-middle-session";
  const corruptMiddleStore = await SessionStore.open({ agentId: "main", rootDir: root, sessionId: corruptMiddleSessionId });
  corruptMiddleStore.recordMessage(createTextMessage("user", "before corrupt middle"));
  corruptMiddleStore.recordMessage(createTextMessage("assistant", "after corrupt middle"));
  const corruptLines = (await fs.readFile(corruptMiddleStore.transcriptPath, "utf8")).trimEnd().split("\n");
  await fs.writeFile(corruptMiddleStore.transcriptPath, `${corruptLines[0]}\n{malformed}\n${corruptLines[1]}\n`, "utf8");
  const corruptMiddleRejected = await SessionStore.open({ agentId: "main", rootDir: root, sessionId: corruptMiddleSessionId, resume: true })
    .then(() => false)
    .catch((error: unknown) => error instanceof Error && error.message.includes("Malformed session transcript"));
  const durabilitySessionsDeleted = await Promise.all([
    truncatedTailSessionId,
    unterminatedValidSessionId,
    corruptMiddleSessionId,
  ].map((durabilitySessionId) => SessionStore.delete({ rootDir: root, sessionId: durabilitySessionId })));

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
    resumed.snapshot().resumedMessages === 3 &&
    resumed.getInitialMessages()[0]?.metadata?.compactPreservedUser === true &&
    resumed.getInitialMessages()[1]?.metadata?.compactBoundary === true &&
    resumed.getInitialMessages().at(-1)?.blocks.some((block) => block.type === "text" && block.text === "assistant after second compact") === true &&
    displayMessages.length === messages.length + 4 &&
    displayMessages.some((message) => message.role === "assistant" && message.blocks.some((block) => block.type === "text" && block.text === "assistant before compact")) &&
    displayMessages.some((message) => message.role === "assistant" && message.blocks.some((block) => block.type === "text" && block.text === "assistant between compacts")) &&
    displayMessages.some((message) => message.role === "assistant" && message.blocks.some((block) => block.type === "text" && block.text === "assistant after second compact")) &&
    displayCompactions.length === 2 &&
    displayCompactions[0]?.report?.summary === "persisted compact summary" &&
    displayCompactions[1]?.report?.summary === "second compact summary" &&
    displayEntries.findIndex((entry) => entry.type === "compact") > displayEntries.findIndex((entry) => entry.type === "message" && entry.message.blocks.some((block) => block.type === "text" && block.text === "assistant before compact")) &&
    displayEntries.findIndex((entry) => entry.type === "message" && entry.message.blocks.some((block) => block.type === "text" && block.text === "assistant between compacts")) > displayEntries.findIndex((entry) => entry.type === "compact") &&
    displayCompactionIndexes.at(-1)! < displayEntries.findIndex((entry) => entry.type === "message" && entry.message.blocks.some((block) => block.type === "text" && block.text === "assistant after second compact")) &&
    resumed.snapshot().lastCompaction?.summary === "second compact summary" &&
    resumed.snapshot().lastCompaction?.continuationState === "second compact state" &&
    resumed.snapshot().title === "Refined Smoke Session Title" &&
    resumed.snapshot().titleKind === "refinement" &&
    resumed.snapshot().hasInitialTitle &&
    resumed.snapshot().hasTitleRefinement &&
    resumed.snapshot().fastMode === true &&
    resumed.snapshot().contextWindowTokens === 256000 &&
    resumed.getContextWindowTokens() === 256000 &&
    latest.snapshot().sessionId === sessionId &&
    latest.snapshot().resumedMessages === 3 &&
    latest.snapshot().lastCompaction?.charsFreed === 2345 &&
    latest.snapshot().title === "Refined Smoke Session Title" &&
    latest.snapshot().titleKind === "refinement" &&
    listed.length === 1 &&
    listed[0]?.sessionId === sessionId &&
    listed[0]?.title === "Refined Smoke Session Title" &&
    resumedBudget.records.length === 0 &&
    resumedBudget.messages.every((message) => message.role !== "tool_result") &&
    exportResult.bytes > 0 &&
    exportedMarkdown.includes("# Neo Session Export") &&
    exportedMarkdown.includes("system prompt smoke") &&
    exportedMarkdown.includes("## Transcript") &&
    exportedMarkdown.includes("Tool use ID: call_a") &&
    exportedMarkdown.includes("persisted compact state") &&
    recoveredTailMessagesBeforeAppend.length === 1 &&
    recoveredTailMessagesBeforeAppend[0]?.blocks.some((block) => block.type === "text" && block.text === "durable before partial tail") === true &&
    repairedTailText.endsWith("\n") &&
    repairedTailText.trimEnd().split("\n").length === 1 &&
    recoveredTailAgain.getInitialMessages().length === 2 &&
    recoveredTailAgain.getInitialMessages()[1]?.blocks.some((block) => block.type === "text" && block.text === "durable after partial tail") === true &&
    recoveredValidTail.getInitialMessages().length === 1 &&
    repairedValidText.endsWith("\n") &&
    corruptMiddleRejected &&
    durabilitySessionsDeleted.every(Boolean) &&
    resetResume.snapshot().resumedMessages === 0 &&
    resetResume.snapshot().lastCompaction === undefined &&
    resetResume.snapshot().fastMode === true &&
    resetResume.snapshot().contextWindowTokens === 256000 &&
    deleted &&
    listedAfterDelete.length === 0;

  console.log(JSON.stringify({
    ok,
    firstRecords: first.records.length,
    persistedBlocks: persistedBlocks.length,
    exportResult,
    resumed: resumed.snapshot(),
    latest: latest.snapshot(),
    listed,
    durability: {
      recoveredTailMessagesBeforeAppend: recoveredTailMessagesBeforeAppend.length,
      repairedTailLines: repairedTailText.trimEnd().split("\n").length,
      recoveredTailAgainMessages: recoveredTailAgain.getInitialMessages().length,
      recoveredValidTailMessages: recoveredValidTail.getInitialMessages().length,
      repairedValidEndsWithNewline: repairedValidText.endsWith("\n"),
      corruptMiddleRejected,
      durabilitySessionsDeleted,
    },
    reset: resetResume.snapshot(),
    deleted,
    listedAfterDelete,
  }, null, 2));
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
