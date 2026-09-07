// Real runWebServer/router/WebRepl + real child processes and owner-bound disk store.
// No model/provider, real user session, production-file changes, or transcript writes.
// Run: .\node_modules\.bin\tsx.cmd src/web/smoke-terminal-output-http.ts
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runWebServer, WebRepl, type WebRuntime } from './index.js';
import { ExecProcessManager, type ExecProcessStartOptions } from '../tools/builtins/exec-process-manager.js';
import { TerminalOutputStore, redactedTerminalChunk, TERMINAL_OUTPUT_RETENTION_MS, type OutputPage, type StoreResult } from '../tools/terminal-output-store.js';
import { InMemorySecretRedactionRegistry } from '../secrets/secret-redaction.js';

type Page = OutputPage & { sessionId: string; runId: string };
type State = { session: { sessionId: string }; lines: unknown[]; backgroundTaskCount: number; backgroundTasks: Task[]; terminalTaskHistory: Task[] };
type Task = { sessionId: string; ownerSessionId: string; status: string; exitCode?: number | null; terminationReason?: string; outputAvailability: string; [key: string]: unknown };
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'obs-terminal-http-'));
const dirs = new Map(['A', 'B'].map(id => [id, path.join(root, 'runtime-sessions', `actual-${id}`)]));
const redactions = new InMemorySecretRedactionRegistry();
let clock = Date.now();
let assertions = 0;
let requests = 0;
let modelCalls = 0;
let mutationCalls = 0;
let runtimeCreations = 0;
let server: http.Server | undefined;
let base = '';
const originalCreateServer = http.createServer;
const managers: ExecProcessManager[] = [];
const phases: string[] = [];
function check(value: unknown, message: string): asserts value { assert.ok(value, message); assertions++; }
function equal(actual: unknown, expected: unknown, message: string): void { assert.deepEqual(actual, expected, message); assertions++; }
function value<T>(result: StoreResult<T>, message: string): T { check(result.ok, message); return result.value; }
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function createStore() {
  return new TerminalOutputStore({ sessionsRoot: root, now: () => clock, resolveOwnerSessionDir: id => dirs.get(id) });
}
let store = createStore();
function createManager() {
  const manager = new ExecProcessManager({ outputStore: store, completedRetentionMs: 600_000, maxProcesses: 20 });
  managers.push(manager);
  return manager;
}
let manager = createManager();
function options(owner: string, script: string, extra: Partial<ExecProcessStartOptions> = {}): ExecProcessStartOptions {
  return { ownerId: owner, sessionDir: dirs.get(owner)!, command: 'node terminal HTTP fixture',
    cwd: root, shell: { requested: 'node', file: process.execPath, args: ['-e', script, '--'] },
    env: {}, timeoutMs: 60_000, maxOutputChars: 400_000, tty: false, ...extra };
}
async function closeServer() {
  const current = server;
  server = undefined;
  if (current) { current.closeAllConnections(); await new Promise<void>(resolve => current.close(() => resolve())); }
}
async function startServer() {
  // Same capture fixture as smoke-tool-detail-fields-http.ts: the production private route is untouched.
  const probe = originalCreateServer();
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  check(address && typeof address === 'object', 'temporary port allocated');
  const port = address.port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  (http as unknown as { createServer: Function }).createServer = (...args: unknown[]) => {
    server = (originalCreateServer as Function)(...args) as http.Server;
    return server;
  };
  try {
    await runWebServer(['--host', '127.0.0.1', '--port', String(port)], {
      createRuntime: async config => {
        runtimeCreations++;
        const owner = config?.sessionId ?? 'A';
        const session = dirs.has(owner) ? { sessionId: owner, sessionDir: dirs.get(owner) } : undefined;
        const denyMutation = () => { mutationCalls++; throw new Error('GET attempted an engine mutation'); };
        return {
          execProcessManager: manager,
          taskStore: { subscribe: () => () => {}, list: () => [], isTerminal: () => false },
          engine: {
            snapshot: () => ({ session, messages: 0 }), getDisplayEntries: () => [], getHistoryMessages: () => [],
            redactDisplayValue: <T>(v: T) => redactions.redact(v), isFastMode: () => false,
            getAppPrompt: () => ({ hasActivePrompt: false }), onSessionTitleChange: () => () => {},
            submit: denyMutation, query: denyMutation, appendMessage: denyMutation,
          },
          model: { generate: () => { modelCalls++; throw new Error('model must never run'); } },
          envPath: path.join(root, 'fixture.env'), initialMetrics: {},
        } as unknown as WebRuntime;
      },
      createRepl: runtime => {
        const repl = new WebRepl(runtime);
        repl.submit = (() => { modelCalls++; throw new Error('GET attempted submit'); }) as WebRepl['submit'];
        return repl;
      },
    });
  } finally { (http as unknown as { createServer: Function }).createServer = originalCreateServer; }
  check(server?.listening, 'real server listening');
  base = `http://127.0.0.1:${port}`;
}
function outputUrl(owner: string, run: string, changes: Record<string, string> = {}) {
  return `${base}/api/terminal-output?${new URLSearchParams({ sessionId: owner, runId: run, stream: 'stdout', offset: '0', limitBytes: '65536', ...changes })}`;
}
async function request(url: string, init?: RequestInit) {
  requests++;
  return fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
}
async function page(owner: string, run: string, changes: Record<string, string> = {}): Promise<Page> {
  const response = await request(outputUrl(owner, run, changes));
  equal(response.status, 200, `HTTP output 200 ${owner}/${run}`);
  equal(response.headers.get('cache-control'), 'no-store', 'output is non-cacheable');
  const body = await response.json() as Page;
  equal(body.sessionId, owner, 'response owner'); equal(body.runId, run, 'response run');
  equal(body.record.ownerSessionId, owner, 'stored owner'); equal(body.record.runId, run, 'stored run');
  return body;
}
async function state(owner: string): Promise<State> {
  const response = await request(`${base}/api/state?${new URLSearchParams({ sessionId: owner })}`);
  equal(response.status, 200, 'real snapshot HTTP 200');
  const body = await response.json() as State;
  equal(body.session.sessionId, owner, 'snapshot owner');
  return body;
}
async function waitFor(run: string, predicate: (entry: ReturnType<ExecProcessManager['list']>[number]) => boolean) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const entry = manager.list().find(item => item.session_id === run);
    if (entry && predicate(entry)) return entry;
    await delay(20);
  }
  throw new Error(`Timed out waiting for real process ${run}`);
}
async function nonOutputFiles(dir: string, excludeOutput = true): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function visit(folder: string) {
    for (const item of await fs.readdir(folder, { withFileTypes: true })) {
      if (excludeOutput && item.name === 'terminal-output') continue;
      const full = path.join(folder, item.name);
      if (item.isDirectory()) await visit(full);
      else result[path.relative(dir, full)] = (await fs.readFile(full)).toString('base64');
    }
  }
  await visit(dir);
  return result;
}

