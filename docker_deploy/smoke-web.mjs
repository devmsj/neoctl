import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { executionFs } from '../engine/dist/execution/filesystem.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = await fs.mkdtemp(path.join(os.tmpdir(), 'neo-web-check-'));
const canary = 'neo-test-not-a-real-api-key';
await fs.writeFile(path.join(data, '.env'), `MODEL_PROVIDER=openai\nOPENAI_API_KEY=${canary}\nOPENAI_MODEL=gpt-5.6\n`);
const app = spawn(process.execPath, ['server.mjs'], { cwd: path.join(root, 'web'), env: { ...process.env,
  HOME: data, NEO_CORE_SOURCE: 'local', NEO_LOCAL_ENGINE_ROOT: path.join(root, 'engine'), NEO_ENV_FILE: path.join(data, '.env'),
  NEO_WEB_DATA_DIR: path.join(data, 'web'), AGENT_SESSION_DIR: path.join(data, 'sessions'), APP_HOST: '127.0.0.1', APP_PORT: '6666',
  NEO_RUNTIME_TARGET: 'http://127.0.0.1:3109', NEO_WEB_BASE_PATH: '/neo/',
}, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
app.stdout.on('data', x => { log += x; });
app.stderr.on('data', x => { log += x; });
// Node fetch follows browser bad-port rules; HTTP testing uses node:http for 6666.
function request(url, method = 'GET', value) {
  return new Promise((resolve, reject) => {
    const payload = value === undefined ? undefined : JSON.stringify(value);
    const req = http.request(`http://127.0.0.1:6666${url}`, { method, headers: payload ? { 'Content-Type': 'application/json' } : {} }, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString() }));
    });
    req.setTimeout(20000, () => req.destroy(new Error('Request timed out')));
    req.on('error', reject); req.end(payload);
  });
}
let cwd;
try {
  let ready = false;
  for (let i = 0; i < 80; i++) {
    if (app.exitCode !== null) throw new Error(log);
    try { if ((await request('/')).status === 200) { ready = true; break; } } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
  assert.ok(ready, log);
  const html = await request('/');
  assert.match(html.text, /\/neo\/assets\//);
  const state = await request('/api/state?tabId=deployment-check');
  assert.equal(state.status, 200, state.text);
  const parsed = JSON.parse(state.text); cwd = parsed.cwd;
  assert.ok(cwd.startsWith('/workspace/'), state.text);
  const login = await request('/api/login?tabId=deployment-check');
  assert.equal(login.status, 200, login.text);
  assert.ok(!login.text.includes(canary), 'API key returned to browser');
  const upload = await request('/api/uploads?tabId=deployment-check', 'POST', { name: 'hello.txt', data: Buffer.from('container upload').toString('base64'), mimeType: 'text/plain' });
  assert.equal(upload.status, 200, upload.text);
  const file = JSON.parse(upload.text).file;
  assert.equal(path.posix.dirname(file.absolutePath), cwd);
  assert.equal(await executionFs.readFile(file.absolutePath, 'utf8'), 'container upload');
  const start = await request('/api/uploads/chunks?tabId=deployment-check', 'POST', { name: 'empty.txt', size: 0, mimeType: 'text/plain' });
  assert.equal(start.status, 200, start.text);
  const finish = await request(`/api/uploads/chunks/${JSON.parse(start.text).uploadId}/complete?tabId=deployment-check`, 'POST');
  assert.equal(finish.status, 200, finish.text);
  const chunkFile = JSON.parse(finish.text).file;
  assert.equal(path.posix.dirname(chunkFile.absolutePath), cwd);
  assert.equal((await executionFs.stat(chunkFile.absolutePath)).size, 0);
  process.env.NEO_CORE_SOURCE = 'local';
  const { openWorkspaceRead } = await import('../web/execution-backend.mjs');
  const handle = await openWorkspaceRead(file.absolutePath);
  try {
    const chunks = [];
    for await (const chunk of handle.createReadStream({ start: 0, end: 8 })) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).toString(), 'container');
  } finally { await handle.close(); }
  const browse = await request('/api/cwd?tabId=deployment-check&path=/');
  assert.equal(browse.status, 200, browse.text);
  console.log('DOCKER_WEB_OK: loopback 6666, /neo assets, state, secret masking, upload to container cwd');
} finally {
  app.kill('SIGTERM');
  await new Promise(resolve => { if (app.exitCode !== null) resolve(); else app.once('exit', resolve); });
  if (cwd?.startsWith('/workspace/')) await executionFs.rm(cwd, { recursive: true, force: true });
  await fs.rm(data, { recursive: true, force: true });
}
