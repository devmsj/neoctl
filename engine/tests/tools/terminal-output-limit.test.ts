import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ExecProcessManager } from '../../src/tools/builtins/exec-process-manager.js';
import { createExecTool, createWriteStdinTool } from '../../src/tools/builtins/exec-tool.js';
import { validateJsonSchema } from '../../src/tools/schema.js';
import type { Tool, ToolUseContext } from '../../src/tools/tool.js';

const context = { agentId: 'limit-test', emit() {} } as unknown as ToolUseContext;
const payload = 'HEAD中文😀' + 'x中😀'.repeat(1200) + 'TAIL中文😀';
const request = { max_output_chars: 1000 };
function validated<T>(tool: Tool<T>, raw: unknown): T {
  const schema = validateJsonSchema(raw, tool.inputSchema);
  assert.equal(schema.ok, true, JSON.stringify(schema));
  const input = tool.validate!(raw, context);
  const result = tool.validateInput!(input, context);
  // Both terminal tools validate synchronously.
  assert.ok(!(result instanceof Promise));
  assert.equal(result.ok, true, JSON.stringify(result));
  return input;
}

test('terminal_run and terminal_control accept the same output limit; omission preserves the session limit', () => {
  const manager = new ExecProcessManager();
  const run = createExecTool({ processManager: manager });
  const control = createWriteStdinTool(manager);
  for (const max_output_chars of [1000, 40000, 200000]) {
    validated(run, { cmd: 'echo ok', max_output_chars });
    const input = validated(control, { session_id: 'test', chars: '', max_output_chars });
    assert.equal((input as any).max_output_chars, max_output_chars);
  }
  assert.equal((control.validate!({ session_id: 'test' }, context) as any).max_output_chars, undefined);
  for (const max_output_chars of [0, 999, 200001, 1.5, '4000']) {
    for (const [tool, base] of [[run, { cmd: 'echo ok' }], [control, { session_id: 'test' }]] as const) {
      const raw = { ...base, max_output_chars };
      const schema = validateJsonSchema(raw, tool.inputSchema);
      if (schema.ok) {
        const result = tool.validateInput!(tool.validate!(raw, context) as never, context);
        assert.ok(!(result instanceof Promise));
        assert.equal(result.ok, false, `must reject ${JSON.stringify(raw)}`);
      }
    }
  }
});

for (const [initial, limit] of [[8000, 1000], [1000, 8000]]) test(`poll resize ${initial}->${limit} preserves Unicode, existing gaps and stored output`, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'neo-poll-limit-'));
  await mkdir(path.join(root, 'limit-test'));
  const manager = new ExecProcessManager({ sessionsRoot: root });
  t.after(async () => { manager.terminateAll(); await rm(root, { recursive: true, force: true }); });
  const id = manager.start({ ownerId: 'limit-test', sessionDir: path.join(root, 'limit-test'), command: `process.stdout.write(${JSON.stringify(payload)}); process.stderr.write(${JSON.stringify(payload)});`,
    cwd: process.cwd(), shell: { requested: 'node', file: process.execPath, args: ['-e'] }, env: {}, timeoutMs: 10000, maxOutputChars: initial, tty: false });
  // Let output arrive before applying the smaller poll limit, to exercise resizing unread data.
  for (let i = 0; i < 1000 && manager.list().find(run => run.session_id === id)?.status === 'running'; i++) await new Promise(r => setTimeout(r, 10));
  assert.notEqual(manager.list().find(run => run.session_id === id)?.status, 'running');
  const tool = createWriteStdinTool(manager);
  const result = await tool.call!(validated(tool, { session_id: id, yield_time_ms: 0, max_output_chars: limit }), context, {});
  assert.equal(result.ok, true);
  const output = result.output as any;
  for (const stream of ['stdout', 'stderr'] as const) {
    assert.equal(output.output_chars[stream], payload.length);
    const kept = output.output_ranges[stream].retained;
    assert.equal(output.output_ranges[stream].end, Buffer.byteLength(payload));
    assert.equal(output.output_ranges[stream].truncated, true);
    const bytes = Buffer.from(payload);
    const head = bytes.subarray(kept[0].start, kept[0].end).toString();
    const tail = bytes.subarray(kept[1].start, kept[1].end).toString();
    assert.ok(head.length + tail.length <= Math.min(initial, limit));
    assert.equal(output.omitted_chars[stream], payload.length - head.length - tail.length);
    assert.equal(output[stream], head + `\n[... ${output.omitted_chars[stream]} characters omitted ...]\n` + tail);
    assert.ok(head.startsWith('HEAD')); assert.ok(tail.endsWith('TAIL中文😀'));
    assert.ok(!/[\uD800-\uDBFF]$/.test(head) && !/^[\uDC00-\uDFFF]/.test(tail));
    const stored = manager.readOutput('limit-test', id, { stream, offset: 0, limitBytes: 100000 });
    assert.equal(stored.ok, true, JSON.stringify(stored));
    if (stored.ok) assert.equal(stored.value.text, payload, 'full output storage is unchanged');
  }
  const next = (await tool.call!(validated(tool, { session_id: id, yield_time_ms: 0 }), context, {})).output as any;
  assert.equal(next.stdout, ''); assert.equal(next.stderr, '');
  assert.equal(next.output_ranges.stdout.start, Buffer.byteLength(payload));
});

test('explicit limit applies before new output; omitted polls inherit it and a larger limit applies to later output', async t => {
  const manager = new ExecProcessManager();
  t.after(() => manager.terminateAll());
  const id = manager.start({ ownerId: 'limit-test', command: `process.stdin.on('data', () => { process.stdout.write(${JSON.stringify(payload)}); process.stderr.write('READY'); });`,
    cwd: process.cwd(), shell: { requested: 'node', file: process.execPath, args: ['-e'] }, env: {}, timeoutMs: 10000, maxOutputChars: 8000, tty: false });
  const tool = createWriteStdinTool(manager);
  const poll = async (raw: object) => {
    const result = await tool.call!(validated(tool, { session_id: id, yield_time_ms: 0, ...raw }), context, {});
    assert.equal(result.ok, true);
    return result.output as any;
  };
  const waitForPayload = async () => {
    for (let i = 0; i < 1000; i++) {
      if (manager.list().find(run => run.session_id === id)?.output.endsWith('[stderr] READY')) return;
      await new Promise(r => setTimeout(r, 10));
    }
    assert.fail('child did not write payload');
  };
  await poll({ ...request });
  await poll({ chars: 'go\n' });
  // yield_time_ms=0 returns before the child handles stdin; await its output without draining it.
  await waitForPayload();
  const small = await poll({});
  assert.ok(small.omitted_chars.stdout > 0, 'omission inherits the smaller limit');
  assert.ok(small.output_chars.stdout - small.omitted_chars.stdout <= 1000);
  await poll({ max_output_chars: 8000 });
  await poll({ chars: 'go\n' });
  // Wait for the second payload by stream length, independently of polling/draining.
  for (let i = 0; i < 1000; i++) {
    if ((manager.list().find(run => run.session_id === id)?.outputEnd ?? 0) >= 2 * (payload.length + '[stderr] READY'.length)) break;
    await new Promise(r => setTimeout(r, 10));
  }
  const large = await poll({});
  assert.equal(large.stdout, payload);
  assert.equal(large.omitted_chars.stdout, 0);
});
