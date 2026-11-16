import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "../../src/session/session-store.js";
import { forgetTranscriptSummary, readTranscriptSummary } from "../../src/session/session-summary.js";
import { createTextMessage } from "../../src/types/messages.js";

async function fixture(run: (root: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "neo-list-sync-"));
  try { await run(root); } finally { await fs.rm(root, { recursive: true, force: true }); }
}
const fresh = async (file: string) => { forgetTranscriptSummary(file); return readTranscriptSummary(file, await fs.lstat(file), "main"); };

test("a late writer (e.g. title work of a switched-away engine) never resurrects a deleted session", () => fixture(async rootDir => {
  const stale = await SessionStore.open({ rootDir, agentId: "main", sessionId: "gone" });
  stale.recordMessage(createTextMessage("user", "hello"));
  assert.equal(await SessionStore.delete({ rootDir, sessionId: "gone" }), true);
  assert.throws(() => stale.recordTitle("late title"), /Session was deleted/);
  await assert.rejects(fs.stat(path.join(rootDir, "gone")), { code: "ENOENT" });
  assert.deepEqual((await SessionStore.list({ rootDir, agentId: "main" })).map(s => s.sessionId), []);
  // A brand-new session still creates its transcript on first write.
  const created = await SessionStore.open({ rootDir, agentId: "main", sessionId: "new" });
  created.recordTitle("ok");
  assert.equal((await SessionStore.list({ rootDir, agentId: "main" }))[0]?.title, "ok");
}));

test("incremental list summaries equal a full rescan across appends, partial tails, resets and replacement", () => fixture(async rootDir => {
  const store = await SessionStore.open({ rootDir, agentId: "main", sessionId: "s" });
  const other = await SessionStore.open({ rootDir, agentId: "other", sessionId: "s", resume: true });
  const file = store.transcriptPath;
  const incremental = async () => readTranscriptSummary(file, await fs.lstat(file), "main");
  store.recordTitle("first"); store.recordMessage(createTextMessage("user", "a"));
  assert.deepEqual(await incremental(), await fresh(file));
  other.recordMessage(createTextMessage("user", "other agent"));
  store.recordContentReplacements([{ kind: "tool-result", toolUseId: "t", replacement: "r" }]);
  assert.deepEqual(await incremental(), await fresh(file));
  // An unterminated complete record is counted, a partial one is ignored, and neither is consumed.
  await fs.appendFile(file, JSON.stringify({ type: "title", sessionId: "s", agentId: "main", title: "tail", createdAt: new Date().toISOString() }));
  assert.equal((await incremental()).title, "tail");
  assert.deepEqual(await incremental(), await fresh(file));
  await fs.appendFile(file, "\n{\"type\":\"message\",");
  assert.deepEqual(await incremental(), await fresh(file));
  await fs.appendFile(file, "\"sessionId\":\"s\",\"agentId\":\"main\",\"message\":{\"id\":\"m\",\"role\":\"user\",\"blocks\":[]}}\n");
  assert.deepEqual(await incremental(), await fresh(file));
  store.reset(); store.recordTitle("after reset");
  assert.deepEqual(await incremental(), await fresh(file));
  // A replaced transcript (new identity) is rescanned, never continued from the old prefix.
  const text = await fs.readFile(file, "utf8");
  await fs.writeFile(`${file}.new`, text.replace("after reset", "replaced!!!")); await fs.rename(`${file}.new`, file);
  assert.equal((await incremental()).title, "replaced!!!");
  await assert.rejects(readTranscriptSummary(path.join(rootDir, "missing", "transcript.jsonl"), await fs.lstat(file), "main"), { code: "ENOENT" });
}));
