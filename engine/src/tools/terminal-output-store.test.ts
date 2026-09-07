import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { TerminalOutputStore, redactedTerminalChunk as chunk, TERMINAL_OUTPUT_MAX_BYTES, TERMINAL_OUTPUT_RETENTION_MS,
  type StoreResult, type TerminalExitFacts, type RedactedTerminalChunk } from "./terminal-output-store.js";

function ok<T>(result: StoreResult<T>): T { if (!result.ok) assert.fail(JSON.stringify(result)); return result.value; }
function no<T>(result: StoreResult<T>, reason?: string): void { assert.equal(result.ok, false); if (!result.ok && reason) assert.equal(result.reason, reason); }
function fixture(t: TestContext, budget?: number) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "terminal-store-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const id of ["A", "B"]) fs.mkdirSync(path.join(root, id));
  let now = 1000;
  const make = () => new TerminalOutputStore({ sessionsRoot: root, now: () => now, maxBytesPerRun: budget });
  const store = make();
  const dir = (owner = "A", run = "r") => path.join(root, owner, "terminal-output", `r-${createHash("sha256").update(run).digest("hex")}`);
  const start = (owner = "A", run = "r") => ok(store.start(owner, path.join(root, owner), run, { startedAt: 1000, processId: 0, tty: false }));
  const exit = (overrides: Partial<TerminalExitFacts> = {}): TerminalExitFacts => ({ finishedAt: 2000, exitCode: 0, signal: null, terminationReason: "completed", durationMs: 1000, ...overrides });
  return { root, store, make, dir, start, exit, time: (n: number) => { now = n; } };
}

test("separate streams preserve newlines/blank lines/indentation; reads never drain", (t) => {
  const f = fixture(t); f.start();
  const text = "head\n\n  缩进😀\r\nlast\n";
  ok(f.store.append("A", "r", chunk("stdout", 0, text)));
  ok(f.store.append("A", "r", chunk("stderr", 0, "error\n  detail\n")));
  assert.equal(ok(f.store.read("A", "r", { stream: "stdout" })).text, text);
  assert.equal(ok(f.store.read("A", "r", { stream: "stdout" })).text, text);
  assert.equal(ok(f.store.read("A", "r", { stream: "stderr" })).text, "error\n  detail\n");
  let output = "", offset = 0;
  for (;;) {
    const page = ok(f.store.read("A", "r", { stream: "stdout", offset, limitBytes: 4 }));
    output += page.text; offset = page.nextOffset;
    if (page.endOfStoredOutput) break;
    assert.ok(page.nextOffset > page.offset);
  }
  assert.equal(output, text); assert.equal(offset, Buffer.byteLength(text));
  assert.equal("output" in ok(f.store.finalize("A", "r", f.exit())).record, false);
  const snapshot = JSON.stringify(ok(f.store.listHistory("A")));
  assert.ok(!snapshot.includes("缩进") && !snapshot.includes("error\\n"));
});

test("same run ID isolated by owner; foreign owner/directory, traversal and Windows aliases rejected", (t) => {
  const f = fixture(t); f.start(); f.start("B");
  ok(f.store.append("A", "r", chunk("stdout", 0, "A-only")));
  ok(f.store.append("B", "r", chunk("stdout", 0, "B-only")));
  assert.equal(ok(f.store.read("B", "r", { stream: "stdout" })).text, "B-only");
  no(f.store.read("C", "r", { stream: "stdout" }), "not-found");
  no(f.store.start("A", path.join(f.root, "B"), "other", { startedAt: 0 }), "invalid-input");
  for (const id of ["..", "../A", "a/b", "a\\b", "C:foo", "CON", "nul.txt", "name.", "name ", ""]) {
    no(f.store.start(id, path.join(f.root, id), "r", { startedAt: 0 }));
    no(f.store.start("A", path.join(f.root, "A"), id, { startedAt: 0 }));
  }
  if (process.platform === "win32") no(f.store.restoreSession("a", path.join(f.root, "a")), "conflict");
  no(f.store.start("A", path.join(f.root, "A"), "r", { startedAt: 1000 }), "conflict");
});

