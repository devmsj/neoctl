import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { createPlugin } from '../../../plugins/video-share/index.mjs';
import { VideoStore } from '../../../plugins/video-share/store.mjs';
import { parseRange, playerPage } from '../../../plugins/video-share/http.mjs';

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'video-share-test-'));
  const source = path.join(root, '样例 video.mp4');
  const bytes = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(1024, 7)]);
  await fs.writeFile(source, bytes);
  const context = { appDataDir: path.join(root, 'data'), env: {} };
  let plugin = createPlugin(context);
  const server = http.createServer(async (req, res) => {
    try { if (!await plugin.route(req, res, new URL(req.url, 'http://localhost'))) { res.statusCode = 404; res.end(); } }
    catch (error) { res.statusCode = 500; res.end(error.message); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); await fs.rm(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { root, source, bytes, context, base, plugin, restart() { plugin = createPlugin(context); return plugin; } };
}

function expose(plugin, paths) { return plugin.tools.find((t) => t.name === 'expose_videos').execute({ paths }); }

test('standalone publication, player, inline media and HEAD work without host imports', async (t) => {
  const f = await setup(t);
  const result = await expose(f.plugin, [f.source]);
  assert.equal(result.ok, true);
  const v = result.output.videos[0];
  assert.equal(v.expiresAt, null);
  assert.equal(result.output._ui.resources[0].kind, 'embed');
  assert.equal(result.output._ui.presentationLevel, 'primary');
  assert.equal(v.markdown, undefined);
  assert.equal(v.reference, undefined);
  assert.equal(result.output._ui.resources[0].downloadName, undefined);
  const page = await fetch(f.base + v.url);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /default-src 'none'/);
  assert.match(await page.text(), /<video controls playsinline preload="metadata"/);
  const media = await fetch(f.base + v.mediaUrl);
  assert.equal(media.headers.get('content-type'), 'video/mp4');
  assert.match(media.headers.get('content-disposition'), /^inline;/);
  assert.equal(media.headers.get('accept-ranges'), 'bytes');
  assert.deepEqual(Buffer.from(await media.arrayBuffer()), f.bytes);
  const head = await fetch(f.base + v.mediaUrl, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(Number(head.headers.get('content-length')), f.bytes.length);
  assert.equal((await head.arrayBuffer()).byteLength, 0);
});

test('byte range seeking: bounded, open-ended, suffix, clamped, invalid, If-Range', async (t) => {
  const f = await setup(t), v = (await expose(f.plugin, [f.source])).output.videos[0];
  for (const [range, start, end] of [['bytes=2-9', 2, 9], ['bytes=1000-', 1000, f.bytes.length - 1], ['bytes=-9', f.bytes.length - 9, f.bytes.length - 1], ['bytes=2-999999', 2, f.bytes.length - 1]]) {
    const r = await fetch(f.base + v.mediaUrl, { headers: { Range: range } });
    assert.equal(r.status, 206);
    assert.equal(r.headers.get('content-range'), `bytes ${start}-${end}/${f.bytes.length}`);
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), f.bytes.subarray(start, end + 1));
  }
  for (const range of ['bytes=99999-', 'bytes=4-2', 'bytes=-0', 'bytes=-', 'bytes=x-y']) {
    const r = await fetch(f.base + v.mediaUrl, { headers: { Range: range } });
    assert.equal(r.status, 416); assert.equal(r.headers.get('content-range'), `bytes */${f.bytes.length}`); await r.text();
  }
  for (const headers of [{ Range: 'bytes=0-1,4-5' }, { Range: 'bytes=0-2', 'If-Range': '"stale"' }]) {
    const r = await fetch(f.base + v.mediaUrl, { headers }); assert.equal(r.status, 200); await r.arrayBuffer();
  }
  const full = await fetch(f.base + v.mediaUrl); const etag = full.headers.get('etag'); await full.arrayBuffer();
  const r = await fetch(f.base + v.mediaUrl, { headers: { Range: 'bytes=0-1', 'If-Range': etag } });
  assert.equal(r.status, 206); await r.arrayBuffer();
  assert.equal(parseRange('bytes=0-0', 0), false);
});

