'use strict';
// Embedded in the updater; uses the bundled npm's own verified cache and TLS stack.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
function packagesFromLock(lock) {
  const unique = new Map();
  for (const [location, pkg] of Object.entries(lock.packages || {})) {
    if (!location || pkg.link || pkg.dev || !/^https?:\/\//.test(pkg.resolved || '')) continue;
    // Count unique archives, not duplicate nested installations of the same package.
    const key = `${pkg.resolved}|${pkg.integrity || ''}`;
    unique.set(key, { resolved: pkg.resolved, integrity: pkg.integrity, name: pkg.name || location.split('node_modules/').at(-1) });
  }
  return [...unique.values()];
}
async function downloadPackages(packages, fetch, progress, concurrency = 6) {
  let cursor = 0, completed = 0, failed;
  progress({ percent: 30, stage: `下载依赖包 0 / ${packages.length}`, message: '按已校验的依赖包计数，包含本地缓存命中。' });
  await Promise.all(Array.from({ length: Math.min(concurrency, packages.length) }, async () => {
    while (!failed) {
      const index = cursor++;
      if (index >= packages.length) return;
      const pkg = packages[index];
      try {
        await fetch(pkg);
        completed++;
        progress({ percent: 30 + Math.floor(40 * completed / packages.length), stage: `下载依赖包 ${completed} / ${packages.length}`, message: `${pkg.name} 已校验`, completed, total: packages.length });
      } catch (error) { failed = error; }
    }
  }));
  if (failed) throw failed;
  return completed;
}
async function main(npm, root) {
  const progress = value => process.stdout.write('@neo-progress ' + JSON.stringify(value) + '\n');
  const npmRun = args => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [npm, ...args, '--omit=dev', '--no-audit', '--no-fund', '--install-strategy=nested', '--registry', 'https://registry.npmjs.org'], { cwd: root, env: process.env, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });
    child.on('error', reject);
    child.on('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`npm ${args[0]} failed (${code ?? signal})`)));
  });
  progress({ percent: 24, stage: '解析依赖清单', message: '获取包版本与完整依赖关系。' });
  // No lifecycle scripts or payload extraction during dependency planning.
  await npmRun(['install', '--package-lock-only', '--ignore-scripts', '--loglevel=http']);
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  const npmModules = path.join(path.dirname(npm), '..', 'node_modules');
  const { checkPlatform } = require(path.join(npmModules, 'npm-install-checks'));
  const compatibleLock = { packages: Object.fromEntries(Object.entries(lock.packages || {}).filter(([, pkg]) => {
    try { checkPlatform(pkg, false); return true; }
    catch (error) { if (pkg.optional) return false; throw error; }
  })) };
  const packages = packagesFromLock(compatibleLock);
  const pacote = require(path.join(npmModules, 'pacote'));
  const opts = { cache: process.env.npm_config_cache, preferOffline: true, registry: 'https://registry.npmjs.org', retry: { retries: 2 }, timeout: 120000 };
  await downloadPackages(packages, pkg => pacote.tarball.stream(pkg.resolved, stream => new Promise((resolve, reject) => {
    stream.on('error', reject); stream.on('end', resolve); stream.resume();
  }), { ...opts, integrity: pkg.integrity }), progress);
  progress({ percent: 72, stage: '解包并安装依赖', message: '复用已校验缓存，按锁定版本安装。' });
  await npmRun(['ci', '--prefer-offline', '--foreground-scripts', '--loglevel=http']);
  progress({ percent: 80, stage: '依赖安装完成', message: '准备校验 Web 与 Core 的兼容性。' });
}
module.exports = { packagesFromLock, downloadPackages };
// Invoked as node -e <embedded source> <npm-cli> <candidate>.
if (process.argv[1]?.endsWith('npm-cli.js')) main(process.argv[1], process.argv[2]).catch(error => { console.error(error); process.exitCode = 1; });
