import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { createPlugin } from '../../../plugins/downloads/index.mjs';
import { createLocalResourceHeaders } from '../../../local-resources.mjs';

async function setup(t, helpers = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'downloads-test-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'outside-workspace-'));
  const source = path.join(outside, '中文 [report].txt');
  await fs.writeFile(source, 'original contents');
  const context = { appDataDir: root, env: {} };
  let plugin = createPlugin(context);
  const server = http.createServer(async (req, res) => {
    try { if (!await plugin.route(req, res, new URL(req.url, 'http://localhost'), helpers)) { res.statusCode = 404; res.end(); } }
    catch (error) { res.statusCode = 500; res.end(error.message); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); await fs.rm(root, { recursive: true, force: true }); await fs.rm(outside, { recursive: true, force: true }); });
  return { root, outside, source, plugin, base: `http://127.0.0.1:${server.address().port}`, restart() { plugin = createPlugin(context); } };
}

test('arbitrary outside-workspace file: only metadata stored, no copies, no expiry', async (t) => {
  const f = await setup(t);
  const result = await f.plugin.tools[0].execute({ paths: [f.source] }, { cwd: f.root });
  assert.equal(result.ok, true);
  const d = result.output.downloads[0];
  assert.equal(d.expiresAt, null); assert.equal(d.expiresAtEpochMs, null);
  assert.equal(result.output._ui.resources[0].expiresAt, undefined);
  const storedDir = path.join(f.root, 'downloads', d.id);
  assert.deepEqual(await fs.readdir(storedDir), ['entry.json']);
  const record = JSON.parse(await fs.readFile(path.join(storedDir, 'entry.json'), 'utf8'));
  assert.equal(record.absolutePath, f.source);
  const r = await fetch(f.base + d.url);
  assert.equal(r.status, 200); assert.match(r.headers.get('content-disposition'), /^attachment;/);
  assert.equal(await r.text(), 'original contents');
  const head = await fetch(f.base + d.url, { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(head.headers.get('content-length'), '17'); assert.equal(await head.text(), '');
});

test('mapping survives restart and future clock; serves current original bytes and length', async (t) => {
  const f = await setup(t), d = (await f.plugin.tools[0].execute({ paths: [f.source] })).output.downloads[0];
  const script = `import { DownloadRegistry } from ${JSON.stringify(new URL('../../../plugins/downloads/downloads.mjs', import.meta.url).href)}; Date.now = () => 9999999999999; const e = await new DownloadRegistry({ storageDir: ${JSON.stringify(path.join(f.root, 'downloads'))} }).get(${JSON.stringify(d.id)}); if (!e || e.expiresAt !== null) process.exit(1); console.log(e.id);`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  f.restart();
  await fs.writeFile(f.source, 'updated longer original contents');
  const r = await fetch(f.base + d.url); assert.equal(r.status, 200); assert.equal(r.headers.get('content-length'), '32'); assert.equal(await r.text(), 'updated longer original contents');
});

test('moving or deleting the original invalidates the link, no fallback copy', async (t) => {
  const f = await setup(t), d = (await f.plugin.tools[0].execute({ paths: [f.source] })).output.downloads[0];
  const moved = path.join(f.outside, 'moved.txt');
  await fs.rename(f.source, moved);
  const missing = await fetch(f.base + d.url); assert.equal(missing.status, 404); await missing.text();
  f.restart(); const afterRestart = await fetch(f.base + d.url); assert.equal(afterRestart.status, 404); await afterRestart.text();
  const next = (await f.plugin.tools[0].execute({ paths: [moved] })).output.downloads[0];
  await fs.rm(moved);
  const deleted = await fetch(f.base + next.url); assert.equal(deleted.status, 404); await deleted.text();
});

test('invalid paths, directories, missing files, malformed URLs and HTTP writes are rejected', async (t) => {
  const f = await setup(t), tool = f.plugin.tools[0];
  for (const paths of [[], ['relative'], [null], Array(21).fill(f.source)]) assert.throws(() => tool.validate({ paths }));
  const result = await tool.execute({ paths: [f.source, f.outside, path.join(f.outside, 'absent')] });
  assert.equal(result.ok, false); assert.equal(result.output.errors.length, 2); assert.equal(result.output.downloads.length, 1);
  const d = result.output.downloads[0];
  for (const suffix of ['%2e%2e%2fsecret', 'bad%', 'a'.repeat(36), d.id + '/extra']) {
    const r = await fetch(f.base + '/api/downloads/' + suffix); assert.equal(r.status, 404); await r.text();
  }
  const post = await fetch(f.base + d.url, { method: 'POST' }); assert.equal(post.status, 405); await post.text();
});

test('optional host capability resolves existing links without copies and disappears with missing source', async t => {
  const f = await setup(t, { localResourceHeaders: createLocalResourceHeaders({ enabled: true }) });
  const d = (await f.plugin.tools[0].execute({ paths: [f.source] })).output.downloads[0];
  f.restart(); // Also works for links already saved before a runtime restart.
  const init = { method: 'HEAD', headers: { 'X-Neo-Resource-Action': 'reveal' } };
  const result = await fetch(f.base + d.url, init);
  assert.equal(result.status, 200);
  assert.equal(decodeURIComponent(result.headers.get('x-neo-resource-path')), f.source);
  assert.equal(await result.text(), '');
  for (const options of [{ method: 'HEAD' }, { headers: init.headers }]) {
    const ordinary = await fetch(f.base + d.url, options);
    assert.equal(ordinary.headers.get('x-neo-resource-path'), null);
    await ordinary.text();
  }
  assert.deepEqual(await fs.readdir(path.join(f.root, 'downloads', d.id)), ['entry.json']);
  await fs.rm(f.source);
  const missing = await fetch(f.base + d.url, init);
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get('x-neo-resource-path'), null);
});

test('without the optional helper, the plugin remains independently usable and does not disclose paths', async t => {
  const f = await setup(t);
  const d = (await f.plugin.tools[0].execute({ paths: [f.source] })).output.downloads[0];
  const result = await fetch(f.base + d.url, { method: 'HEAD', headers: { 'X-Neo-Resource-Action': 'reveal' } });
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('x-neo-resource-path'), null);
});

test('concurrent exposure persists separate tiny mappings', async (t) => {
  const f = await setup(t);
  const results = await Promise.all(Array.from({ length: 8 }, () => f.plugin.tools[0].execute({ paths: [f.source] })));
  const ids = results.map((r) => r.output.downloads[0].id);
  assert.equal(new Set(ids).size, 8);
  for (const id of ids) assert.deepEqual(await fs.readdir(path.join(f.root, 'downloads', id)), ['entry.json']);
});