test('zero-copy original-path mapping survives restart and a fresh Node process without TTL', async (t) => {
  const f = await setup(t), v = (await expose(f.plugin, [f.source])).output.videos[0];
  const recordDir = path.join(f.context.appDataDir, 'video-share', v.id);
  assert.deepEqual(await fs.readdir(recordDir), ['entry.json']);
  const record = JSON.parse(await fs.readFile(path.join(recordDir, 'entry.json'), 'utf8'));
  assert.equal(record.absolutePath, f.source);
  f.restart();
  const r = await fetch(f.base + v.mediaUrl); assert.equal(r.status, 200); assert.deepEqual(Buffer.from(await r.arrayBuffer()), f.bytes);
  const script = `import { VideoStore } from ${JSON.stringify(new URL('../../../plugins/video-share/store.mjs', import.meta.url).href)}; Date.now = () => 9999999999999; const e = await new VideoStore(${JSON.stringify(path.join(f.context.appDataDir, 'video-share'))}).get(${JSON.stringify(v.id)}); if (!e || 'expiresAt' in e) process.exit(1); console.log(e.id);`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr); assert.match(child.stdout, new RegExp(v.id));
});

test('revoke persists across restarts; guessing, traversal, writes and missing blobs fail closed', async (t) => {
  const f = await setup(t), v = (await expose(f.plugin, [f.source])).output.videos[0];
  for (const suffix of ['f'.repeat(48), '%2e%2e%2fsecret', v.id + '/media/extra']) {
    const r = await fetch(f.base + '/api/video-share/' + suffix); assert.equal(r.status, 404); await r.text();
  }
  const post = await fetch(f.base + v.url, { method: 'POST' }); assert.equal(post.status, 405); await post.text();
  const revoke = f.plugin.tools.find((t) => t.name === 'revoke_videos');
  assert.equal((await revoke.execute({ ids: [v.id] })).output.results[0].revoked, true);
  assert.equal((await revoke.execute({ ids: [v.id] })).output.results[0].revoked, false);
  f.restart(); const gone = await fetch(f.base + v.mediaUrl); assert.equal(gone.status, 404); await gone.text();
  assert.equal((await fs.stat(f.source)).isFile(), true);
  const next = (await expose(f.plugin, [f.source])).output.videos[0];
  await fs.rm(f.source);
  const missing = await fetch(f.base + next.mediaUrl); assert.equal(missing.status, 404); await missing.text();
});

test('validation, partial batches, signatures, escaping and public origin', async (t) => {
  const f = await setup(t), tool = f.plugin.tools[0];
  for (const paths of [[], ['relative.mp4'], [12], Array(21).fill(f.source)]) assert.throws(() => tool.validate({ paths }));
  const fake = path.join(f.root, 'fake.mp4'); await fs.writeFile(fake, '<script>not video</script>');
  const result = await expose(f.plugin, [f.source, fake, path.join(f.root, 'a.txt')]);
  assert.equal(result.ok, false); assert.equal(result.output.videos.length, 1); assert.equal(result.output.errors.length, 2);
  const html = playerPage({ filename: '<script>alert(1)</script>', id: 'a'.repeat(48) });
  assert.ok(!html.includes('<script>')); assert.match(html, /&lt;script&gt;/);
  const publicPlugin = createPlugin({ ...f.context, env: { NEO_VIDEO_SHARE_PUBLIC_ORIGIN: 'https://videos.example.com' } });
  const v = (await expose(publicPlugin, [f.source])).output.videos[0];
  assert.ok(v.url.startsWith('https://videos.example.com/api/video-share/')); assert.equal(v.reference, undefined);
  assert.ok((await expose(publicPlugin, [f.source])).output._ui.resources[0].url.startsWith('/api/video-share/'));
  assert.throws(() => createPlugin({ env: { NEO_VIDEO_SHARE_PUBLIC_ORIGIN: 'https://host/path' } }));
});

