import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const webRoot = fileURLToPath(new URL('../', import.meta.url));
async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

// Real child process: an unhandled proxy rejection must not be masked by the test runner.
test('upstream failures stay request-local; HTTP and SSE disconnects never kill the web process', { timeout: 30_000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'neo-proxy-failure-'));
  let mode = 'reset', child, log = '', postCalls = 0;
  const upstream = http.createServer((req, res) => {
    if (req.method === 'POST') postCalls++;
    if (mode === 'reset') { req.socket.resetAndDestroy(); return; }
    if (mode === 'partial' || mode === 'sse-partial') {
      res.writeHead(200, { 'Content-Type': mode === 'partial' ? 'application/json' : 'text/event-stream' });
      res.write(mode === 'partial' ? '{"session":' : 'data: {"ready":true}\n\n');
      setTimeout(() => req.socket.resetAndDestroy(), 50);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ session: { sessionId: 'recovered' } }));
  });
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) { const done=once(child,'exit'); child.kill(); await done; }
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });
  const upstreamPort = await listen(upstream);
  const reservation = http.createServer();
  const port = await listen(reservation);
  await new Promise(resolve => reservation.close(resolve));
  await fs.mkdir(path.join(root, 'dist'));
  await fs.writeFile(path.join(root, 'dist', 'index.html'), '<title>proxy fixture</title>');
  await fs.writeFile(path.join(root, 'isolation.json'), '{"enabled":false}');
  child = spawn(process.execPath, ['server.mjs', '--core', 'local'], {
    cwd: webRoot,
    env: { ...process.env, APP_HOST: '127.0.0.1', APP_PORT: String(port), DIST_DIR: path.join(root, 'dist'),
      NEO_EXECUTION_BACKEND: 'local', NEO_CORE_SOURCE: 'local', NEO_EMBED_RUNTIME: 'false',
      NEO_RUNTIME_TARGET: `http://127.0.0.1:${upstreamPort}`, NEO_WEB_DATA_DIR: root,
      NEO_WORKSPACE_ROOT: path.join(root, 'work'), NEO_WEB_PLUGINS: 'none',
      NEO_ISOLATION_CONFIG: path.join(root, 'isolation.json'), HOME: root, USERPROFILE: root,
    }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', data => { log += data; });
  child.stderr.on('data', data => { log += data; });
  const ready = `neo web listening on http://127.0.0.1:${port}, dist=`;
  for (let i=0; i<100 && !log.includes(ready) && child.exitCode===null; i++) await delay(50);
  assert.ok(log.includes(ready), log);
  const request = route => fetch(`http://127.0.0.1:${port}${route}`, { signal: AbortSignal.timeout(3000) });
  const alive = async () => {
    assert.equal(child.exitCode, null, log);
    assert.equal(await (await request('/')).text(), '<title>proxy fixture</title>');
    assert.equal((await request('/api/memory')).status, 200);
  };
  for (let i=0; i<3; i++) {
    let response;
    try { response=await request('/api/state?tabId=reset'); } catch (error) { await delay(100); assert.fail(`${error}\n${log}`); }
    assert.equal(response.status, 502);
    assert.equal((await response.json()).errorCode, 'RUNTIME_UNAVAILABLE');
    await alive();
  }
  const failedPost = await fetch(`http://127.0.0.1:${port}/api/submit`, {
    method: 'POST', body: JSON.stringify({ text: 'must not replay' }), signal: AbortSignal.timeout(3000),
  });
  assert.equal(failedPost.status, 502);
  await failedPost.json();
  assert.equal(postCalls, 1, 'failed mutating requests must not be replayed');
  await alive();
  for (const partial of ['partial', 'sse-partial']) {
    mode=partial;
    const response=await request(partial==='partial' ? '/api/state' : '/events');
    assert.equal(response.status, 200);
    let failure;
    try { await response.text(); } catch (error) { failure=error; }
    assert.ok(failure, 'a truncated upstream body must not look like a completed success');
    assert.notEqual(failure.name, 'TimeoutError', 'close the failed stream promptly instead of leaving it hanging');
    await alive();
  }
  mode='healthy';
  assert.equal((await (await request('/api/state')).json()).session.sessionId, 'recovered');
  await alive();
  upstream.closeAllConnections();
  await new Promise(resolve => upstream.close(resolve));
  const unavailable = await request('/api/state');
  assert.equal(unavailable.status, 502);
  const error = await unavailable.json();
  assert.equal(error.errorCode, 'RUNTIME_UNAVAILABLE');
  assert.equal(error.cause, 'ECONNREFUSED');
  await alive();
});
