import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { dockerRun, dockerArgs, verifyDockerBackend } from '../engine/dist/execution/docker.js';
import { executionFs as files } from '../engine/dist/execution/filesystem.js';
import { executionLaunch } from '../engine/dist/execution/process.js';

if (process.env.NEO_EXECUTION_BACKEND !== 'docker') throw new Error('Set NEO_EXECUTION_BACKEND=docker');
await verifyDockerBackend();
const hostDir = await fs.mkdtemp(path.join(os.tmpdir(), 'neo-host-canary-'));
const canary = path.join(hostDir, 'secret.txt');
const work = `/workspace/backend-test-${Date.now()}`;
await fs.writeFile(canary, 'host-only-canary');
process.env.NEO_CANARY_SECRET = 'never-in-container';
async function command(text, env = {}, interact) {
  const launch = executionLaunch('bash', ['-c', text], work, env);
  const child = spawn(launch.file, launch.args, { cwd: launch.cwd, env: launch.env, stdio: 'pipe' });
  let stdout = '', stderr = '';
  child.stdout.on('data', value => { stdout += value; });
  child.stderr.on('data', value => { stderr += value; });
  const done = once(child, 'close');
  const timer = setTimeout(() => { launch.signal('SIGKILL'); child.kill(); }, 20_000);
  try {
    if (interact) await interact(child, launch);
    else child.stdin.end();
    const [code] = await done;
    return { code, stdout, stderr };
  } finally { clearTimeout(timer); }
}
try {
  await files.mkdir(work, { recursive: true });
  await files.writeFile(`${work}/test.txt`, 'alpha\nbeta\n');
  assert.equal(await files.readFile(`${work}/test.txt`, 'utf8'), 'alpha\nbeta\n');
  assert.equal((await files.stat(`${work}/test.txt`)).isFile(), true);
  assert.equal((await files.readdir(work, { withFileTypes: true }))[0].isFile(), true);
  await assert.rejects(files.readFile(canary));
  const result = await command('id -u; pwd; printf "%s" "${NEO_CANARY_SECRET-unset}"; test ! -S /var/run/docker.sock');
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^0\n/);
  assert.ok(result.stdout.includes(work));
  assert.match(result.stdout, /unset/);
  const customEnv = await command('printf "%s" "$TEST"', { TEST: 'a b;$HOME', DOCKER_HOST: 'tcp://invalid:2375' });
  assert.equal(customEnv.stdout, 'a b;$HOME');
  const interactive = await command('read -r value; printf "read:%s" "$value"', {}, async child => { child.stdin.end('hello\n'); });
  assert.equal(interactive.stdout, 'read:hello');
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGKILL']) {
    const killed = await command('exec sleep 60', {}, async (child, launch) => {
      child.stdin.end();
      await new Promise(resolve => setTimeout(resolve, 800));
      launch.signal(signal);
    });
    assert.notEqual(killed.code, 0, signal);
  }
  await dockerRun(dockerArgs(['ln', '-s', canary, `${work}/host-link`]));
  await assert.rejects(files.readFile(`${work}/host-link`));
  assert.equal(await fs.readFile(canary, 'utf8'), 'host-only-canary');
  const { ExecProcessManager } = await import('../engine/dist/tools/builtins/exec-process-manager.js');
  const manager = new ExecProcessManager();
  try {
    for (const tty of [false, true]) {
      const id = manager.start({ ownerId: 'smoke', command: tty ? 'test -t 0 && read -r value; echo "pty:$value"' : 'echo pipe-ok', cwd: work,
        shell: { requested: 'bash', file: 'bash', args: ['-c'] }, env: {}, timeoutMs: 15000, maxOutputChars: 5000, tty });
      const first = await manager.interact(id, { ownerId: 'smoke', yieldTimeMs: 1000 });
      if (tty) assert.equal(first.status, 'running', JSON.stringify(first));
      const result = tty ? await manager.interact(id, { ownerId: 'smoke', chars: 'hello\n', yieldTimeMs: 3000 }) : first;
      assert.equal(result.exit_code, 0, JSON.stringify(result));
      assert.match(result.stdout, tty ? /pty:hello/ : /pipe-ok/);
    }
  } finally { manager.terminateAll(); }
  console.log('DOCKER_BACKEND_OK: root, files, symlinks, env, stdin, signals, PTY, host canary');
} finally {
  delete process.env.NEO_CANARY_SECRET;
  await files.rm(work, { recursive: true, force: true });
  await fs.rm(hostDir, { recursive: true, force: true });
}
