import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ExecProcessManager, type ExecProcessStartOptions, type StoreResult, type ExecProcessOutputDelta } from "./builtins/exec-process-manager.js";
import { TerminalOutputStore, TERMINAL_OUTPUT_RETENTION_MS } from "./terminal-output-store.js";
import { InMemorySecretRedactionRegistry } from "../secrets/secret-redaction.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "neo-terminal-chain-"));
const owner = "owner-a";
const dir = path.join(root, owner);
fs.mkdirSync(dir);
const managers: ExecProcessManager[] = [];
const checks: string[] = [];
function manager(options: ConstructorParameters<typeof ExecProcessManager>[0] = {}) {
  const m = new ExecProcessManager({ sessionsRoot: root, ...options });
  managers.push(m);
  return m;
}
function value<T>(result: StoreResult<T>): T {
  if (!result.ok) throw new Error(`Store failed: ${result.reason}`);
  return result.value;
}
function options(command: string, overrides: Partial<ExecProcessStartOptions> = {}): ExecProcessStartOptions {
  return { ownerId: owner, sessionDir: dir, command, cwd: process.cwd(),
    shell: { requested: "node", file: process.execPath, args: ["-e"] }, env: {},
    timeoutMs: 10_000, maxOutputChars: 1_000, tty: false, ...overrides };
}
function full(m: ExecProcessManager, id: string, stream: "stdout" | "stderr", ownerId = owner, limitBytes = 997) {
  let offset = 0;
  let text = "";
  for (let i = 0; i < 100000; i++) {
    const page = value(m.readOutput(ownerId, id, { stream, offset, limitBytes }));
    assert.equal(page.record.availability, "available");
    assert.notEqual(page.text, null);
    assert.equal(page.offset, offset);
    assert.equal(page.nextOffset - offset, Buffer.byteLength(page.text!));
    text += page.text;
    if (page.endOfStoredOutput) return text;
    assert.ok(page.nextOffset > offset);
    offset = page.nextOffset;
  }
  throw new Error("Pagination did not terminate");
}
function check(name: string) { checks.push(name); }
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function main() {
  const m = manager();
  const expected = "HEAD\n\n  中文😀\n" + "x中😀\n".repeat(30000) + "TAIL\n";
  const err = "ERR\n\n  缩进😀\n";
  const long = await m.execute(options(`process.stdout.write('HEAD\\n\\n  中文😀\\n' + 'x中😀\\n'.repeat(30000) + 'TAIL\\n'); process.stderr.write(${JSON.stringify(err)})`), 5000);
  assert.equal(long.exit_code, 0);
  assert.equal(long.output_kind, "incremental");
  assert.ok(long.output_ranges.stdout.truncated);
  assert.equal(long.output_ranges.stdout.start, 0);
  assert.equal(long.output_ranges.stdout.end, Buffer.byteLength(expected));
  assert.equal(full(m, long.session_id, "stdout"), expected);
  assert.equal(full(m, long.session_id, "stderr"), err);
  assert.equal(full(m, long.session_id, "stdout"), expected);
  assert.ok(!long.output_ref.truncated);
  const emptyDrain = await m.interact(long.session_id, { ownerId: owner, yieldTimeMs: 0 });
  assert.equal(emptyDrain.stdout, "");
  assert.equal(emptyDrain.output_ranges.stdout.start, long.output_ranges.stdout.end);
  assert.equal(emptyDrain.output_ranges.stdout.end, long.output_ranges.stdout.end);
  const live = m.list(owner).find((r) => r.session_id === long.session_id)!;
  assert.equal(live.output_kind, "snapshot");
  assert.equal(live.output_truncated, true);
  assert.ok(live.output.length < 1100);
  check("long split output, multiline/Unicode, bounded drain gaps, snapshot, repeat pagination without duplicate");

  const echo = await m.execute(options(`process.stdin.setEncoding('utf8'); process.stdin.on('data', s => { process.stdout.write(s); if(s.includes('DONE')) process.exit(0); });`), 0);
  for (let i = 0; i < 3; i++) {
    const registered = value(m.registerOwnerSession(owner, dir));
    const current = registered.records.find((r) => r.record.runId === echo.session_id)!;
    assert.equal(current.record.lifecycle, "running");
    assert.equal(current.record.exit, null);
    assert.equal(current.record.availability, "available");
  }
  assert.ok(!value(m.listHistory(owner)).records.some((r) => r.record.runId === echo.session_id));
  check("repeated same-instance owner registration leaves real running process running, not lost/history");
  let cursor = 0;
  let gathered = "";
  for (const input of ["A中😀\n", "B\n\n", "DONE\n"]) {
    const r = await m.interact(echo.session_id, { ownerId: owner, chars: input, yieldTimeMs: input.includes("DONE") ? 5000 : 250 });
    assert.equal(r.output_ranges.stdout.start, cursor);
    cursor = r.output_ranges.stdout.end;
    gathered += r.stdout;
  }
  assert.equal(gathered, "A中😀\nB\n\nDONE\n");
  assert.equal(full(m, echo.session_id, "stdout", owner, 4), gathered);
  check("continuous real-process drains and four-byte Unicode pagination share per-stream cursors");

  const registry = new InMemorySecretRedactionRegistry();
  registry.record("token", "super-secret-token");
  const emitted: ExecProcessOutputDelta[] = [];
  const secret = await m.execute(options(`process.stdout.write('out:super-'); process.stderr.write('err:super-'); setTimeout(()=>{process.stdout.write('secret-token😀\\r');process.stderr.write('secret-token\\n');setTimeout(()=>process.stdout.write('\\n  end\\n'),30)},30)`, {
    redactOutput: (s) => registry.redact(s), createStreamingRedactor: () => registry.createStreamingRedactor(),
  }), 5000, (delta) => emitted.push(delta));
  assert.equal(secret.stdout, "out:[secret:token]😀\n  end\n");
  assert.equal(secret.stderr, "err:[secret:token]\n");
  assert.equal(full(m, secret.session_id, "stdout"), secret.stdout);
  assert.equal(full(m, secret.session_id, "stderr"), secret.stderr);
  assert.ok(!JSON.stringify([secret, emitted, m.list(owner)]).includes("super-secret-token"));
  for (const stream of ["stdout", "stderr"] as const) {
    let end = 0;
    for (const d of emitted.filter((d) => d.stream === stream)) {
      assert.equal(d.streamStart, end);
      assert.equal(d.streamEnd! - end, Buffer.byteLength(d.text));
      end = d.streamEnd!;
    }
    assert.equal(end, secret.output_ranges[stream].end);
  }
  check("cross-chunk secrets isolated by stream, final flush, emoji and split CRLF without leak or double newline");

  const failed = await m.execute(options("process.stderr.write('failed\\n'); process.exitCode=7"), 5000);
  assert.equal(failed.status, "exited");
  assert.equal(failed.exit_code, 7);
  assert.equal(failed.termination_reason, "failed");
  const id = m.start(options("setInterval(()=>{},1000)"));
  const killed = await m.interact(id, { ownerId: owner, signal: "kill", yieldTimeMs: 5000 });
  assert.equal(killed.status, "killed");
  assert.equal(killed.termination_reason, "user_kill");
  const history = value(m.listHistory(owner)).records;
  for (const r of [long, failed, killed]) {
    const record = history.find((h) => h.record.runId === r.session_id)!.record;
    assert.equal(record.exit?.status, r.status);
    assert.equal(record.exit?.exitCode, r.exit_code);
    assert.equal(record.exit?.signal, r.signal);
    assert.equal(record.exit?.durationMs, r.duration_ms);
    assert.equal(record.exit?.terminationReason, r.termination_reason);
    assert.equal(record.expiresAt, r.finished_at! + TERMINAL_OUTPUT_RETENTION_MS);
  }
  check("0/nonzero/kill exit facts retained exactly, not success inferred from exited");

  const otherDir = path.join(root, "owner-b"); fs.mkdirSync(otherDir);
  value(m.registerOwnerSession("owner-b", otherDir));
  assert.equal(m.readOutput("owner-b", long.session_id, { stream: "stdout" }).ok, false);
  assert.deepEqual(value(m.listHistory("owner-b")).records, []);
  assert.deepEqual(m.list("owner-b"), []);
  await assert.rejects(m.interact(long.session_id, { ownerId: "owner-b", yieldTimeMs: 0 }));
  assert.equal(m.registerOwnerSession(owner, otherDir).ok, false);
  const childDir = path.join(dir, "subagents", "child"); fs.mkdirSync(childDir, { recursive: true });
  const child = await m.execute(options("console.log('child')", { ownerId: "child", sessionDir: childDir }), 5000);
  assert.equal(full(m, child.session_id, "stdout", "child"), "child\n");
  assert.equal(m.readOutput(owner, child.session_id, { stream: "stdout" }).ok, false);
  check("history/read/live/control cross-owner isolation and actual nested child session directory");

  const restored = manager();
  value(restored.registerOwnerSession(owner, dir));
  assert.equal(full(restored, long.session_id, "stdout"), expected);
  assert.equal(value(restored.listHistory(owner)).records.find((r) => r.record.runId === failed.session_id)?.record.exit?.exitCode, 7);
  assert.deepEqual(restored.list(owner), []);
  check("fresh manager/store reloads terminal history/output, never reconstructs running live tasks");

  // Stale persisted running metadata is a crash fixture, NOT a second manager recovering a live process.
  const lostDir = path.join(root, "lost-owner"); fs.mkdirSync(lostDir);
  const abandonedStore = new TerminalOutputStore({ sessionsRoot: root });
  value(abandonedStore.start("lost-owner", lostDir, "abandoned", { startedAt: Date.now(), status: "running" }));
  const lostManager = manager();
  const recovery = value(lostManager.registerOwnerSession("lost-owner", lostDir));
  assert.equal(recovery.records[0]?.record.lifecycle, "lost");
  assert.equal(recovery.records[0]?.record.exit, null);
  assert.equal(value(lostManager.readOutput("lost-owner", "abandoned", { stream: "stdout" })).text, null);
  check("restart residue is lost, no synthetic exit/success or readable stale output");

  const capDir = path.join(root, "cap-owner"); fs.mkdirSync(capDir);
  let now = Date.now();
  const capStore = new TerminalOutputStore({ sessionsRoot: root, now: () => now, maxBytesPerRun: 17 });
  const capManager = manager({ outputStore: capStore, maxProcesses: 1 });
  const cap = await capManager.execute(options("process.stdout.write('中😀'.repeat(50));process.stderr.write('ERR')", { ownerId: "cap-owner", sessionDir: capDir }), 5000);
  assert.equal(cap.output_ref.truncated, true);
  const capped = value(capManager.readOutput("cap-owner", cap.session_id, { stream: "stdout" }));
  assert.ok(capped.record.streams.stdout.storedBytes + capped.record.streams.stderr.storedBytes <= 17);
  assert.equal(capped.record.streams.stdout.observedBytes, 350);
  assert.ok(capped.text !== null && !capped.text.includes("�"));
  const next = await capManager.execute(options("console.log('next')", { ownerId: "cap-owner", sessionDir: capDir }), 5000);
  assert.equal(value(capManager.readOutput("cap-owner", cap.session_id, { stream: "stdout" })).record.availability, "evicted");
  assert.equal(value(capManager.listHistory("cap-owner")).records.length, 2);
  now = next.finished_at! + TERMINAL_OUTPUT_RETENTION_MS;
  const expired = value(capManager.readOutput("cap-owner", next.session_id, { stream: "stdout" }));
  assert.equal(expired.record.availability, "expired");
  assert.equal(expired.text, null);
  assert.equal(expired.record.exit?.exitCode, 0);
  capManager.sweepOutput();
  check("shared byte cap explicit, global manager slot eviction cleans output not facts, exact TTL revokes reads");

  const ioDir = path.join(root, "io-owner"); fs.mkdirSync(ioDir);
  const ioManager = manager();
  const io = await ioManager.execute(options("console.log('safe')", { ownerId: "io-owner", sessionDir: ioDir }), 5000);
  const outputFolder = fs.readdirSync(path.join(ioDir, "terminal-output"))[0]!;
  fs.unlinkSync(path.join(ioDir, "terminal-output", outputFolder, "stdout.txt"));
  const ioRead = value(ioManager.readOutput("io-owner", io.session_id, { stream: "stdout" }));
  assert.equal(ioRead.text, null);
  assert.equal(ioRead.record.availability, "io-error");
  const ioAgain = await ioManager.interact(io.session_id, { ownerId: "io-owner", yieldTimeMs: 0 });
  assert.equal(ioAgain.exit_code, 0);
  assert.equal(ioAgain.status, "exited");
  assert.equal(ioAgain.output_ref.availability, "io-error");
  const unavailable = await ioManager.execute(options("console.log('still runs')", { ownerId: "no-dir", sessionDir: path.join(root, "missing") }), 5000);
  assert.equal(unavailable.exit_code, 0);
  assert.equal(unavailable.output_ref.availability, "unavailable");
  check("store read/start I/O failures do not change process execution result");

  const meta = await m.execute(options("/*" + "中".repeat(1800) + "*/console.log('metadata')", { description: "😀".repeat(800) }), 5000);
  assert.equal(meta.exit_code, 0);
  const metaRecord = value(m.listHistory(owner)).records.find((r) => r.record.runId === meta.session_id)!.record;
  assert.deepEqual(metaRecord.metadata.truncatedFields, ["command", "description"]);
  assert.ok(Buffer.byteLength(metaRecord.metadata.command!) <= 4096);
  assert.ok(Buffer.byteLength(metaRecord.metadata.description!) <= 2048);
  assert.equal(full(m, meta.session_id, "stdout"), "metadata\n");
  const metadataReload = manager();
  value(metadataReload.registerOwnerSession(owner, dir));
  const reloadedMetadata = value(metadataReload.listHistory(owner)).records.find((r) => r.record.runId === meta.session_id)!.record.metadata;
  assert.deepEqual(reloadedMetadata.truncatedFields, ["command", "description"]);
  assert.equal(reloadedMetadata.command, metaRecord.metadata.command);
  check("oversize redacted metadata is Unicode-bounded and marked, run/history never rejected for long command");

  const tty = await m.execute(options("console.log('TTY:'+!!process.stdout.isTTY);console.error('merged')", { tty: true }), 5000);
  assert.equal(tty.exit_code, 0);
  assert.equal(tty.stream_mode, "tty_merged");
  assert.equal(tty.stderr, "");
  const ttyText = full(m, tty.session_id, "stdout");
  assert.ok(ttyText.includes("TTY:true") && ttyText.includes("merged"));
  assert.equal(full(m, tty.session_id, "stderr"), "");
  check("real PTY reports merged stream honestly, no fabricated stderr separation");

  // Default existing global policy remains 64 slots, across owners (small real processes).
  const slotDir = path.join(root, "slots"); fs.mkdirSync(slotDir);
  const slotManager = manager();
  let first = "";
  for (let i = 0; i < 65; i++) {
    const r = await slotManager.execute(options("process.exit(0)", { ownerId: "slots", sessionDir: slotDir }), 5000);
    if (!i) first = r.session_id;
  }
  assert.equal(slotManager.list("slots").length, 64);
  assert.equal(value(slotManager.listHistory("slots", { limit: 100 })).records.length, 65);
  assert.equal(value(slotManager.readOutput("slots", first, { stream: "stdout" })).record.availability, "evicted");
  check("65 real runs verify unchanged global 64-slot retention with persistent exit history");
  console.log(JSON.stringify({ ok: true, count: checks.length, checks }, null, 2));
}

void main().catch((error) => { console.error(error); console.error({ passed: checks }); process.exitCode = 1; })
  .finally(async () => {
    for (const m of managers) m.terminateAll();
    await delay(150);
    fs.rmSync(root, { recursive: true, force: true });
  });
