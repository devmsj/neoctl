// Fully offline protocol integration test. Only creates/removes its own temporary root.
import { mkdtemp, mkdir, copyFile, cp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import assert from 'node:assert/strict';
const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const exe = process.env.NEO_TEST_UPDATER || path.join(desktop, 'src-tauri/target/debug/neoctl-updater.exe');
const base = await mkdtemp(path.join(tmpdir(), 'neo-updater-protocol-'));
const root = path.join(base, 'app'), resources = path.join(base, 'resources');
let blocker;
const fixtureNpm = `const fs=require('fs'),p=require('path');const root=process.cwd();const web=p.join(root,'node_modules/neoctl-web');const core=p.join(web,'node_modules/neoctl');fs.mkdirSync(core,{recursive:true});fs.writeFileSync(p.join(web,'package.json'),JSON.stringify({name:'neoctl-web',version:'1.0.0',dependencies:{neoctl:'^2.0.0'}}));fs.writeFileSync(p.join(core,'package.json'),JSON.stringify({name:'neoctl',version:'2.0.0'}));fs.writeFileSync(p.join(web,'server.mjs'),'// isolated protocol test fixture');`;
async function invoke(operation, onReady) {
  const child = spawn(exe, [operation, root, resources, 'bundled'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code) => resolve(code)); });
  let stderr = '', last, failure;
  child.stderr.on('data', chunk => stderr += chunk);
  const timer = setTimeout(() => child.kill(), 60000);
  try {
    for await (const line of createInterface({ input: child.stdout })) {
      const event = JSON.parse(line); last = event;
      if (event.event === 'ready') {
        try { child.stdin.end(`${await onReady(event)}\n`); }
        catch (error) { failure = error; child.stdin.end('abort\n'); }
      }
    }
    const code = await exited;
    if (failure) throw failure;
    assert.equal(code, 0, JSON.stringify(last) + stderr);
    return last;
  } finally { clearTimeout(timer); }
}
try {
  await mkdir(root, { recursive: true });
  await mkdir(path.join(resources, 'node/node_modules/npm/bin'), { recursive: true });
  await mkdir(path.join(resources, 'payload'), { recursive: true });
  await copyFile(path.join(desktop, 'resources/node/node.exe'), path.join(resources, 'node/node.exe'));
  await cp(path.join(desktop, 'resources/node/node_modules/npm/node_modules/semver'), path.join(resources, 'node/node_modules/npm/node_modules/semver'), { recursive: true });
  await writeFile(path.join(resources, 'node/node_modules/npm/bin/npm-cli.js'), fixtureNpm);
  await writeFile(path.join(resources, 'payload/neoctl-web.tgz'), 'offline fixture npm does not unpack');
  await mkdir(path.join(root, 'data'), { recursive: true });
  await writeFile(path.join(root, 'data/session.txt'), 'preserve session');
  let first;
  const initial = await invoke('prepare', async event => { first = event.candidate; return 'commit'; });
  assert.deepEqual(initial.warnings, []);
  assert.equal(JSON.parse(await readFile(path.join(root, '.neo-updater/current.json'))).release, first);
  const oldNode = path.join(root, 'releases', first, 'node/node.exe');
  blocker = spawn(oldNode, ['-e', "console.log('ready');setInterval(()=>{},1000)"], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise((resolve, reject) => { blocker.stdout.once('data', resolve); blocker.once('error', reject); });
  let second;
  const updated = await invoke('prepare', async event => { second = event.candidate; assert.notEqual(second, first); return 'commit'; });
  assert.ok(updated.warnings.length > 0, 'occupied old Node must produce cleanup warning');
  assert.equal(JSON.parse(await readFile(path.join(root, '.neo-updater/current.json'))).release, second);
  assert.ok(existsSync(oldNode), 'locked old version retained only until lock release');
  const stopped = new Promise(resolve => blocker.once('exit', resolve)); blocker.kill(); await stopped; blocker = null;
  const clean = await invoke('cleanup');
  assert.deepEqual(clean.warnings, []);
  assert.equal(existsSync(path.join(root, 'releases', first)), false);
  assert.deepEqual((await readdir(path.join(root, 'releases'))).filter(x => x !== '.neo-owned'), [second]);
  const abort = await invoke('prepare', async () => 'abort');
  assert.equal(abort.event, 'aborted');
  assert.equal(JSON.parse(await readFile(path.join(root, '.neo-updater/current.json'))).release, second);
  assert.deepEqual((await readdir(path.join(root, 'releases'))).filter(x => x !== '.neo-owned'), [second]);
  assert.equal(await readFile(path.join(root, 'data/session.txt'), 'utf8'), 'preserve session');
  console.log('PASS: independent updater commit, occupied-old-version warning, verified deletion retry, abort recovery, single-version retention, data preservation');
} finally {
  if (blocker) { const stopped = new Promise(resolve => blocker.once('exit', resolve)); blocker.kill(); await stopped; }
  await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
