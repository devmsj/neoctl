import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { findAvailablePort, helpText, parseArgs } from './bin/neow.mjs';
import { resolveWebStorage } from './platform-paths.mjs';

test('neow exposes useful help', () => {
  const help = helpText();
  assert.match(help, /neow/);
  assert.match(help, /--runtime-port/);
  assert.match(help, /--no-open/);
});

test('neow parses ports and host', () => {
  assert.deepEqual(parseArgs(['--host', '0.0.0.0', '-p', '5200', '--runtime-port', '3200', '--no-open']), {
    host: '0.0.0.0', port: 5200, runtimeHost: '127.0.0.1', runtimePort: 3200, open: false,
  });
  assert.throws(() => parseArgs(['--port', '0']), /1-65535/);
  assert.throws(() => parseArgs(['--wat']), /未知参数/);
});

test('neow skips occupied ports', async () => {
  const occupied = net.createServer();
  await new Promise((resolve) => occupied.listen(0, '127.0.0.1', resolve));
  const address = occupied.address();
  const selected = await findAvailablePort(address.port, '127.0.0.1');
  assert.ok(selected > address.port);
  await new Promise((resolve) => occupied.close(resolve));
});

test('neow launches through a symlinked package path', async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'neow-symlink-'));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const packageRoot = path.dirname(fileURLToPath(import.meta.url));
  const linkedRoot = path.join(temporaryRoot, 'linked-package');
  await symlink(packageRoot, linkedRoot, 'junction');

  const result = spawnSync(process.execPath, [path.join(linkedRoot, 'bin', 'neow.mjs'), '--version'], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const packageJson = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
  assert.equal(result.stdout.trim(), packageJson.version);
});

test('web storage uses platform-specific user data directories', () => {
  assert.deepEqual(resolveWebStorage({
    platform: 'win32',
    env: { LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local' },
    homeDir: 'C:\\Users\\alice',
    cwd: 'C:\\Windows\\System32',
  }), {
    dataRoot: 'C:\\Users\\alice\\AppData\\Local\\neoctl-web',
    workspaceRoot: 'C:\\Users\\alice\\AppData\\Local\\neoctl-web\\workspaces',
  });
  assert.deepEqual(resolveWebStorage({
    platform: 'darwin', env: {}, homeDir: '/Users/alice', cwd: '/',
  }), {
    dataRoot: '/Users/alice/Library/Application Support/neoctl-web',
    workspaceRoot: '/Users/alice/Library/Application Support/neoctl-web/workspaces',
  });
  assert.deepEqual(resolveWebStorage({
    platform: 'linux', env: { XDG_DATA_HOME: '/data/alice' }, homeDir: '/home/alice', cwd: '/',
  }), {
    dataRoot: '/data/alice/neoctl-web',
    workspaceRoot: '/data/alice/neoctl-web/workspaces',
  });
});

test('web storage environment overrides remain supported', () => {
  assert.deepEqual(resolveWebStorage({
    platform: 'linux',
    env: { NEO_WEB_DATA_DIR: './state', NEO_WORKSPACE_ROOT: './sessions' },
    homeDir: '/home/alice',
    cwd: '/srv/neo',
  }), {
    dataRoot: '/srv/neo/state',
    workspaceRoot: '/srv/neo/sessions',
  });
});
