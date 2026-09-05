#!/usr/bin/env node
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(os.tmpdir(), `neo-desktop-runtime-smoke-${process.pid}-${Date.now()}`);
process.env.NEO_DESKTOP_SMOKE_RUNTIME = target;
await mkdir(path.join(target, 'packages'), { recursive: true });
await cp(path.join(desktopRoot, 'resources', 'payload', 'neoctl-web.tgz'), path.join(target, 'packages', 'neoctl-web.tgz'));
await writeFile(path.join(target, 'package.json'), `${JSON.stringify({
  name: 'neoctl-desktop-runtime-smoke',
  version: '1.0.0',
  private: true,
  dependencies: { 'neoctl-web': 'file:packages/neoctl-web.tgz' },
}, null, 2)}\n`);

const node = path.join(desktopRoot, 'resources', 'node', 'node.exe');
const npm = path.join(desktopRoot, 'resources', 'node', 'node_modules', 'npm', 'bin', 'npm-cli.js');
await run(node, [npm, 'install', '--omit=dev', '--no-audit', '--no-fund', '--install-strategy=nested', '--registry', 'https://registry.npmmirror.com'], target);
const web = JSON.parse(await readFile(path.join(target, 'node_modules', 'neoctl-web', 'package.json'), 'utf8'));
const coreRoot = path.join(target, 'node_modules', 'neoctl-web', 'node_modules', 'neoctl');
const core = JSON.parse(await readFile(path.join(coreRoot, 'package.json'), 'utf8'));
await readFile(path.join(target, 'node_modules', 'neoctl-web', 'server.mjs'));
await readFile(path.join(coreRoot, 'dist', 'index.js'));
await writeFile(path.join(desktopRoot, '.smoke-runtime-path'), target, 'utf8');
console.log(`[smoke] installed ${web.name}@${web.version} with ${core.name}@${core.version}`);

function run(file, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, stdio: 'inherit', windowsHide: true });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`${file} exited with ${code}`)));
  });
}