test("redaction attestation, exact per-stream offsets, retry idempotence and gap/overlap rejection", (t) => {
  const f = fixture(t); f.start();
  no(f.store.append("A", "r", { stream: "stdout", offset: 0, text: "raw" } as RedactedTerminalChunk), "invalid-input");
  // @ts-expect-error A raw string is not an approved stream increment.
  no(f.store.append("A", "r", "raw"));
  ok(f.store.append("A", "r", chunk("stdout", 0, "safe [REDACTED]\n")));
  assert.equal(ok(f.store.append("A", "r", chunk("stdout", 0, "safe [REDACTED]\n"))).duplicate, true);
  no(f.store.append("A", "r", chunk("stdout", 99, "gap")), "conflict");
  no(f.store.append("A", "r", chunk("stdout", 1, "x".repeat(99))), "conflict");
  no(f.store.append("A", "r", chunk("stdout", 16, "\ud800")), "invalid-input");
  assert.equal(ok(f.store.read("A", "r", { stream: "stdout" })).text, "safe [REDACTED]\n");
});

test("append writes only stream files; metadata stays unchanged until finalize", (t) => {
  const f = fixture(t); f.start();
  const file = path.join(f.dir(), "metadata.json");
  const before = fs.readFileSync(file, "utf8");
  for (let i = 0; i < 100; i++) ok(f.store.append("A", "r", chunk("stdout", i, "x")));
  assert.equal(fs.readFileSync(file, "utf8"), before);
  assert.equal(ok(f.store.read("A", "r", { stream: "stdout" })).persistence, "memory-only");
  assert.equal(ok(f.store.finalize("A", "r", f.exit())).persistence, "stored");
  const record = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(record.streams.stdout.storedBytes, 100);
  assert.ok(fs.readdirSync(f.dir()).every((name) => !name.endsWith(".tmp")));
});

test("combined byte cap, Unicode prefix, exact observed totals and explicit truncation", (t) => {
  const f = fixture(t, 8); f.start();
  ok(f.store.append("A", "r", chunk("stdout", 0, "中")));
  ok(f.store.append("A", "r", chunk("stderr", 0, "err")));
  const capped = ok(f.store.append("A", "r", chunk("stdout", 3, "😀tail"))).record;
  assert.equal(capped.truncated, true);
  assert.deepEqual(capped.streams, { stdout: { observedBytes: 11, storedBytes: 3 }, stderr: { observedBytes: 3, storedBytes: 3 } });
  ok(f.store.append("A", "r", chunk("stderr", 3, "more")));
  assert.equal(ok(f.store.read("A", "r", { stream: "stdout" })).text, "中");
  assert.equal(fs.statSync(path.join(f.dir(), "stdout.txt")).size + fs.statSync(path.join(f.dir(), "stderr.txt")).size, 6);
  assert.equal(TERMINAL_OUTPUT_MAX_BYTES, 64 * 1024 * 1024);
  assert.throws(() => new TerminalOutputStore({ sessionsRoot: f.root, maxBytesPerRun: TERMINAL_OUTPUT_MAX_BYTES + 1 }));
});

test("zero budget and empty result are distinct from unavailable", (t) => {
  const f = fixture(t, 0); f.start();
  let page = ok(f.store.read("A", "r", { stream: "stdout" }));
  assert.equal(page.text, ""); assert.equal(page.record.truncated, false);
  ok(f.store.append("A", "r", chunk("stdout", 0, "x")));
  page = ok(f.store.read("A", "r", { stream: "stdout" }));
  assert.equal(page.text, ""); assert.equal(page.record.truncated, true);
  assert.equal(page.record.availability, "available");
});

test("terminal facts preserve 0/nonzero/null/signal/reason without guessed status or duration", (t) => {
  const f = fixture(t);
  const cases = [f.exit(), f.exit({ exitCode: 7, terminationReason: "failed" }),
    f.exit({ exitCode: null, signal: "SIGTERM", terminationReason: "user_terminate", durationMs: null }),
    f.exit({ exitCode: null, signal: 0, terminationReason: null, durationMs: 0 })];
  cases.forEach((facts, i) => {
    f.start("A", String(i));
    assert.deepEqual(ok(f.store.finalize("A", String(i), facts)).record.exit, facts);
    assert.deepEqual(ok(f.store.finalize("A", String(i), facts)).record.exit, facts);
    no(f.store.finalize("A", String(i), { ...facts, exitCode: 42 }), "conflict");
    no(f.store.append("A", String(i), chunk("stdout", 0, "late")), "conflict");
  });
  f.start("A", "running");
  const history = ok(f.store.listHistory("A", { limit: 2 }));
  assert.equal(history.records.length, 2); assert.equal(history.nextOffset, 2);
  assert.equal(ok(f.store.listHistory("A", { offset: 2 })).records.length, 2);
});

