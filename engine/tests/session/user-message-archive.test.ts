import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DeterministicCompactor } from "../../src/context/compaction.js";
import { estimateTextTokens } from "../../src/core/context-metrics.js";
import { createTextMessage, type Message } from "../../src/types/messages.js";
import { readFileTool } from "../../src/tools/builtins/filesystem-tools.js";
import type { ToolUseContext } from "../../src/tools/tool.js";

const text = (m: Message) => m.blocks.flatMap(b => b.type === "text" ? [b.text] : []).join("\n");

test("single-message and total caps preserve more instructions, with durable original text and stable re-compaction", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "neo-user-archive-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const users = Array.from({ length: 14 }, (_, i) => ({ ...createTextMessage("user", `REQUEST_${i} ` + "完整内容 alpha beta ".repeat(4000) + ` END_${i}`), id: `user/${i}` }));
  const transcript = path.join(dir, "transcript.jsonl");
  const original = users.map(message => JSON.stringify({ type: "message", sessionId: "s", agentId: "main", message })).join("\n") + "\n";
  await fs.writeFile(transcript, original);
  const context = { agentId: "main", session: { sessionDir: dir, sessionId: "s" }, emit() {} } as unknown as ToolUseContext;
  const compactor = new DeterministicCompactor();
  let result = await compactor.manualCompact(users, { userMessageArchive: true });
  const kept = result.messages.filter(m => m.metadata?.compactPreservedUser);
  assert.ok(kept.length >= 9, "one long request must not consume the entire 20K window");
  assert.ok(kept.length < users.length);
  assert.ok(kept.every(m => estimateTextTokens(text(m)) <= 2000));
  assert.ok(kept.reduce((sum, m) => sum + estimateTextTokens(text(m)), 0) <= 20000);
  assert.match(text(result.messages.at(-1)!), /neo:\/\/session\/user-messages/);
  assert.match(text(kept.at(-1)!), /neo:\/\/session\/user-message\/user%2F13/);
  const blocksBefore = JSON.stringify(result.messages.slice(0, -1));
  for (let n = 0; n < 3; n++) result = await compactor.manualCompact(JSON.parse(JSON.stringify(result.messages)));
  assert.equal(JSON.stringify(result.messages.slice(0, -1)), blocksBefore);
  assert.ok(JSON.stringify(result.messages).length < original.length / 3);
  const call = async (uri: string, offset = 1, limit = 120) => readFileTool.call!({ path: uri, offset, limit }, context, { onProgress() {} });
  const index = await call("neo://session/user-messages");
  assert.equal(index.ok, true);
  const backend = process.env.NEO_EXECUTION_BACKEND;
  try {
    process.env.NEO_EXECUTION_BACKEND = "docker";
    const isolated = await call("neo://session/user-messages");
    assert.deepEqual(isolated, index, "archive reads are runtime-scoped, not container filesystem paths");
  } finally {
    if (backend === undefined) delete process.env.NEO_EXECUTION_BACKEND;
    else process.env.NEO_EXECUTION_BACKEND = backend;
  }
  assert.match(JSON.stringify(index.output), /user%2F0/);
  for (const i of [0, 13]) {
    let restored = "";
    for (let offset = 1;; offset += 120) {
      const part = await call(`neo://session/user-message/user%2F${i}`, offset);
      const output = part.output as { content: string; hasMoreAfter: boolean };
      assert.equal(part.ok, true);
      restored += output.content.split("\n").map(line => line.replace(/^\d+ \| /, "")).join("");
      if (!output.hasMoreAfter) break;
    }
    assert.equal(restored, text(users[i]!));
  }
  assert.equal(await fs.readFile(transcript, "utf8"), original, "reads/compaction do not duplicate or rewrite the transcript");
  assert.deepEqual(await fs.readdir(dir), ["transcript.jsonl"]);
});

test("archive scopes reads to session/agent/reset and skips compact copies and injected users", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "neo-user-reset-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const message = (id: string, extra = {}) => ({ type: "message", sessionId: "s", agentId: "main", message: { ...createTextMessage("user", id), id }, ...extra });
  const kept = message("kept");
  await fs.writeFile(path.join(dir, "transcript.jsonl"), [
    message("before-reset"), { type: "reset", sessionId: "s", agentId: "main" },
    message("other-session", { sessionId: "other" }), message("other-agent", { agentId: "other" }),
    message("injected", { message: { ...createTextMessage("user", "injected"), isMeta: true } }),
    message("copy", { message: { ...createTextMessage("user", "copy"), metadata: { compactPreservedUser: true } } }),
    kept, kept, { type: "compact", sessionId: "s", agentId: "main", replacementMessages: [createTextMessage("user", "fake")] },
  ].map(e => JSON.stringify(e)).join("\n") + "\n");
  const context = { agentId: "main", session: { sessionDir: dir, sessionId: "s" } } as unknown as ToolUseContext;
  const call = (uri: string, ctx = context) => readFileTool.call!({ path: uri, offset: 1, limit: 120 }, ctx, { onProgress() {} });
  const index = await call("neo://session/user-messages");
  assert.equal((index.output as { totalLines: number }).totalLines, 1);
  assert.match(JSON.stringify(index.output), /kept/);
  assert.equal((await call("neo://session/user-message/before-reset")).ok, false);
  assert.equal((await call("neo://session/user-message/..%2Fprivate")).ok, false);
  assert.equal((await call("neo://session/user-messages", { agentId: "main" } as unknown as ToolUseContext)).ok, false);
});
