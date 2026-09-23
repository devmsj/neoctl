import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/App.vue', import.meta.url), 'utf8');
const start = source.indexOf('function handleComposerDragOver(');
const end = source.indexOf('\n}', source.indexOf('function filesFromDataTransfer(')) + 2;
assert.ok(start >= 0 && end > start);
function fixture(desktop = false) {
  const uploaded = [], applied = [];
  let focused = 0;
  const context = vm.createContext({
    state: { composerDropActive: false, composerDropMode: 'prompt', promptLibrary: [{ id: 'prompt-one' }] },
    draggingPromptId: { value: '' }, composer: { value: { focus() { focused++; } } },
    isDesktop: () => desktop,
    uploadFiles: async files => uploaded.push(...files), applyPromptItem: async item => applied.push(item.id), notify: () => {},
  });
  vm.runInContext(source.slice(start, end), context);
  return { context, uploaded, applied, focused: () => focused };
}
function event(dataTransfer) {
  return { dataTransfer, prevented: false, preventDefault() { this.prevented = true; } };
}

test('file drag shows copy feedback and drop uploads the same files once', async () => {
  const f = fixture();
  const files = [{ name: '中文.txt' }, { name: 'photo.png' }];
  const e = event({ types: ['Files'], files });
  f.context.handleComposerDragOver(e);
  assert.equal(e.prevented, true);
  assert.equal(e.dataTransfer.dropEffect, 'copy');
  assert.equal(f.context.state.composerDropActive, true);
  assert.equal(f.context.state.composerDropMode, 'files');
  await f.context.handleComposerDrop(e);
  assert.deepEqual(f.uploaded, files);
  assert.equal(f.context.state.composerDropActive, false);
  assert.equal(f.focused(), 1);
});

test('DataTransfer.items fallback accepts files without turning text or directories into uploads', async () => {
  const f = fixture(), file = { name: 'report.pdf' };
  const e = event({ types: [], files: [], items: [
    { kind: 'file', getAsFile: () => file },
    { kind: 'file', getAsFile: () => null },
    { kind: 'string', getAsFile: () => assert.fail('not a file') },
  ] });
  f.context.handleComposerDragOver(e);
  await f.context.handleComposerDrop(e);
  assert.deepEqual(f.uploaded, [file]);
});

test('desktop HTML5 file drops never fall back to uploading, including images', async () => {
  const f = fixture(true);
  const e = event({ types: ['Files'], files: [{ name: 'photo.png' }, { name: 'report.txt' }] });
  await f.context.handleComposerDrop(e);
  assert.equal(e.prevented, true);
  assert.equal(f.uploaded.length, 0);
  assert.equal(f.context.state.composerDropActive, false);
});

test('internal prompt drag still works and unrelated text is not swallowed', async () => {
  const f = fixture();
  const text = event({ types: ['text/plain'], getData: () => '' });
  f.context.handleComposerDragOver(text);
  await f.context.handleComposerDrop(text);
  assert.equal(text.prevented, false);
  const prompt = event({ types: ['application/x-neoctl-prompt-id'], getData: () => 'prompt-one' });
  f.context.handleComposerDragOver(prompt);
  await f.context.handleComposerDrop(prompt);
  assert.deepEqual(f.applied, ['prompt-one']);
  assert.deepEqual(f.uploaded, []);
});