test("readable until terminal +5min, exact boundary denies without timer and facts survive", (t) => {
  const f = fixture(t); f.start();
  ok(f.store.append("A", "r", chunk("stdout", 0, "retain")));
  f.time(1000 + 10 * TERMINAL_OUTPUT_RETENTION_MS);
  assert.equal(ok(f.store.read("A", "r", { stream: "stdout" })).text, "retain"); // running has no TTL
  f.time(2000); ok(f.store.finalize("A", "r", f.exit()));
  f.time(2000 + TERMINAL_OUTPUT_RETENTION_MS - 1);
  assert.equal(ok(f.store.read("A", "r", { stream: "stdout" })).text, "retain");
  f.time(2000 + TERMINAL_OUTPUT_RETENTION_MS);
  const page = ok(f.store.read("A", "r", { stream: "stdout" }));
  assert.equal(page.text, null); assert.equal(page.record.availability, "expired");
  assert.equal(fs.existsSync(path.join(f.dir(), "stdout.txt")), false);
  assert.deepEqual(ok(f.store.listHistory("A")).records[0]!.record.exit, f.exit());
  f.time(1000); // expiry is sticky even if wall clock moves backwards
  assert.equal(ok(f.store.read("A", "r", { stream: "stdout" })).text, null);
});

test("fresh instance restores terminal before TTL and rejects/cleans expired output on startup", (t) => {
  const f = fixture(t); f.start(); ok(f.store.append("A", "r", chunk("stdout", 0, "persisted")));
  ok(f.store.finalize("A", "r", f.exit()));
  const second = f.make();
  assert.equal(ok(second.restoreSession("A", path.join(f.root, "A"))).rejected, 0);
  assert.equal(ok(second.read("A", "r", { stream: "stdout" })).text, "persisted");
  f.time(302000);
  const third = f.make();
  const restored = ok(third.restoreSession("A", path.join(f.root, "A")));
  assert.equal(restored.records[0]!.record.availability, "expired");
  assert.equal(ok(third.read("A", "r", { stream: "stdout" })).text, null);
  assert.equal(fs.existsSync(path.join(f.dir(), "stdout.txt")), false);
  assert.deepEqual(restored.records[0]!.record.exit, f.exit());
});

test("restart running becomes lost, never fabricated exit/finishedAt/completion, no renewed output TTL", (t) => {
  const f = fixture(t); f.start(); ok(f.store.append("A", "r", chunk("stdout", 0, "uncheckpointed")));
  f.time(9000);
  const next = f.make();
  const record = ok(next.restoreSession("A", path.join(f.root, "A"))).records[0]!.record;
  assert.equal(record.lifecycle, "lost"); assert.equal(record.exit, null); assert.equal(record.expiresAt, null); assert.equal(record.lostAt, 9000);
  assert.equal(record.availability, "lost"); assert.equal(ok(next.read("A", "r", { stream: "stdout" })).text, null);
  no(next.finalize("A", "r", f.exit()), "conflict");
  assert.equal(fs.existsSync(path.join(f.dir(), "stdout.txt")), false);
  const again = f.make(); f.time(20000);
  assert.equal(ok(again.restoreSession("A", path.join(f.root, "A"))).records[0]!.record.lostAt, 9000);
});

test("explicit evict only; no per-owner/global slot policy in store; facts retained after restart", (t) => {
  const f = fixture(t, 4);
  for (let i = 0; i < 65; i++) { f.start("A", String(i)); ok(f.store.finalize("A", String(i), f.exit())); }
  assert.equal(ok(f.store.listHistory("A", { limit: 100 })).records.length, 65);
  assert.equal(ok(f.store.read("A", "0", { stream: "stdout" })).record.availability, "available");
  ok(f.store.evict("A", "0"));
  const next = f.make(); ok(next.restoreSession("A", path.join(f.root, "A")));
  assert.equal(ok(next.read("A", "0", { stream: "stdout" })).record.availability, "evicted");
  assert.equal(ok(next.listHistory("A", { limit: 100 })).records.length, 65);
});

