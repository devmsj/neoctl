import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { execFileSync } from 'node:child_process';
import { renderXhsEditorPage } from './editor-page.mjs';
import { XhsArtifactRegistry, createOpenXhsArtifactEditorTool, createReadXhsArtifactTool, serveXhsArtifact } from './artifacts.mjs';
const payload = { title: 'title', body: 'body', interaction: '', hashtags: [], images: [{ url: '', caption: 'planned', overlay: '', note: '' }], review: '' };
function fixture(t) { const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xhs-version-')); t.after(() => fs.rmSync(storageDir, { recursive: true, force: true })); return new XhsArtifactRegistry({ storageDir }); }
test('CAS rejects missing/stale versions, independent registries read disk, failed persistence does not publish', t => {
  const a = fixture(t), item = a.add({ payload, sessionId: 's' });
  const b = new XhsArtifactRegistry({ storageDir: a.storageDir }); b.get(item.id, 's');
  assert.throws(() => a.update(item.id, { payload }, 's'), { code: 'version_conflict' });
  a.update(item.id, { payload: { ...payload, body: 'saved' } }, 's', 1);
  assert.equal(b.get(item.id, 's').version, 2);
  assert.throws(() => b.update(item.id, { payload }, 's', 1), { code: 'version_conflict', current_version: 2 });
  a.persist = () => { throw new Error('disk full'); };
  assert.throws(() => a.update(item.id, { payload }, 's', 2), /disk full/);
  assert.equal(a.get(item.id, 's').payload.body, 'saved');
  assert.equal(fs.existsSync(a.artifactFile(item.id) + '.lock'), false);
  assert.equal(a.get(item.id), undefined); assert.equal(a.get(item.id, 'other'), undefined);
});
test('parallel workers never both win same version', async t => {
  for (let round = 0; round < Number(process.env.XHS_CAS_ROUNDS || 1); round++) {
    const registry = fixture(t), item = registry.add({ payload, sessionId: 's' });
    const moduleUrl = new URL('./artifacts.mjs', import.meta.url).href;
    const run = body => new Promise((resolve, reject) => {
      const worker = new Worker(`const {parentPort,workerData}=require('node:worker_threads'); import(workerData.moduleUrl).then(({XhsArtifactRegistry})=>{const r=new XhsArtifactRegistry({storageDir:workerData.dir});try{const a=r.update(workerData.id,{payload:workerData.payload},'s',1);parentPort.postMessage({version:a.version,body:a.payload.body})}catch(e){parentPort.postMessage({code:e.code,message:e.message,syscall:e.syscall,path:e.path,stack:e.stack})}})`, { eval: true, workerData: { moduleUrl, dir: registry.storageDir, id: item.id, payload: { ...payload, body } } }); worker.on('message', resolve); worker.on('error', reject);
    });
    const results = await Promise.all([run('one'), run('two'), run('three'), run('four')]);
    const diagnostic = JSON.stringify({ round, results }, null, 2);
    assert.equal(results.filter(r => r.version === 2).length, 1, diagnostic);
    assert.equal(results.filter(r => ['artifact_busy', 'version_conflict'].includes(r.code)).length, 3, diagnostic);
    assert.equal(registry.get(item.id, 's').payload.body, results.find(r => r.version === 2).body, diagnostic);
    assert.equal(registry.get(item.id, 's').version, 2);
  }
});
test('model cached read binds session/agent/id/version, preserves saved edits and rejects concurrent user save/replay/restart', async t => {
  const registry = fixture(t), context = { session: { sessionId: 's' } };
  const open = createOpenXhsArtifactEditorTool({ registry }), read = createReadXhsArtifactTool({ registry });
  const item = registry.add({ payload, sessionId: 's' });
  await assert.rejects(() => open.execute(open.validate({ artifact_id: item.id, payload }), context), { code: 'read_required' });
  registry.update(item.id, { payload: { ...payload, body: 'user edit' } }, 's', 1);
  let latest = (await read.execute({ id: item.id }, context)).output;
  const input = open.validate({ artifact_id: item.id, payload: { ...latest.artifact.payload, review: 'model review' } });
  await assert.rejects(() => open.execute(input, { session: { sessionId: 'other' } }), { code: 'read_required' });
  await assert.rejects(() => open.execute(input, { ...context, agentId: 'other-agent' }), { code: 'read_required' });
  const other = registry.add({ payload, sessionId: 's' });
  await assert.rejects(() => open.execute(open.validate({ artifact_id: other.id, payload }), context), { code: 'read_required' });
  const updated = await open.execute(input, context); assert.equal(updated.output.artifact.payload.body, 'user edit');
  await assert.rejects(() => open.execute(input, context), { code: 'read_required' });
  latest = (await read.execute({ id: item.id }, context)).output;
  registry.update(item.id, { payload: { ...payload, body: 'new user edit' } }, 's', 3);
  await assert.rejects(() => open.execute(open.validate({ artifact_id: item.id, payload }), context), { code: 'version_conflict' });
  assert.equal(registry.get(item.id, 's').payload.body, 'new user edit');
  await read.execute({ id: item.id }, context);
  registry.readVersions.get(registry.readKey(item.id, context)).expires = 0;
  await assert.rejects(() => open.execute(input, context), { code: 'read_required' });
  const restarted = new XhsArtifactRegistry({ storageDir: registry.storageDir });
  assert.throws(() => restarted.updateFromRead(item.id, { payload }, context), { code: 'read_required' });
});
test('legacy version defaults to 1; HTTP conflict is explicit and isolated', async t => {
  const registry = fixture(t), item = registry.add({ payload, sessionId: 's' });
  const legacy = { ...item }; delete legacy.version; fs.writeFileSync(registry.artifactFile(item.id), JSON.stringify(legacy));
  assert.equal(registry.get(item.id, 's').version, 1);
  let status, body; const res = { writeHead(s) { status = s; }, end(text) { body = JSON.parse(text); } };
  await serveXhsArtifact(registry, { method: 'PUT' }, res, item.id, async () => ({ title: payload.title, payload, expected_version: 0 }), 's');
  assert.equal(status, 409); assert.equal(body.code, 'version_conflict'); assert.equal(body.current_version, 1);
  await serveXhsArtifact(registry, { method: 'GET' }, res, item.id, null, 'other'); assert.equal(status, 404);
  fs.writeFileSync(registry.artifactFile(item.id) + '.lock', 'crashed owner');
  await serveXhsArtifact(registry, { method: 'PUT' }, res, item.id, async () => ({ title: payload.title, payload, expected_version: 1 }), 's');
  assert.equal(status, 423); assert.equal(body.code, 'artifact_busy');
  fs.unlinkSync(registry.artifactFile(item.id) + '.lock');
  registry.update(item.id, { payload }, 's', 1); assert.equal(registry.get(item.id, 's').version, 2);
});

test('editor existing CSS is byte-equivalent to baseline', () => {
  const baseline = execFileSync('git', ['show', 'HEAD:web/plugins/xhs-artifact/editor-page.mjs'], { encoding: 'utf8' });
  const current = renderXhsEditorPage({ id: 'style', payload }, '/api/xhs-artifacts/style');
  assert.equal(current.match(/<style>([\s\S]*?)<\/style>/)[1], baseline.match(/<style>([\s\S]*?)<\/style>/)[1]);
});

test('Windows replacement retries hold CAS lock; exhausted writes are 500 and preserve old JSON', async t => {
  const registry = fixture(t), item = registry.add({ payload, sessionId: 's' });
  const second = new XhsArtifactRegistry({ storageDir: registry.storageDir });
  const originalRename = fs.renameSync;
  let calls = 0;
  try {
    fs.renameSync = (from, to) => {
      calls++;
      assert.equal(registry.get(item.id, 's').version, 1);
      assert.throws(() => second.update(item.id, { payload }, 's', 1), { code: 'artifact_busy' });
      if (calls < 3) throw Object.assign(new Error('injected Windows sharing denial'), { code: 'EPERM' });
      return originalRename(from, to);
    };
    if (process.platform === 'win32') {
      registry.update(item.id, { payload: { ...payload, body: 'committed' } }, 's', 1);
      assert.equal(calls, 3);
      assert.equal(registry.get(item.id, 's').payload.body, 'committed');
    }
  } finally { fs.renameSync = originalRename; }
  const before = registry.get(item.id, 's');
  let status, response;
  const res = { writeHead(value) { status = value; }, end(value) { response = JSON.parse(value); } };
  for (const code of ['EPERM', 'ENOSPC']) {
    calls = 0;
    try {
      fs.renameSync = () => { calls++; throw Object.assign(new Error('injected persistent failure'), { code }); };
      await serveXhsArtifact(registry, { method: 'PUT' }, res, item.id, async () => ({ title: payload.title, payload, expected_version: before.version }), 's');
    } finally { fs.renameSync = originalRename; }
    assert.equal(status, 500);
    assert.equal(response.code, 'artifact_write_failed');
    assert.equal(response.storage_code, code);
    assert.equal(calls, process.platform === 'win32' && code === 'EPERM' ? 21 : 1);
    assert.deepEqual(registry.get(item.id, 's'), before);
    assert.deepEqual(fs.readdirSync(registry.storageDir), [item.id + '.json']);
  }
  registry.update(item.id, { payload }, 's', before.version);
  assert.equal(registry.get(item.id, 's').version, before.version + 1);
});

test('Windows lock open retries remain exclusive and persistent lock denial is not a conflict', async t => {
  const registry = fixture(t), item = registry.add({ payload, sessionId: 's' });
  const originalOpen = fs.openSync;
  let calls = 0;
  try {
    fs.openSync = (name, flags, ...args) => {
      if (flags === 'wx' && String(name).endsWith('.lock') && ++calls < 3) throw Object.assign(new Error('delete-pending lock'), { code: 'EPERM' });
      return originalOpen(name, flags, ...args);
    };
    if (process.platform === 'win32') {
      registry.update(item.id, { payload }, 's', 1);
      assert.equal(calls, 3);
    }
  } finally { fs.openSync = originalOpen; }
  const before = registry.get(item.id, 's');
  let status, response;
  const res = { writeHead(value) { status = value; }, end(value) { response = JSON.parse(value); } };
  try {
    fs.openSync = (name, flags, ...args) => {
      if (flags === 'wx' && String(name).endsWith('.lock')) throw Object.assign(new Error('persistent permission denial'), { code: 'EACCES' });
      return originalOpen(name, flags, ...args);
    };
    await serveXhsArtifact(registry, { method: 'PUT' }, res, item.id, async () => ({ title: payload.title, payload, expected_version: before.version }), 's');
  } finally { fs.openSync = originalOpen; }
  assert.equal(status, 500); assert.equal(response.code, 'artifact_write_failed'); assert.equal(response.storage_code, 'EACCES');
  assert.deepEqual(registry.get(item.id, 's'), before);
  assert.deepEqual(fs.readdirSync(registry.storageDir), [item.id + '.json']);
});
