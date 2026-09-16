import test from 'node:test';
import assert from 'node:assert/strict';
import { WebRepl } from '../../engine/dist/web/index.js';

function fixture() {
  const lines = [];
  let syncs = 0, updates = 0;
  const target = {
    runtime: { engine: {
      setAppPrompt(input) { if (input.content === 'FAIL') throw new Error('test failure'); return { hasActivePrompt: true, activePrompt: input }; },
      clearAppPrompt() { return { hasActivePrompt: false }; },
    } },
    append(line) { lines.push(line); },
    broadcastSync() { syncs++; },
    publishRuntimeContext() { updates++; },
  };
  return { lines, apply: payload => WebRepl.prototype.setAppPrompt.call(target, payload), counts: () => ({ syncs, updates }) };
}

test('applying a prompt emits exactly one primary Markdown usage message', () => {
  const f = fixture();
  const r = f.apply({ id: 'demo', title: '示例', content: 'Prompt content', usage: '  先提供 **素材**，再描述需求。  ' });
  assert.equal(r.ok, true);
  assert.equal(f.lines.length, 1);
  assert.deepEqual(f.lines[0], { kind: 'meta', title: '提示词用法', text: '先提供 **素材**，再描述需求。', format: 'markdown', presentationLevel: 'primary' });
  assert.deepEqual(f.counts(), { syncs: 1, updates: 1 });
});

test('missing or whitespace usage receives useful fallback guidance', () => {
  for (const usage of [undefined, '', '   ']) {
    const f = fixture();
    assert.equal(f.apply({ content: 'Prompt content', usage }).ok, true);
    assert.equal(f.lines.length, 1);
    assert.equal(f.lines[0].presentationLevel, 'primary');
    assert.match(f.lines[0].text, /输入框/);
    assert.match(f.lines[0].text, /后续对话/);
  }
});

test('clearing or failed application does not emit usage guidance', () => {
  for (const payload of [{ clear: true }, { content: '' }, { content: 'FAIL', usage: 'must not show' }]) {
    const f = fixture(); f.apply(payload); assert.equal(f.lines.length, 0);
  }
});
