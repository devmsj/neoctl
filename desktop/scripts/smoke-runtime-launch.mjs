#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtime = (await readFile(path.join(desktopRoot, '.smoke-runtime-path'), 'utf8')).trim();
const data = path.join(runtime, 'desktop-data');
await mkdir(path.join(data, 'workspaces'), { recursive: true });
const webPort = await freePort();
const corePort = await freePort();
const node = path.join(desktopRoot, 'resources', 'node', 'node.exe');
const server = path.join(runtime, 'node_modules', 'neoctl-web', 'server.mjs');
const child = spawn(node, [server], {
  cwd: data,
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    APP_HOST: '127.0.0.1',
    APP_PORT: String(webPort),
    NEO_RUNTIME_TARGET: `http://127.0.0.1:${corePort}`,
    NEO_EMBED_RUNTIME: 'true',
    NEO_CORE_SOURCE: 'package',
    NEO_WEB_DATA_DIR: data,
    NEO_WORKSPACE_ROOT: path.join(data, 'workspaces'),
    AGENT_VENDOR_DIR: path.join(runtime, 'node_modules', 'neoctl-web', 'node_modules', 'neoctl'),
  },
});
let output = '';
child.stdout.on('data', (chunk) => { output += chunk; });
child.stderr.on('data', (chunk) => { output += chunk; });
try {
  const response = await waitFor(`http://127.0.0.1:${webPort}/api/client-info`, 45_000);
  if (!response.ok) throw new Error(`health endpoint returned ${response.status}`);
  const info = await response.json();
  console.log(`[smoke] runtime healthy on ${webPort}; core=${info.coreVersion || info.core || 'ready'}`);
} catch (error) {
  throw new Error(`${error.message}\n${output}`);
} finally {
  await stopProcessTree(child);
  await rm(runtime, { recursive: true, force: true }).catch(() => {});
  await rm(path.join(desktopRoot, '.smoke-runtime-path'), { force: true }).catch(() => {});
}

function stopProcessTree(child) {
  if (!child.pid) return Promise.resolve();
  if (process.platform !== 'win32') {
    child.kill();
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
    killer.once('exit', resolve);
    killer.once('error', () => { child.kill(); resolve(); });
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function waitFor(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try { return await fetch(url); } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  throw lastError || new Error('runtime start timed out');
}
