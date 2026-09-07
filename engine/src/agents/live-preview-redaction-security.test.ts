import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLocalAgentTask, updateProgressFromEvent, updateProgressFromMessage, type LocalAgentTask } from "./local-agent-task.js";
import { createTextMessage } from "../types/messages.js";
import { InMemorySecretRedactionRegistry } from "../secrets/secret-redaction.js";
import type { SecretRedactionRegistry } from "../secrets/secret-types.js";
import { TaskStore } from "../tasks/task-store.js";

const SECRET = "SYNTHETIC_CREDENTIAL_0123456789";
const MARKER = "[secret:fixture]";
function registry() {
  const value = new InMemorySecretRedactionRegistry();
  value.record("fixture", SECRET);
  return value;
}
function task(id = "preview-security") {
  const value = createLocalAgentTask({ taskId: id, agentId: id, description: "synthetic fixture", prompt: "fixture only" });
  value.status = "running";
  return value;
}
const update = updateProgressFromEvent;
function delta(value: LocalAgentTask, text: string, redactions?: SecretRedactionRegistry, generation = value.runGeneration) {
  update(value, { type: "assistant.delta", displayChannel: "visible", text }, generation, redactions);
}

test("SEC preview redacts synthetic secret before the 4000-character tail cut", () => {
  const value = task(); const redactions = registry();
  delta(value, SECRET + "x".repeat(3990), redactions);
  assert.equal(value.progress.visibleText?.text, (MARKER + "x".repeat(3990)).slice(-4000));
  assert.equal(value.progress.visibleText?.truncated, true);
  assert.ok(!redactions.redact(value.progress.visibleText?.text ?? "").startsWith("0123456789"));
});

test("SEC each character delta withholds every incomplete secret prefix, including legacy preview", () => {
  const value = task(); const redactions = registry();
  for (let index = 0; index < SECRET.length; index++) {
    delta(value, SECRET[index], redactions);
    const expected = index === SECRET.length - 1 ? MARKER : "";
    assert.equal(value.progress.visibleText?.text ?? "", expected, `visible at character ${index}`);
    assert.equal(value.progress.lastText ?? "", expected, `legacy at character ${index}`);
  }
});

test("SEC live task JSON never persists unpublished carry or raw preview", () => {
  const root = mkdtempSync(join(tmpdir(), "neo-preview-security-"));
  const store = new TaskStore();
  try {
    store.bindSession(root);
    const value = task(); const redactions = registry(); store.upsert(value);
    delta(value, SECRET.slice(0, -1), redactions); store.upsert(value);
    const file = join(root, "subagents", value.agentId, "task.json");
    assert.ok(!readFileSync(file, "utf8").includes(SECRET.slice(0, -1)));
    assert.ok(!JSON.stringify(value).includes(SECRET.slice(0, -1)));
    delta(value, SECRET.slice(-1), redactions); store.upsert(value);
    assert.ok(!readFileSync(file, "utf8").includes(SECRET));
    assert.equal(JSON.parse(readFileSync(file, "utf8")).progress.visibleText.text, MARKER);
  } finally { store.flush(); rmSync(root, { recursive: true, force: true }); }
});

test("SEC streaming registry refreshes newly registered secrets and never flushes an unresolved prefix", () => {
  const redactions = new InMemorySecretRedactionRegistry();
  const stream = redactions.createStreamingRedactor({ incompleteSecret: "redact" });
  assert.equal(stream.push("plain "), "plain ");
  redactions.record("fixture", SECRET);
  assert.equal(stream.push(SECRET.slice(0, -1)), "");
  assert.equal(stream.flush(), "[secret:incomplete]");
});

test("SEC default terminal flush preserves ordinary tails, whitespace and legacy partial-prefix semantics", () => {
  for (const text of ["ordinary tail", "  \n\t", "", "0", "prefix SYN", SECRET, `a ${SECRET} z  \n`]) {
    const redactions = registry(); const stream = redactions.createStreamingRedactor();
    const output = [...text].map(char => stream.push(char)).join("") + stream.flush();
    assert.equal(output, redactions.redact(text));
    assert.equal(stream.flush(), "");
  }
});

