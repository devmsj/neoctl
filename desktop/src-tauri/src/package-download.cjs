'use strict';
// Embedded in the updater; uses the bundled npm's own verified cache and TLS stack.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const sources = typeof neoRegistrySources !== 'undefined' ? neoRegistrySources : require('./registry-sources.cjs');
function packagesFromLock(lock) {
  const unique = new Map();
  for (const [location, pkg] of Object.entries(lock.packages || {})) {
    if (!location || pkg.link || pkg.dev || !/^https?:\/\//.test(pkg.resolved || '')) continue;
    // Count unique archives, not duplicate nested installations of the same package.
    const key = `${pkg.resolved}|${pkg.integrity || ''}`;
    unique.set(key, { resolved: pkg.resolved, integrity: pkg.integrity, version: pkg.version, name: pkg.name || location.split('node_modules/').at(-1) });
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
  const log = value => process.stdout.write(value + '\n');
  const npmModules = path.join(path.dirname(npm), '..', 'node_modules');
  const semver = require(path.join(npmModules, 'semver'));
  const fetch = sources.transport(npm);
  const mode = sources.preference(process.argv[3] || 'auto');
  const cacheFile = path.join(path.dirname(process.env.npm_config_cache), 'registry-speed.json');
  progress({ percent: 23, stage: mode === 'auto' ? '选择下载源' : '连接下载源', message: mode === 'auto' ? '正在比较下载速度。' : '正在连接所选软件源。' });
  const ranked = await sources.rank(fetch, { mode, cacheFile, refresh: process.argv[4] === 'retry' });
  for (const result of ranked.measurements) log(`${result.label}：${result.bytesPerSecond ? (result.bytesPerSecond / 1048576).toFixed(2) + ' MB/s' : '暂不可用'}`);
  let order = ranked.sources;
  const manifestPath = path.join(root, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const bundled = manifest.dependencies['neoctl-web'].startsWith('file:');
  let pair;
  if (!bundled) {
    let current = {};
    try {
      const runtimeRoot = path.resolve(root, '../..');
      const pointer = JSON.parse(fs.readFileSync(path.join(runtimeRoot, '.neo-updater/current.json'), 'utf8'));
      if (/^r-[a-zA-Z0-9-]+$/.test(pointer.release)) current = JSON.parse(fs.readFileSync(path.join(runtimeRoot, 'releases', pointer.release, 'neo-desktop-runtime.json'), 'utf8'));
    } catch { /* new installation */ }
    pair = await sources.latestPair(fetch, semver, { sources: order,
      minimumWeb: current.web_version || process.env.NEO_MINIMUM_WEB_VERSION,
      minimumCore: current.core_version || process.env.NEO_MINIMUM_CORE_VERSION });
    order = order.filter(s => pair.available.some(a => a.id === s.id));
    manifest.dependencies['neoctl-web'] = pair.web.version;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  }
  let selected = order[0];
  const npmRun = (args, registry = selected.url) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [npm, ...args, '--omit=dev', '--no-audit', '--no-fund', '--install-strategy=nested', '--registry', registry,
      '--fetch-retries=0', '--fetch-timeout=20000', '--replace-registry-host=registry.npmjs.org'], {
      cwd: root, env: { ...process.env, npm_config_registry: registry }, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });
    child.on('error', reject);
    child.on('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`npm ${args[0]} failed (${code ?? signal})`)));
  });
  const unavailable = new Set();
  const switching = source => { if (unavailable.has(source.id)) return; unavailable.add(source.id); log(`${source.label}暂不可用，正在切换下载源。`); try { fs.unlinkSync(cacheFile); } catch {} };
  progress({ percent: 24, stage: '解析依赖清单', message: `使用${selected.label}。` });
  const planned = await sources.fallback(order, async source => {
    try { fs.unlinkSync(path.join(root, 'package-lock.json')); } catch {}
    await npmRun(['install', '--package-lock-only', '--ignore-scripts', '--loglevel=http'], source.url);
    const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
    if (pair) {
      const web = lock.packages['node_modules/neoctl-web'];
      const core = lock.packages['node_modules/neoctl-web/node_modules/neoctl'] || lock.packages['node_modules/neoctl'];
      if (web?.version !== pair.web.version || web?.integrity !== pair.web.dist.integrity || core?.version !== pair.core.version || core?.integrity !== pair.core.dist.integrity) throw Error('Web / Core 版本或完整性不一致');
    }
    return lock;
  }, switching);
  selected = planned.source;
  const lock = planned.value;
  // Stable canonical lock URLs preserve npm/SRI cache identity when switching sources.
  for (const [location, pkg] of Object.entries(lock.packages || {})) {
    if (location && /^https?:\/\//.test(pkg.resolved || '')) pkg.resolved = sources.archiveUrl({ ...pkg, name: pkg.name || location.split('node_modules/').at(-1) }, sources.SOURCES[0]);
  }
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify(lock, null, 2) + '\n');
  const { checkPlatform } = require(path.join(npmModules, 'npm-install-checks'));
  const compatibleLock = { packages: Object.fromEntries(Object.entries(lock.packages || {}).filter(([, pkg]) => {
    try { checkPlatform(pkg, false); return true; }
    catch (error) { if (pkg.optional) return false; throw error; }
  })) };
  const packages = packagesFromLock(compatibleLock);
  const pacote = require(path.join(npmModules, 'pacote'));
  const opts = { cache: process.env.npm_config_cache, preferOffline: true, replaceRegistryHost: 'never', retry: { retries: 0 }, timeout: 20000 };
  const counts = new Map();
  const downloadOrder = [selected, ...ranked.sources.filter(s => s.id !== selected.id)];
  await downloadPackages(packages, async pkg => {
    const result = await sources.fallback([...downloadOrder].sort((a,b) => Number(unavailable.has(a.id)) - Number(unavailable.has(b.id))), source => pacote.tarball.stream(sources.archiveUrl(pkg, source), stream => new Promise((resolve, reject) => {
      stream.on('error', reject); stream.on('end', resolve); stream.resume();
    }), { ...opts, registry: source.url, integrity: pkg.integrity }), switching);
    counts.set(result.source.id, (counts.get(result.source.id) || 0) + 1);
  }, progress);
  progress({ percent: 72, stage: '解包并安装依赖', message: '复用已校验缓存，按锁定版本安装。' });
  // All archives have been verified; extraction uses integrity-keyed cache.
  // Integrity-keyed npm cache allows offline extraction even when the URL host changed.
  await npmRun(['ci', '--prefer-offline', '--foreground-scripts', '--loglevel=http'], sources.SOURCES[0].url);
  fs.writeFileSync(path.join(root, 'neo-registry-selection.json'), JSON.stringify({ schema: 1, mode, registry: selected.url,
    downloads: Object.fromEntries(counts), cachedSpeed: ranked.cached }));
  progress({ percent: 80, stage: '依赖安装完成', message: '准备校验 Web 与 Core 的兼容性。' });
}
module.exports = { packagesFromLock, downloadPackages };
// Invoked as node -e <embedded source> <npm-cli> <candidate>.
if (process.argv[1]?.endsWith('npm-cli.js')) main(process.argv[1], process.argv[2]).catch(error => { console.error(error); process.exitCode = 1; });