test("read pagination validates finite byte bounds and Unicode cursor, response mutations isolated", (t) => {
  const f = fixture(t); f.start(); ok(f.store.append("A", "r", chunk("stdout", 0, "中hello")));
  for (const offset of [-1, NaN, Infinity, 1, 2, 99]) no(f.store.read("A", "r", { stream: "stdout", offset }), "invalid-input");
  for (const limitBytes of [0, 1, 3, Infinity, 262145]) no(f.store.read("A", "r", { stream: "stdout", limitBytes }), "invalid-input");
  const page = ok(f.store.read("A", "r", { stream: "stdout" })); page.record.streams.stdout.storedBytes = 999;
  assert.equal(ok(f.store.read("A", "r", { stream: "stdout" })).record.streams.stdout.storedBytes, 8);
});

test("write failure revokes availability but real exit is still recordable; never throws process failure", (t) => {
  const f = fixture(t); f.start();
  fs.unlinkSync(path.join(f.dir(), "stdout.txt")); fs.mkdirSync(path.join(f.dir(), "stdout.txt"));
  const result = ok(f.store.append("A", "r", chunk("stdout", 0, "cannot write")));
  assert.equal(result.record.availability, "io-error");
  assert.equal(ok(f.store.read("A", "r", { stream: "stdout" })).text, null);
  assert.deepEqual(ok(f.store.finalize("A", "r", f.exit({ exitCode: 9 }))).record.exit, f.exit({ exitCode: 9 }));
});

test("metadata atomic replace failure retains previous JSON and explicit memory-only exit facts", (t) => {
  const f = fixture(t); f.start();
  const target = path.join(f.dir(), "metadata.json");
  const old = fs.readFileSync(target, "utf8");
  const backup = path.join(f.dir(), "old.json"); fs.renameSync(target, backup); fs.mkdirSync(target);
  const result = ok(f.store.finalize("A", "r", f.exit()));
  assert.equal(result.persistence, "memory-only"); assert.equal(result.record.availability, "io-error");
  assert.deepEqual(result.record.exit, f.exit()); assert.equal(fs.readFileSync(backup, "utf8"), old);
  assert.equal(JSON.parse(old).lifecycle, "running");
});

test("root/session/storage/run junctions rejected; outside sentinel unchanged by read/append/cleanup", (t) => {
  const f = fixture(t); const outside = path.join(f.root, "outside"); fs.mkdirSync(outside);
  const sentinel = path.join(outside, "stdout.txt"); fs.writeFileSync(sentinel, "DO NOT TOUCH");
  const alias = path.join(f.root, "root-alias"); fs.symlinkSync(outside, alias, "junction");
  const unsafe = new TerminalOutputStore({ sessionsRoot: alias });
  no(unsafe.restoreSession("A", path.join(alias, "A")), "unsafe-path");
  fs.symlinkSync(outside, path.join(f.root, "C"), "junction");
  no(f.store.start("C", path.join(f.root, "C"), "r", { startedAt: 0 }), "unsafe-path");
  fs.symlinkSync(outside, path.join(f.root, "B", "terminal-output"), "junction");
  no(f.store.start("B", path.join(f.root, "B"), "r", { startedAt: 0 }), "unsafe-path");
  f.start(); fs.renameSync(f.dir(), f.dir() + "-saved"); fs.symlinkSync(outside, f.dir(), "junction");
  assert.equal(ok(f.store.read("A", "r", { stream: "stdout" })).record.availability, "io-error");
  ok(f.store.evict("A", "r")); ok(f.store.sweep());
  assert.equal(fs.readFileSync(sentinel, "utf8"), "DO NOT TOUCH");
});

test("hardlinked output and metadata refused without modifying link target", (t) => {
  const f = fixture(t); f.start();
  const external = path.join(f.root, "external.txt"); fs.writeFileSync(external, "secret");
  const stdout = path.join(f.dir(), "stdout.txt"); fs.unlinkSync(stdout); fs.linkSync(external, stdout);
  assert.equal(ok(f.store.append("A", "r", chunk("stdout", 0, "overwrite"))).record.availability, "io-error");
  ok(f.store.evict("A", "r")); assert.equal(fs.readFileSync(external, "utf8"), "secret"); assert.equal(fs.statSync(external).nlink, 2);
  f.start("A", "meta");
  const meta = path.join(f.dir("A", "meta"), "metadata.json"); fs.linkSync(meta, path.join(f.root, "metadata-link"));
  const before = fs.readFileSync(meta, "utf8");
  assert.equal(ok(f.store.finalize("A", "meta", f.exit())).persistence, "memory-only");
  assert.equal(fs.readFileSync(meta, "utf8"), before);
  const next = f.make(); assert.equal(ok(next.restoreSession("A", path.join(f.root, "A"))).rejected, 1);
});

