import assert from 'node:assert/strict';
import test from 'node:test';
import { ExecProcessManager } from '../../src/tools/builtins/exec-process-manager.js';
import { createWriteStdinTool } from '../../src/tools/builtins/exec-tool.js';
import type { ToolUseContext } from '../../src/tools/tool.js';

for (const long of [false, true]) test(`terminal poll preserves incremental output and exit status (${long ? 'long' : 'short'} command)`, async t => {
  const manager = new ExecProcessManager();
  t.after(() => manager.terminateAll());
  const command = `process.stdout.write('TEST_SUMMARY: 3 passed'); process.stderr.write('diagnostic');${long ? '/*' + 'x'.repeat(8000) + '*/' : ''}`;
  const started = await manager.execute({ command, ownerId: 'test', cwd: process.cwd(),
    shell: { requested: 'node', file: process.execPath, args: ['-e'] }, env: {},
    timeoutMs: 10000, maxOutputChars: 4000, tty: false }, 0);
  assert.equal(started.command, command, 'initial result retains original command');
  const tool = createWriteStdinTool(manager);
  const context = { agentId: 'test', emit() {} } as unknown as ToolUseContext;
  const result = await tool.call!({ session_id: started.session_id, chars: '', yield_time_ms: 3000 }, context, {});
  assert.equal(result.ok, true);
  const output = result.output as Record<string, any>;
  assert.equal(output.status, 'exited'); assert.equal(output.exit_code, 0);
  assert.equal(started.stdout + output.stdout, 'TEST_SUMMARY: 3 passed');
  assert.equal(started.stderr + output.stderr, 'diagnostic');
  assert.equal(output.output_kind, 'incremental');
  assert.equal(output.command_truncated, long ? true : undefined);
  if (long) {
    assert.equal(output.command, command.slice(0, 160) + '… [command abbreviated]');
    assert(JSON.stringify(output).length < 2500, 'command must not crowd a small result budget');
  } else assert.equal(output.command, command);
  assert.equal(manager.list().find(run => run.session_id === started.session_id)?.command, command, 'manager/UI metadata is unchanged');
  const next = (await tool.call!({ session_id: started.session_id, chars: '', yield_time_ms: 0 }, context, {})).output as Record<string, any>;
  assert.equal(next.stdout, ''); assert.equal(next.stderr, ''); assert.equal(next.exit_code, 0);
  assert.equal(next.output_ranges.stdout.start, output.output_ranges.stdout.end);
});

test('terminal input and signal responses keep their original command', async () => {
  const command = 'command'.repeat(1000);
  const source = { command, status: 'running', session_id: 'test', stdout: '', stderr: '', duration_ms: 1 };
  const manager = { async interact() { return source; } } as unknown as ExecProcessManager;
  const tool = createWriteStdinTool(manager);
  const context = { agentId: 'test', emit() {} } as unknown as ToolUseContext;
  for (const input of [{ chars: 'x' }, { chars: '', signal: 'interrupt' as const }]) {
    const result = await tool.call!({ session_id: 'test', yield_time_ms: 0, ...input }, context, {});
    const output = result.output as Record<string, unknown>;
    assert.equal(output.command, command); assert.equal(output.command_truncated, undefined);
  }
  assert.equal(source.command, command);
});
