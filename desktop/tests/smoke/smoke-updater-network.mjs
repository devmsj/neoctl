// Opt-in real npm/HTTP integration. Never reads or modifies an installed desktop config.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const exe = process.env.NEO_TEST_UPDATER || path.join(desktop, 'resources/updater/neoctl-updater.exe');
const root = await mkdtemp(path.join(tmpdir(), 'neo-network-updater-'));
const children = new Set();
const expectedWeb = JSON.parse(await readFile(path.join(desktop, '../web/package.json'), 'utf8')).version;
const expectedCore = JSON.parse(await readFile(path.join(desktop, '../engine/package.json'), 'utf8')).version;
const delegationTools = ['subagent_run', 'subagent_output', 'subagent_list', 'subagent_get', 'subagent_stop', 'subagent_message', 'subagent_resume'];
async function stop(child) {
  if (!child || child.exitCode !== null) return;
  const done = new Promise(resolve => child.once('exit', resolve));
  const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
  await new Promise(resolve => { killer.once('exit', resolve); killer.once('error', () => { child.kill(); resolve(); }); });
  await done; children.delete(child);
}
async function freePort() {
  const s = net.createServer();
  await new Promise((resolve, reject) => { s.once('error', reject); s.listen(0, '127.0.0.1', resolve); });
  const port = s.address().port; await new Promise(resolve => s.close(resolve)); return port;
}
async function healthy(candidate, versions) {
  assert.equal(versions.web_version, expectedWeb, 'installed Web must match the release');
  assert.equal(versions.core_version, expectedCore, 'installed Core must match the release');
  const release = path.join(root, 'releases', candidate);
  const data = path.join(root, 'data');
  const port = await freePort(), corePort = await freePort();
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(NODE_|NPM_|NVM_|APP_|NEO_|AGENT_|MODEL_|OPENAI_|ANTHROPIC_)/i.test(key)));
  Object.assign(env, { APP_HOST: '127.0.0.1', APP_PORT: String(port), NEO_RUNTIME_TARGET: `http://127.0.0.1:${corePort}`, NEO_EMBED_RUNTIME: 'true', NEO_CORE_SOURCE: 'package', NEO_WEB_DATA_DIR: data, NEO_WORKSPACE_ROOT: path.join(data, 'workspaces'), AGENT_VENDOR_DIR: path.join(release, 'node_modules/neoctl-web/node_modules/neoctl') });
  const child = spawn(path.join(release, 'node/node.exe'), [path.join(release, 'node_modules/neoctl-web/server.mjs')], { cwd: data, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child); let output = '';
  child.stdout.on('data', x => output = (output + x).slice(-12000));
  child.stderr.on('data', x => output = (output + x).slice(-12000));
  try {
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`backend exited: ${output}`);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/client-info`, { signal: AbortSignal.timeout(2000) });
        if (response.ok) {
          const info = await response.json();
          assert.equal(info.coreVersion, versions.core_version);
          const toolsResponse = await fetch(`http://127.0.0.1:${port}/api/tools`, { signal: AbortSignal.timeout(2000) });
          assert.equal(toolsResponse.status, 200);
          const tools = await toolsResponse.json();
          for (const name of delegationTools) {
            const tool = tools.items.find(item => item.name === name);
            assert.ok(tool, `missing configurable tool ${name}`);
            assert.equal(tool.configuredEnabled, false, `${name} must default off`);
          }
          console.log(`PASS HTTP health Web=${versions.web_version} Core=${info.coreVersion}; all seven delegation tools default off`);
          return;
        }
      } catch (error) { if (error?.code === 'ERR_ASSERTION') throw error; }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error(`health timeout: ${output}`);
  } finally { await stop(child); }
}
async function update(source) {
  const child = spawn(exe, ['prepare', root, path.join(desktop, 'resources'), source], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  children.add(child);
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  let last, failure, stderr = '';
  child.stderr.on('data', x => stderr = (stderr + x).slice(-10000));
  const timer = setTimeout(() => void stop(child), 1500000);
  try {
    for await (const line of createInterface({ input: child.stdout })) {
      const event = JSON.parse(line); last = event;
      if (event.event === 'log') console.log(event.message);
      if (event.event === 'ready') {
        try { await healthy(event.candidate, event.versions); child.stdin.end('commit\n'); }
        catch (error) { failure = error; child.stdin.end('abort\n'); }
      }
    }
    const code = await exited; children.delete(child);
    if (failure) throw failure;
    assert.equal(code, 0, JSON.stringify(last) + stderr);
    assert.equal(last.event, 'done'); assert.deepEqual(last.warnings, []);
    const pointer = JSON.parse(await readFile(path.join(root, '.neo-updater/current.json')));
    assert.deepEqual((await readdir(path.join(root, 'releases'))).filter(x => x !== '.neo-owned'), [pointer.release]);
    return pointer.release;
  } finally { clearTimeout(timer); await stop(child); }
}
try {
  await mkdir(path.join(root, 'data/workspaces'), { recursive: true });
  await writeFile(path.join(root, 'data/session-fixture.txt'), 'preserve');
  const first = await update('bundled');
  const second = await update('latest');
  assert.notEqual(first, second);
  assert.equal(await readFile(path.join(root, 'data/session-fixture.txt'), 'utf8'), 'preserve');
  console.log('PASS real updater bundled install + registry update + Core HTTP health + old-version deletion + data preservation');
} finally {
  for (const child of children) await stop(child);
  await rm(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 500 });
}
