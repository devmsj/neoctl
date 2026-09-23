import test from 'node:test';
import assert from 'node:assert/strict';
import { connectDesktopFileDrops, dropHitsTarget } from '../src/desktop-file-drop.mjs';
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(invokeOverride) {
  const calls = [], files = [], errors = [], hover = [];
  const child = {}, target = { contains: item => item === child, getBoundingClientRect: () => ({ left: 10, right: 110, top: 20, bottom: 120, width: 100, height: 100 }) };
  let channel;
  const refs = [{ kind: 'file', name: '中文.png', absolutePath: 'C:\\original\\中文.png', size: 8, mimeType: 'application/octet-stream' }];
  const scope = { devicePixelRatio: 2, document: { elementFromPoint: () => child }, __TAURI__: { core: {
    Channel: class { constructor() { channel = this; this.id = 17; } },
    invoke: async (command, args) => { calls.push({ command, args }); if (invokeOverride) return invokeOverride(command, args); return command.endsWith('take_file_drop') ? refs : undefined; },
  } } };
  const dispose = connectDesktopFileDrops({ scope, getTarget: () => target, onHover: value => hover.push(value), onFiles: value => files.push(...value), onError: value => errors.push(value) });
  return { calls, files, errors, hover, scope, target, refs, dispose, emit: event => channel.onmessage(event) };
}
const drop = { type: 'drop', id: 1, position: { x: 100, y: 100 } };

test('DPI/zoom converts physical coordinates, ignores outside, hidden and covered composers', () => {
  const f = fixture();
  assert.equal(dropHitsTarget(drop.position, f.target, f.scope), true);
  assert.equal(dropHitsTarget({ x: 5, y: 50 }, f.target, f.scope), false);
  assert.equal(dropHitsTarget({ x: NaN, y: 50 }, f.target, f.scope), false);
  assert.equal(dropHitsTarget(drop.position, null, f.scope), false);
  f.scope.document.elementFromPoint = () => ({});
  assert.equal(dropHitsTarget(drop.position, f.target, f.scope), false);
  f.dispose();
});

test('native drops pass original file references including images, without upload or content data', async () => {
  const f = fixture(); await tick();
  await f.emit({ type: 'over', position: drop.position });
  assert.equal(f.hover.at(-1), true);
  await f.emit(drop);
  assert.deepEqual(f.files, f.refs);
  assert.equal(f.files[0].data, undefined);
  assert.equal(f.hover.at(-1), false);
  assert.deepEqual(f.calls.map(c => c.command), ['plugin:local-resources|watch_file_drops', 'plugin:local-resources|take_file_drop']);
  assert.deepEqual(f.calls[1].args, { id: 1 });
  f.dispose(); await tick();
  assert.deepEqual(f.calls.at(-1).args, { channelId: 17 });
});

test('outside drops and leave never resolve references; errors never trigger fallback uploads', async () => {
  const f = fixture(async cmd => { if (cmd.endsWith('take_file_drop')) throw new Error('原文件已删除'); });
  await tick();
  await f.emit({ ...drop, position: { x: 0, y: 0 } });
  await f.emit({ type: 'leave' });
  assert.equal(f.calls.length, 1);
  await f.emit(drop);
  assert.equal(f.errors.length, 1);
  assert.equal(f.files.length, 0);
  await f.emit({ ...drop, error: '一次最多引用 256 个文件' });
  assert.equal(f.errors.length, 2);
  assert.equal(f.calls.length, 2);
  f.dispose();
});

test('duplicate in-flight drops and completion after disposal cannot add attachments', async () => {
  let finish;
  const f = fixture(cmd => cmd.endsWith('take_file_drop') ? new Promise(resolve => { finish = resolve; }) : undefined);
  await tick();
  const first = f.emit(drop);
  await f.emit(drop);
  assert.equal(f.calls.filter(c => c.command.endsWith('take_file_drop')).length, 1);
  f.dispose();
  finish(f.refs); await first; await tick();
  assert.equal(f.files.length, 0);
  assert.equal(f.calls.filter(c => c.command.endsWith('unwatch_file_drops')).length, 1);
});

test('dispose during registration unregisters once; web is a no-op; old desktop reports incompatibility', async () => {
  let finish;
  const f = fixture(cmd => cmd.endsWith('|watch_file_drops') ? new Promise(resolve => { finish = resolve; }) : undefined);
  await tick(); f.dispose(); f.dispose(); finish(); await tick();
  assert.equal(f.calls.filter(c => c.command.endsWith('unwatch_file_drops')).length, 1);
  connectDesktopFileDrops({ scope: {}, onError: () => assert.fail('web must not register') })();
  const errors = [];
  connectDesktopFileDrops({ scope: { __TAURI__: { core: { invoke() {} } } }, onError: e => errors.push(e) })();
  assert.equal(errors.length, 1);
});