test("SEC resumed generation discards carry, rejects stale deltas and persists safe archive", () => {
  const root = mkdtempSync(join(tmpdir(), "neo-preview-generations-"));
  const store = new TaskStore();
  try {
    store.bindSession(root); const value = task(); const redactions = registry(); store.upsert(value);
    const prefix = SECRET.slice(0, 20);
    delta(value, "public " + prefix, redactions);
    store.fail(value.id, "fixture stop", undefined, 1);
    store.prepareResume(value.id, new AbortController()); store.markRunning(value.id, 2);
    const before = JSON.stringify(value.progress);
    delta(value, SECRET.slice(20), redactions, 1);
    assert.equal(JSON.stringify(value.progress), before);
    delta(value, "new generation", redactions, 2);
    assert.equal(value.progress.visibleText?.text, "new generation");
    assert.equal(value.progress.lastText, "new generation");
    assert.equal(value.runHistory?.[0].progress.visibleText?.text, "public ");
    store.upsert(value);
    const raw = readFileSync(join(root, "subagents", value.agentId, "task.json"), "utf8");
    assert.ok(!raw.includes(prefix));
    const restored = new TaskStore(); restored.bindSession(root);
    assert.equal(restored.get(value.id)?.runHistory?.[0].progress.visibleText?.text, "public ");
  } finally { store.flush(); rmSync(root, { recursive: true, force: true }); }
});

test("SEC distinct task objects including reused ids do not share private carry", () => {
  const redactions = registry(); const first = task("same-id"); const second = task("same-id"); const third = task("different-id");
  delta(first, SECRET.slice(0, 20), redactions);
  delta(second, "plain second", redactions); delta(third, "plain third", redactions);
  assert.equal(first.progress.visibleText?.text, "");
  assert.equal(second.progress.visibleText?.text, "plain second");
  assert.equal(third.progress.visibleText?.text, "plain third");
  delta(first, SECRET.slice(20), redactions);
  assert.equal(first.progress.visibleText?.text, MARKER);
});

test("SEC terminal events and terminal task statuses never flush carry or accept trailing deltas", () => {
  for (const status of ["completed", "failed", "killed"] as const) {
    const value = task(); const redactions = registry();
    delta(value, "public " + SECRET.slice(0, 20), redactions);
    value.status = status;
    delta(value, SECRET.slice(20), redactions);
    assert.equal(value.progress.visibleText?.text, "public ");
    assert.equal(value.progress.lastText, "public ");
  }
  const value = task(); const redactions = registry();
  delta(value, SECRET.slice(0, 20), redactions);
  update(value, { type: "terminal", reason: "completed" }, 1, redactions);
  delta(value, SECRET.slice(20), redactions);
  assert.equal(value.progress.visibleText?.text, "");
  assert.equal(value.progress.lastText ?? "", "");
});

test("SEC unmarked/missing-generation deltas cannot contaminate visible carry", () => {
  const value = task(); const redactions = registry();
  delta(value, SECRET.slice(0, 20), redactions);
  update(value, { type: "assistant.delta", text: "hidden content" }, 1, redactions);
  update(value, { type: "assistant.delta", displayChannel: "visible", text: "unowned content" }, undefined, redactions);
  delta(value, SECRET.slice(20), redactions);
  assert.equal(value.progress.visibleText?.text, MARKER);
});

test("SEC no registry and empty registry retain 0, empty, whitespace and sticky 4000 boundary", () => {
  for (const redactions of [undefined, new InMemorySecretRedactionRegistry(), registry()]) {
    const value = task();
    delta(value, "", redactions);
    assert.deepEqual(value.progress.visibleText, { channel: "visible", runGeneration: 1, text: "", truncated: false, redactionVersion: 1 });
    delta(value, "0", redactions); delta(value, " \n\t", redactions);
    assert.equal(value.progress.visibleText?.text, "0 \n\t");
    delta(value, "x".repeat(3996), redactions);
    assert.equal(value.progress.visibleText?.text.length, 4000);
    assert.equal(value.progress.visibleText?.truncated, false);
    delta(value, "", redactions); assert.equal(value.progress.visibleText?.truncated, false);
    delta(value, " ", redactions); assert.equal(value.progress.visibleText?.truncated, true);
    delta(value, "", redactions); assert.equal(value.progress.visibleText?.truncated, true);
    assert.equal(value.progress.visibleText?.text.length, 4000);
  }
});

test("SEC clipping counts published redacted characters, not withheld/raw bytes", () => {
  const value = task(); const redactions = registry();
  delta(value, "x".repeat(4000 - MARKER.length), redactions);
  delta(value, SECRET.slice(0, -1), redactions);
  assert.equal(value.progress.visibleText?.truncated, false);
  delta(value, SECRET.slice(-1), redactions);
  assert.equal(value.progress.visibleText?.text.length, 4000);
  assert.equal(value.progress.visibleText?.truncated, false);
  delta(value, "x", redactions);
  assert.equal(value.progress.visibleText?.truncated, true);
});

test("SEC registry changes are live and omitted arguments never downgrade protection", () => {
  const value = task(); const redactions = new InMemorySecretRedactionRegistry();
  delta(value, "public ", redactions);
  redactions.record("fixture", SECRET);
  for (const char of SECRET) delta(value, char, redactions);
  assert.equal(value.progress.visibleText?.text, "public " + MARKER);
  for (const char of SECRET) delta(value, char);
  assert.equal(value.progress.visibleText?.text, "public " + MARKER + MARKER);
});