try {
  for (const [owner, dir] of dirs) {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'transcript.jsonl'), '{"fixture":"unchanged"}\n', 'utf8');
    value(manager.registerOwnerSession(owner, dir), `bind actual ${owner} runtime directory`);
  }
  await fs.writeFile(path.join(root, 'fixture.env'), '', 'utf8');
  const beforeFiles = await nonOutputFiles(root);
  await startServer();

  // Real stream bytes, including repeated identical lines and identical stdout/stderr.
  const expected = 'first\n\n  \t\nrepeat\nrepeat\n相同🙂\nlast\n';
  const run = manager.start(options('A', `process.stdout.write(${JSON.stringify(expected)});process.stderr.write(${JSON.stringify(expected)});process.stdin.once('data',()=>process.exit(7));`));
  await waitFor(run, entry => entry.output.includes('last\n') && entry.output.includes('[stderr]'));
  const running = await page('A', run);
  equal(running.text, expected, 'all multiline/blank/repeated stdout preserved');
  equal(running.record.lifecycle, 'running', 'real running lifecycle');
  equal(running.record.exit, null, 'running has no fabricated exit');
  equal((await page('A', run, { stream: 'stderr' })).text, expected, 'identical stderr preserved independently');
  equal((await page('A', run)).text, expected, 'repeated GET is non-consuming');
  const firstDrain = await manager.interact(run, { ownerId: 'A', yieldTimeMs: 0 });
  equal(firstDrain.stdout, expected, 'HTTP did not consume stdout drain');
  equal(firstDrain.stderr, expected, 'HTTP did not consume stderr drain');
  const emptyDrain = await manager.interact(run, { ownerId: 'A', yieldTimeMs: 0 });
  equal(emptyDrain.stdout, '', 'second explicit stdout drain empty');
  equal(emptyDrain.stderr, '', 'second explicit stderr drain empty');
  equal((await page('A', run)).text, expected, 'store survives explicit consuming drain');
  const finished = await manager.interact(run, { ownerId: 'A', chars: 'exit\n', yieldTimeMs: 5_000 });
  equal(finished.exit_code, 7, 'actual nonzero process exit');
  const terminal = await page('A', run);
  equal(terminal.record.lifecycle, 'terminal', 'running becomes terminal over HTTP');
  equal(terminal.record.exit?.exitCode, 7, 'HTTP nonzero fact');
  equal(terminal.record.exit?.status, finished.status, 'HTTP status equals manager fact');
  equal(terminal.record.exit?.terminationReason, 'failed', 'HTTP failed reason');
  phases.push('real-process-multiline-dual-stream-drain-nonzero');

  // Same run identity in a second owner is intentionally created via the independent store fixture.
  value(store.start('B', dirs.get('B')!, run, { startedAt: clock, command: 'B identity fixture' }), 'B same-run start');
  value(store.append('B', run, redactedTerminalChunk('stdout', 0, 'B_ONLY\n')), 'B same-run append');
  value(store.finalize('B', run, { status: 'exited', finishedAt: clock, exitCode: 0, signal: null, terminationReason: 'completed', durationMs: 0 }), 'B same-run finish');
  equal((await page('B', run)).text, 'B_ONLY\n', 'same run B resolves only B bytes');
  equal((await page('A', run)).text, expected, 'same run A still resolves only A bytes');

  // Boundaries deliberately land inside a 4-byte scalar at 65536 and later pages.
  const large = 'x'.repeat(65535) + '🙂中\n\n'.repeat(10_000) + 'tail\n';
  const bigRun = manager.start(options('A', "process.stdout.write('x'.repeat(65535)+'🙂中\\n\\n'.repeat(10000)+'tail\\n');process.stdin.once('data',()=>process.exit(0));"));
  await waitFor(bigRun, entry => entry.output.includes('tail\n'));
  const bigRunning = await page('A', bigRun);
  equal(bigRunning.record.lifecycle, 'running', 'zero-exit process first observed running over HTTP');
  equal(bigRunning.record.exit, null, 'zero-exit process has no exit facts while running');
  const zeroExit = await manager.interact(bigRun, { ownerId: 'A', chars: 'exit\n', yieldTimeMs: 5_000 });
  equal(zeroExit.exit_code, 0, 'actual process exits zero after running observation');
  let offset = 0; let joined = ''; let pages = 0;
  do {
    const current = await page('A', bigRun, { offset: String(offset) });
    equal(current.offset, offset, 'page starts at requested UTF8 byte cursor');
    check(typeof current.text === 'string', 'available page has text');
    equal(current.nextOffset - offset, Buffer.byteLength(current.text), 'cursor delta is exact UTF8 bytes');
    check(Buffer.byteLength(current.text) <= 65536, '64KiB maximum page');
    check(!current.text.includes('\ufffd'), 'no replacement scalar at page boundary');
    check(current.nextOffset > offset, 'nonempty page advances');
    if (!pages) equal(current.nextOffset, 65535, 'first page stops before split emoji');
    joined += current.text; offset = current.nextOffset; pages++;
    if (current.endOfStoredOutput) break;
    check(pages < 10, 'pagination bounded');
  } while (true);
  equal(pages, 3, 'crosses three 64KiB HTTP pages');
  equal(joined, large, 'UTF8 pages concatenate without loss or duplication');
  equal(offset, Buffer.byteLength(large), 'last cursor equals total UTF8 bytes');
  const eof = await page('A', bigRun, { offset: String(offset) });
  equal(eof.text, '', 'available EOF is empty string, not unavailable null');
  equal(eof.nextOffset, offset, 'EOF stable cursor'); equal(eof.endOfStoredOutput, true, 'EOF fact');
  equal((await page('A', bigRun, { stream: 'stderr' })).text, '', 'genuinely empty separate stream');
  equal((await request(outputUrl('B', bigRun))).status, 404, 'other owner cannot read A-only run');
  phases.push('owner-run-isolation-64KiB-UTF8-pagination');

  const stopRun = (await manager.execute(options('A', "process.stdout.write('STOP_READY\\n');setInterval(()=>{},1000);"), 0)).session_id;
  const bLive = (await manager.execute(options('B', "process.stdout.write('B_ACTIVE_ONLY\\n');setInterval(()=>{},1000);"), 0)).session_id;
  await waitFor(stopRun, entry => entry.output.includes('STOP_READY'));
  await waitFor(bLive, entry => entry.output.includes('B_ACTIVE_ONLY'));
  for (const owner of ['A', 'B']) {
    const snapshot = await state(owner);
    equal(snapshot.backgroundTaskCount, 1, 'active count is owner-scoped');
    equal(snapshot.backgroundTasks.map(task => task.sessionId), [owner === 'A' ? stopRun : bLive], 'active task identity isolated');
    check(snapshot.backgroundTasks.every(task => task.ownerSessionId === owner), 'active owner identity');
    check(snapshot.terminalTaskHistory.every(task => task.ownerSessionId === owner), 'history owner identity');
    equal(snapshot.terminalTaskHistory.find(task => task.sessionId === run)?.exitCode, owner === 'A' ? 7 : 0, 'same-run history resolves owner-specific exit facts');
    check(snapshot.terminalTaskHistory.every(task => !('output' in task)), 'history does not embed terminal output');
    check(snapshot.backgroundTasks.every(task => !('output' in task)), 'snapshot does not embed terminal output');
    equal(snapshot.lines, [], 'terminal reads did not create transcript lines');
  }
  const stopped = await manager.interact(stopRun, { ownerId: 'A', signal: 'kill', yieldTimeMs: 5_000 });
  equal(stopped.status, 'killed', 'actual killed process');
  const stopPage = await page('A', stopRun);
  equal(stopPage.record.exit?.status, 'killed', 'HTTP killed status');
  equal(stopPage.record.exit?.terminationReason, 'user_kill', 'HTTP user stop reason');
  equal(stopPage.record.exit?.exitCode, stopped.exit_code, 'stop exit not fabricated as success');
  equal(stopPage.record.exit?.signal, stopped.signal, 'actual platform stop signal retained');
  const success = await page('A', bigRun);
  equal(success.record.exit?.exitCode, 0, 'zero exit fact');
  equal(success.record.exit?.status, 'exited', 'zero exit manager status');
  equal(success.record.exit?.terminationReason, 'completed', 'zero completion reason');
  const afterStop = await state('A');
  equal(afterStop.backgroundTaskCount, 0, 'stopped task leaves active list');
  const stopHistory = afterStop.terminalTaskHistory.find(task => task.sessionId === stopRun);
  equal(stopHistory?.status, 'killed', 'stopped task retained in HTTP history');
  equal(stopHistory?.terminationReason, 'user_kill', 'history stop fact');
  phases.push('snapshot-owner-active-history-stop-zero');

  const secret = 'HTTP_FIXTURE_SECRET_8efb312a';
  redactions.record('http_fixture', secret);
  const secretRun = manager.start(options('A', `process.stdout.write(${JSON.stringify(secret.slice(0, 12))});setTimeout(()=>{process.stdout.write(${JSON.stringify(secret.slice(12) + '\n')});process.stderr.write(${JSON.stringify(secret + '\n')});},30);`, {
    command: `node secret fixture ${secret}`, redactOutput: text => redactions.redactString(text), createStreamingRedactor: () => redactions.createStreamingRedactor(),
  }));
  await waitFor(secretRun, entry => entry.status !== 'running');
  const secretPage = await page('A', secretRun);
  equal(secretPage.text, '[secret:http_fixture]\n', 'split registered secret redacted before persistence');
  equal((await page('A', secretRun, { stream: 'stderr' })).text, '[secret:http_fixture]\n', 'secret stderr redacted');
  check(!JSON.stringify(secretPage).includes(secret), 'HTTP secret absent including metadata');
  const diskText = Object.values(await nonOutputFiles(root, false)).map(encoded => Buffer.from(encoded, 'base64').toString('utf8')).join('\n');
  check(diskText.includes('[secret:http_fixture]'), 'redacted marker actually persisted on disk');
  check(!diskText.includes(secret), 'registered secret absent from all fixture disk files');
  // Late registration exercises the WebRepl final display-redaction boundary, not just process redaction.
  const lateSecret = 'LATE_HTTP_SECRET_a71e32';
  const lateRun = manager.start(options('A', `process.stdout.write(${JSON.stringify(lateSecret + '\n')});`));
  await waitFor(lateRun, entry => entry.status !== 'running');
  redactions.record('late_http', lateSecret);
  const latePage = await page('A', lateRun);
  equal(latePage.text, '[secret:late_http]\n', 'final response redacts newly registered secret');
  equal(latePage.nextOffset, Buffer.byteLength(lateSecret + '\n'), 'final redaction does not rewrite stored byte cursor');
  check(!JSON.stringify(await state('A')).includes(secret), 'history metadata secret redacted');
  phases.push('streaming-and-final-response-secret-redaction');

  const invalid: Record<string, string>[] = [
    { runId: '../B' }, { runId: '..\\B' }, { runId: '/etc/passwd' }, { runId: 'C:\\Windows\\win.ini' },
    { runId: 'NUL' }, { runId: 'a\u0000b' }, { runId: '' }, { runId: 'absent' },
    { sessionId: 'absent' }, { sessionId: '../B' }, { stream: 'combined' },
    { offset: '-1' }, { offset: '1.5' }, { offset: 'NaN' }, { offset: 'Infinity' }, { offset: '9007199254740992' },
    { offset: '65536' }, // continuation byte of first emoji
    { offset: String(Buffer.byteLength(large) + 1) },
    { limitBytes: '0' }, { limitBytes: '3' }, { limitBytes: '262145' }, { limitBytes: '1.5' }, { limitBytes: 'NaN' },
  ];
  for (const changes of invalid) equal((await request(outputUrl('A', bigRun, changes))).status, 404, `reject invalid ${JSON.stringify(changes)}`);
  for (const missing of ['sessionId', 'runId']) {
    const url = new URL(outputUrl('A', run)); url.searchParams.delete(missing);
    equal((await request(url.href)).status, 404, `reject missing ${missing}`);
  }
  equal((await request(outputUrl('A', run), { method: 'POST' })).status, 404, 'non-GET refused');
  const creationsBefore = runtimeCreations;
  equal((await request(outputUrl('uncreated-owner', run), { headers: { Origin: 'https://evil.invalid', 'Sec-Fetch-Site': 'cross-site' } })).status, 403, 'cross-origin guard before runtime creation');
  equal(runtimeCreations, creationsBefore, '403 does not create runtime');
  equal((await request(outputUrl('A', run), { headers: { Origin: 'https://evil.invalid' } })).status, 403, 'host-mismatching origin refused');
  equal((await request(outputUrl('A', run), { headers: { Origin: base, 'Sec-Fetch-Site': 'same-origin' } })).status, 200, 'same-origin accepted');
  phases.push('invalid-path-cursor-missing-404-cross-origin-403');

  // Reconstruct BOTH manager/store and server/router/runtime. A genuinely live real child in B is
  // intentionally left running in the old manager, reproducing persisted running-record recovery.
  // This is a recovery-boundary test, not a claim that an OS host crash was simulated.
  check(manager.list('B').some(entry => entry.session_id === bLive && entry.status === 'running'), 'residual process genuinely live before manager rebuild');
  const creationsAtRefresh = runtimeCreations;
  await closeServer(); store = createStore(); manager = createManager(); await startServer();
  equal((await page('A', run)).text, expected, 'new manager+runtime reads persisted full output');
  equal((await page('B', run)).text, 'B_ONLY\n', 'refresh keeps same-run owner isolation');
  check(runtimeCreations > creationsAtRefresh, 'refresh constructs fresh runtime fixtures');
  const lost = await page('B', bLive);
  equal(lost.record.lifecycle, 'lost', 'real running residual becomes lost after manager rebuild');
  equal(lost.record.availability, 'lost', 'lost availability'); equal(lost.text, null, 'lost output unavailable, not empty');
  equal(lost.record.exit, null, 'lost does not invent exit success or failure');
  check(lost.record.lostAt !== null, 'lost timestamp recorded');
  const recoveredB = await state('B');
  equal(recoveredB.backgroundTaskCount, 0, 'lost residual not active after refresh');
  equal(recoveredB.terminalTaskHistory.find(task => task.sessionId === bLive)?.status, 'lost', 'HTTP history exposes lost');
  const recoveredA = await state('A');
  equal(recoveredA.terminalTaskHistory.find(task => task.sessionId === run)?.exitCode, 7, 'refresh history retains nonzero exit');
  phases.push('fresh-manager-store-server-runtime-recovery-real-running-lost');

  const expiresAt = terminal.record.expiresAt;
  check(expiresAt !== null, 'finished output has retention deadline');
  equal(expiresAt - terminal.record.exit!.finishedAt, TERMINAL_OUTPUT_RETENTION_MS, 'five minute retention contract');
  clock = expiresAt - 1;
  equal((await page('A', run)).text, expected, 'output available immediately before TTL');
  clock = expiresAt;
  const expired = await page('A', run);
  equal(expired.record.availability, 'expired', 'TTL boundary expiration');
  equal(expired.text, null, 'expired output null, not empty string');
  equal(expired.record.exit, terminal.record.exit, 'all exit facts survive TTL');
  equal(expired.record.lifecycle, 'terminal', 'expiration never changes process lifecycle');
  equal((await page('A', run, { stream: 'stderr' })).text, null, 'both streams expire');
  const expiredHistory = (await state('A')).terminalTaskHistory.find(task => task.sessionId === run);
  equal(expiredHistory?.exitCode, 7, 'expired history retains exit');
  equal(expiredHistory?.outputAvailability, 'expired', 'expired history availability');
  // Another full refresh proves TTL does not get renewed and facts stay durable.
  await closeServer(); store = createStore(); manager = createManager(); await startServer();
  const reexpired = await page('A', run);
  equal(reexpired.text, null, 'refresh does not resurrect expired bytes');
  equal(reexpired.record.exit, terminal.record.exit, 'refresh retains expired exit facts');
  phases.push('fake-clock-exact-TTL-null-durable-exit');

  equal(await nonOutputFiles(root), beforeFiles, 'no non-output file changed/created, including transcript');
  equal(mutationCalls, 0, 'no engine mutation entry points called');
  equal(modelCalls, 0, 'no submit/model calls');
} finally {
  (http as unknown as { createServer: Function }).createServer = originalCreateServer;
  await closeServer();
  for (const instance of managers) instance.terminateAll();
  const deadline = Date.now() + 10_000;
  while (managers.some(instance => instance.list().some(entry => entry.status === 'running')) && Date.now() < deadline) await delay(25);
  equal(managers.flatMap(instance => instance.list()).filter(entry => entry.status === 'running').length, 0, 'all real child processes released');
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  equal(await fs.stat(root).then(() => true, () => false), false, 'temporary session root removed');
}
console.log(JSON.stringify({ ok: true, assertions, requests, modelCalls, mutationCalls, phases, cleanup: 'HTTP listeners closed; all real processes exited; temp root removed' }, null, 2));
