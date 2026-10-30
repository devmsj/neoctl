// Read-only version checks: no npm command, install, lifecycle scripts or host configuration.
const fs = require('node:fs');
const path = require('node:path');
const semver = require(path.join(path.dirname(process.execPath), 'node_modules/npm/node_modules/semver'));
const root = process.argv[1];
const pointer = root ? read(path.join(root, '.neo-updater/current.json')) : null;
const release = pointer?.schema === 1 && /^r-[a-zA-Z0-9-]+$/.test(pointer.release) ? path.join('releases', pointer.release) : 'runtime';
const webPath = root ? path.join(root, release, 'node_modules/neoctl-web/package.json') : '';
function read(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
const sources = typeof neoRegistrySources !== 'undefined' ? neoRegistrySources : require('./registry-sources.cjs');
function status(label, current, latest) {
  return `${label}：${current || '未安装'} → ${latest}（${!current ? '可安装版本' : !semver.valid(current) ? '本地版本未知' : semver.gt(latest, current) ? '有更新' : '无需更新'}）`;
}
async function check() {
  const web = read(webPath);
  const core = root ? read(path.join(path.dirname(webPath), 'node_modules/neoctl/package.json')) : null;
  const npm = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
  const { web: latestWeb, core: latestCore } = await sources.latestPair(sources.transport(npm), semver);
  const compatibleCore = latestCore.version;
  return [
    status('Web', web?.version, latestWeb.version),
    status('Core', core?.version, compatibleCore),
  ].join('\n') + '\n\n请返回启动页更新';
}
check().then(console.log).catch(error => { console.error(`检查失败：${error.message}`); process.exitCode = 1; });