test("SEC registry refresh handles longer new secret matching already-private carry", () => {
  const redactions = new InMemorySecretRedactionRegistry();
  redactions.record("short", "ABC");
  const stream = redactions.createStreamingRedactor({ incompleteSecret: "redact" });
  assert.equal(stream.push("AB"), "");
  redactions.record("long", "ABCDE");
  assert.equal(stream.push("C"), "");
  assert.equal(stream.push("DE"), "[secret:long]");
  assert.equal(stream.flush(), "");
});

test("SEC every split and character of overlapping/Bearer/trimmed credentials is protected", () => {
  const redactions = registry(); redactions.record("long", SECRET + "_LONG");
  redactions.record("padded", " PADDED_SYNTHETIC ");
  for (const secret of [SECRET, SECRET + "_LONG", "Bearer " + SECRET, " PADDED_SYNTHETIC ", "PADDED_SYNTHETIC"]) {
    for (let split = 1; split < secret.length; split++) {
      const stream = redactions.createStreamingRedactor({ incompleteSecret: "redact" });
      assert.equal(stream.push(secret.slice(0, split)), "", `split ${split}`);
      const result = stream.push(secret.slice(split) + "!") + stream.flush();
      assert.ok(result.includes("[secret:")); assert.ok(!result.includes(secret));
      assert.ok(result.endsWith("!"));
    }
  }
});

test("SEC whole-value-only registries fail closed for live previews", () => {
  const base = registry(); const redactions: SecretRedactionRegistry = { record: base.record.bind(base), redact: base.redact.bind(base) };
  const value = task(); delta(value, SECRET + " normal", redactions);
  assert.equal(value.progress.visibleText?.text, "");
  assert.equal(value.progress.lastText ?? "", "");
});

test("SEC restored unproven tails are discarded instead of being used as safe stream seeds", () => {
  const value = task(); const redactions = registry();
  value.progress.visibleText = { channel: "visible", runGeneration: 1, text: "0123456789" + "x".repeat(3990), truncated: true };
  value.progress.lastText = "0123456789";
  delta(value, "safe new event", redactions);
  assert.equal(value.progress.visibleText?.text, "safe new event");
  assert.equal(value.progress.lastText, "safe new event");
  assert.equal(value.progress.visibleText?.truncated, false);
});

test("SEC restored terminal and archived legacy previews are rejected without any new event", () => {
  const root = mkdtempSync(join(tmpdir(), "neo-preview-legacy-"));
  const store = new TaskStore();
  try {
    store.bindSession(root); const value = task(); store.upsert(value);
    const file = join(root, "subagents", value.agentId, "task.json");
    const raw = JSON.parse(readFileSync(file, "utf8"));
    raw.status = "completed"; raw.runGeneration = 2;
    const legacy = { channel: "visible", runGeneration: 2, text: "0123456789" + "x".repeat(3990), truncated: true };
    raw.progress.visibleText = legacy;
    raw.runHistory = [{ runGeneration: 1, status: "failed", archivedAt: new Date().toISOString(),
      progress: { totalEvents: 1, totalToolUseCount: 0, visibleText: { ...legacy, runGeneration: 1 } } }];
    writeFileSync(file, JSON.stringify(raw));
    const restored = new TaskStore();
    assert.deepEqual(restored.bindSession(root).errors, []);
    const recovered = restored.get(value.id)!;
    assert.equal(recovered.progress.visibleText, undefined);
    assert.equal(recovered.runHistory?.[0].progress.visibleText, undefined);
    assert.ok(!readFileSync(file, "utf8").includes("0123456789"));
    // Serialization also rejects an unmarked in-memory legacy preview, not just load.
    recovered.progress.visibleText = legacy as NonNullable<LocalAgentTask["progress"]["visibleText"]>;
    restored.upsert(recovered);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).progress.visibleText, undefined);
  } finally { store.flush(); rmSync(root, { recursive: true, force: true }); }
});

test("SEC final messages cannot overwrite the protected legacy preview with credential fragments", () => {
  const value = task(); const redactions = registry();
  delta(value, "public", redactions);
  updateProgressFromMessage(value, createTextMessage("assistant", SECRET + "x".repeat(990)));
  assert.equal(value.progress.lastText, (MARKER + "x".repeat(990)).slice(-1000));
  updateProgressFromMessage(value, createTextMessage("assistant", SECRET.slice(0, -1)));
  assert.equal(value.progress.lastText, "");
  assert.equal(value.progress.visibleText?.text, "public");
});