test("file symlinks refused (skip only if OS lacks symlink privilege)", (t) => {
  const f = fixture(t); f.start();
  const external = path.join(f.root, "external.txt"); fs.writeFileSync(external, "secret");
  const file = path.join(f.dir(), "stdout.txt"); fs.unlinkSync(file);
  try { fs.symlinkSync(external, file, "file"); }
  catch (error) { if (["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) { t.skip("Windows file symlink privilege unavailable; junction and hardlink tests run separately"); return; } throw error; }
  assert.equal(ok(f.store.read("A", "r", { stream: "stdout" })).text, null);
  ok(f.store.evict("A", "r")); assert.equal(fs.readFileSync(external, "utf8"), "secret");
});

test("recovery rejects corrupt/oversized/wrong-owner metadata; cleanup never scans arbitrary paths", (t) => {
  const f = fixture(t);
  for (const run of ["corrupt", "oversized", "foreign", "valid"]) { f.start("A", run); ok(f.store.finalize("A", run, f.exit())); }
  fs.writeFileSync(path.join(f.dir("A", "corrupt"), "metadata.json"), "{");
  fs.writeFileSync(path.join(f.dir("A", "oversized"), "metadata.json"), " ".repeat(17000));
  const foreign = path.join(f.dir("A", "foreign"), "metadata.json");
  const raw = JSON.parse(fs.readFileSync(foreign, "utf8")); raw.ownerSessionId = "B"; fs.writeFileSync(foreign, JSON.stringify(raw));
  const sentinel = path.join(f.root, "A", "terminal-output", "not-a-run"); fs.writeFileSync(sentinel, "keep");
  const unknown = path.join(f.dir("A", "valid"), "unknown.txt"); fs.writeFileSync(unknown, "keep too");
  const b = path.join(f.root, "B", "terminal-output"); fs.mkdirSync(b); fs.writeFileSync(path.join(b, "keep"), "unregistered");
  f.time(302000); const next = f.make(); const result = ok(next.restoreSession("A", path.join(f.root, "A")));
  assert.equal(result.rejected, 3); assert.equal(result.records.length, 1); ok(next.sweep());
  assert.equal(fs.readFileSync(sentinel, "utf8"), "keep"); assert.equal(fs.readFileSync(unknown, "utf8"), "keep too");
  assert.equal(fs.readFileSync(path.join(b, "keep"), "utf8"), "unregistered");
  no(next.start("A", path.join(f.root, "A"), "corrupt", { startedAt: 0 }), "conflict");
});

test("single metadata DTO retains redacted identity/command/source status through restart", (t) => {
  const f = fixture(t);
  const metadata = { startedAt: 1000, sessionId: "terminal_17", status: "running", command: "echo [REDACTED]", cwd: "C:/work", shell: "powershell", description: "safe purpose", tty: false };
  ok(f.store.start("A", path.join(f.root, "A"), "r", metadata));
  const facts = f.exit({ status: "exited", exitCode: 7, terminationReason: "failed" });
  ok(f.store.finalize("A", "r", facts));
  const next = f.make(); const record = ok(next.restoreSession("A", path.join(f.root, "A"))).records[0]!.record;
  assert.deepEqual(record.metadata, metadata); assert.deepEqual(record.exit, facts);
  no(f.store.start("A", path.join(f.root, "A"), "huge", { startedAt: 0, command: "x".repeat(4097) }), "invalid-input");
});

test("trusted resolver permits nested child sessions, rejects reassignment and intermediate junction", (t) => {
  const f = fixture(t);
  const child = path.join(f.root, "A", "subagents", "agent", "child"); fs.mkdirSync(child, { recursive: true });
  let resolved = child;
  const store = new TerminalOutputStore({ sessionsRoot: f.root, resolveOwnerSessionDir: (id) => id === "child-owner" ? resolved : undefined });
  ok(store.start("child-owner", child, "r", { startedAt: 0 }));
  no(store.restoreSession("other", child), "invalid-input");
  resolved = path.join(f.root, "B"); no(store.restoreSession("child-owner", resolved), "conflict");
  resolved = child;
  const parent = path.join(f.root, "A", "subagents"); fs.renameSync(parent, parent + "-saved");
  fs.symlinkSync(parent + "-saved", parent, "junction");
  no(store.read("child-owner", "r", { stream: "stdout" }), "unsafe-path");
});
