import { test } from 'node:test';
import assert from 'node:assert/strict';
import { terminalFacts, terminalPreviews, terminalResultText, terminalStatus } from './terminal-presentation.js';
test('terminal streams preserve all whitespace and remain separate', () => {
  const text = '\n  first\n\n\tlast  \n\n';
  const previews = terminalPreviews({ stdout: text, stderr: text });
  assert.equal(previews.length, 2);
  assert.equal(previews[0]?.content, text);
  assert.equal(previews[1]?.content, text);
  assert.equal(previews[1]?.label, 'stderr');
  assert.ok(terminalResultText({ stdout: text, stderr: '' }).includes(text));
  assert.equal(terminalPreviews({ stdout: '', stderr: '\n' }).length, 2);
});
test('status uses exit facts not tool invocation success', () => {
  for (const [input, expected] of [
    [{ status: 'running' }, '运行中'], [{ status: 'exited', exit_code: 0 }, '已完成'],
    [{ status: 'exited', exit_code: 7 }, '执行失败'], [{ status: 'exited', exit_code: 0, termination_reason: 'terminate' }, '已停止'],
    [{ status: 'exited', timed_out: true }, '已超时'], [{ status: 'exited', signal: 'SIGTERM' }, '因信号终止'],
    [{ status: 'exited' }, '已退出（结果未提供）'], [{ status: 'lost' }, '运行已失联'], [{}, '未提供'],
  ] as const) assert.equal(terminalStatus(input), expected);
});
test('zero, missing, truncation and TTY semantics are explicit', () => {
  const facts = terminalFacts({ exit_code: 0, duration_ms: 0, output_chars: { stdout: 0 }, omitted_chars: { stdout: 0, stderr: 20 } });
  assert.equal(facts.find(x => x.label === '退出码')?.value, '0');
  assert.equal(facts.find(x => x.label === '信号')?.value, '未提供');
  assert.equal(facts.find(x => x.label === '耗时')?.value, '0 ms');
  assert.equal(facts.find(x => x.label === 'stdout 本次字符')?.value, '0');
  assert.equal(facts.find(x => x.label === 'stderr 本次省略')?.tone, 'warning');
  assert.match(terminalPreviews({ stdout: '123456', tty: true }, 4)[0]!.label, /TTY 合流.*截断/);
  assert.equal(terminalPreviews({ stdout: '123456' }, 4)[0]!.content, '1234');
});