test('concurrent publishers use independent atomic records', async (t) => {
  const f = await setup(t);
  const store = new VideoStore(path.join(f.context.appDataDir, 'video-share'));
  const entries = await Promise.all(Array.from({ length: 8 }, () => store.publish(f.source)));
  assert.equal(new Set(entries.map((e) => e.id)).size, 8);
  for (const e of entries) assert.equal((await store.get(e.id)).id, e.id);
  assert.ok((await fs.readdir(store.directory)).every((s) => !s.startsWith('.pending')));
});

test('source move invalidates player and media after restart, no fallback copy', async (t) => {
  const f = await setup(t), v = (await expose(f.plugin, [f.source])).output.videos[0];
  await fs.rename(f.source, path.join(f.root, 'moved.mp4'));
  f.restart();
  for (const url of [v.url, v.mediaUrl]) {
    const r = await fetch(f.base + url); assert.equal(r.status, 404); await r.text();
  }
  assert.deepEqual(await fs.readdir(path.join(f.context.appDataDir, 'video-share', v.id)), ['entry.json']);
});

test('same-path updates serve current bytes and invalidate old If-Range validators', async (t) => {
  const f = await setup(t), v = (await expose(f.plugin, [f.source])).output.videos[0];
  const before = await fetch(f.base + v.mediaUrl); const oldTag = before.headers.get('etag'); await before.arrayBuffer();
  const updated = Buffer.from(f.bytes); updated[100] = 42;
  await fs.writeFile(f.source, updated);
  await fs.utimes(f.source, new Date(), new Date(Date.now() + 5000));
  const r = await fetch(f.base + v.mediaUrl, { headers: { Range: 'bytes=0-9', 'If-Range': oldTag } });
  assert.equal(r.status, 200); assert.notEqual(r.headers.get('etag'), oldTag);
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), updated);
});

test('v1 copied publications are not silently used as zero-copy sources', async (t) => {
  const f = await setup(t), id = 'a'.repeat(48);
  const dir = path.join(f.context.appDataDir, 'video-share', id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'entry.json'), JSON.stringify({ version: 1, id, filename: 'old.mp4', contentType: 'video/mp4' }));
  await fs.writeFile(path.join(dir, 'media'), f.bytes);
  const r = await fetch(f.base + '/api/video-share/' + id + '/media'); assert.equal(r.status, 404); await r.text();
  assert.deepEqual(await fs.readFile(path.join(dir, 'media')), f.bytes); // no automatic user-data deletion
});

test('presenter embeds valid videos including partial failures and historical results, no text links', async (t) => {
  const f = await setup(t);
  const result = await expose(f.plugin, [f.source, path.join(f.root, 'missing.mp4')]);
  assert.equal(result.ok, false);
  const shown = f.plugin.presentToolResult({ toolName: 'expose_videos', output: result.output, ok: false });
  assert.equal(shown.presentationLevel, 'primary');
  assert.equal(shown.resources.length, 1);
  assert.equal(shown.resources[0].kind, 'embed');
  assert.match(shown.resources[0].url, /\?embed=1$/);
  assert.ok(!shown.text.includes('/api/'));
  assert.match(result.output.usage, /Do not repeat video URLs/);
  const old = { videos: [{ ...result.output.videos[0], url: 'https://untrusted.example/', markdown: '[old](https://untrusted.example/)' }] };
  assert.ok(f.plugin.presentToolResult({ toolName: 'expose_videos', output: old, ok: true }).resources[0].url.startsWith('/api/video-share/'));
  assert.equal(f.plugin.presentToolResult({ toolName: 'revoke_videos', output: result.output }), undefined);
  assert.equal(f.plugin.presentToolResult({ toolName: 'expose_videos', output: { videos: [{ id: '../escape' }] } }), undefined);
  const page = await fetch(f.base + shown.resources[0].url + '&theme=light');
  const html = await page.text();
  assert.equal(page.status, 200); assert.match(html, /data-theme="light"/);
  assert.ok(!/<a\b|target=|window\.open/.test(html));
  assert.match(html, /<video controls playsinline/);
});
