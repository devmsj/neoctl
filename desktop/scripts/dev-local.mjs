#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') {
  throw new Error('Neo Desktop local debugging currently requires Windows.');
}

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(desktopRoot, '..');
const engineRoot = path.join(repoRoot, 'engine');
const webRoot = path.join(repoRoot, 'web');
const runtimeRoot = path.join(desktopRoot, '.cache', 'dev-runtime');
const runtime = path.join(runtimeRoot, 'runtime');
const packages = path.join(runtimeRoot, 'packages');
const data = path.join(runtimeRoot, 'data');
const logs = path.join(runtimeRoot, 'logs');
const nodeSource = path.join(desktopRoot, 'resources', 'node');
const node = path.join(runtime, 'node', 'node.exe');
const npmCli = path.join(runtime, 'node', 'node_modules', 'npm', 'bin', 'npm-cli.js');
const webPackage = path.join(packages, 'neoctl-web.tgz');
const enginePackage = path.join(packages, 'neoctl.tgz');

console.log('[desktop:dev] building local Engine and Web sources');
await run('npm.cmd', ['run', 'build'], engineRoot);
await mkdir(packages, { recursive: true });
await pack(engineRoot, enginePackage);
await pack(webRoot, webPackage);

console.log(`[desktop:dev] preparing isolated runtime at ${runtimeRoot}`);
await rm(runtime, { recursive: true, force: true });
await mkdir(runtime, { recursive: true });
await mkdir(path.join(data, 'workspaces'), { recursive: true });
await mkdir(logs, { recursive: true });
await cp(nodeSource, path.join(runtime, 'node'), { recursive: true });
await writeFile(path.join(runtime, 'package.json'), `${JSON.stringify({
  name: 'neoctl-desktop-local-runtime',
  version: '0.0.0',
  private: true,
  dependencies: {
    neoctl: 'file:../packages/neoctl.tgz',
    'neoctl-web': 'file:../packages/neoctl-web.tgz',
  },
  overrides: {
    'neoctl-web': {
      neoctl: '$neoctl',
    },
  },
}, null, 2)}\n`, 'utf8');
await run(node, [npmCli, 'install', '--omit=dev', '--no-audit', '--no-fund', '--install-strategy=nested'], runtime, isolatedNpmEnv());
await writeFile(path.join(runtime, 'neo-desktop-runtime.json'), `${JSON.stringify({
  schema: 1,
  web_package: 'local-source',
  installed_at: new Date().toISOString(),
  registry: 'local-files',
}, null, 2)}\n`, 'utf8');

console.log('[desktop:dev] launching debug window (Ctrl+C to stop)');
await run('npm.cmd', ['exec', '--', 'tauri', 'dev', '--no-watch'], desktopRoot, {
  ...process.env,
  NEO_DESKTOP_DEV_RUNTIME: runtimeRoot,
});

async function pack(cwd, output) {
  const result = await capture('npm.cmd', ['pack', '--json'], cwd);
  const filenames = [...result.stdout.matchAll(/"filename"\s*:\s*"([^"]+\.tgz)"/g)];
  const filename = filenames.at(-1)?.[1];
  if (!filename) throw new Error(`npm pack did not return a filename for ${cwd}:\n${result.stdout}`);
  await rm(output, { force: true });
  await cp(path.join(cwd, filename), output);
  await rm(path.join(cwd, filename), { force: true });
}

function isolatedNpmEnv() {
  const home = path.join(runtimeRoot, '.npm');
  return {
    ...process.env,
    npm_config_userconfig: path.join(home, 'npmrc'),
    npm_config_cache: path.join(home, 'cache'),
    npm_config_prefix: path.join(home, 'prefix'),
    npm_config_audit: 'false',
    npm_config_fund: 'false',
  };
}

function spawnSpec(file, args) {
  if (!file.toLowerCase().endsWith('.cmd')) return { file, args };
  const command = [file, ...args].map(quoteWindowsArgument).join(' ');
  return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', command] };
}

function quoteWindowsArgument(value) {
  const text = String(value);
  return /^[A-Za-z0-9_./:=@-]+$/.test(text) ? text : `"${text.replaceAll('"', '\\"')}"`;
}

function run(file, args, cwd, env = process.env) {
  return new Promise((resolve, reject) => {
    const command = spawnSpec(file, args);
    const child = spawn(command.file, command.args, { cwd, env, stdio: 'inherit', windowsHide: false });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${file} exited with ${code ?? signal}`));
    });
  });
}

function capture(file, args, cwd) {
  return new Promise((resolve, reject) => {
    const command = spawnSpec(file, args);
    const child = spawn(command.file, command.args, { cwd, stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve({ stdout });
      else reject(new Error(`${file} exited with ${code}`));
    });
  });
}
