// Read-only version checks: no npm command, install, lifecycle scripts or host configuration.
const fs = require('node:fs');
const path = require('node:path');
const semver = require(path.join(path.dirname(process.execPath), 'node_modules/npm/node_modules/semver'));
const root = process.argv[1];
const webPath = root ? path.join(root, 'runtime/node_modules/neoctl-web/package.json') : '';
function read(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
async function metadata(name, suffix = '') {
  const response = await fetch(`https://registry.npmmirror.com/${name}${suffix}`, { signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}
function status(label, current, latest) {
  return `${label}：${current || '未安装'} → ${latest}（${!current ? '可安装版本' : !semver.valid(current) ? '本地版本未知' : semver.gt(latest, current) ? '有更新' : '无需更新'}）`;
}
async function check() {
  const web = read(webPath);
  const core = root ? read(path.join(path.dirname(webPath), 'node_modules/neoctl/package.json')) : null;
  const [latestWeb, coreMetadata] = await Promise.all([
    metadata('neoctl-web', '/latest'),
    metadata('neoctl'),
  ]);
  if (!semver.valid(latestWeb.version)) throw new Error('软件源返回无效 Web 版本');
  const requirement = latestWeb.dependencies?.neoctl;
  if (!requirement || !semver.validRange(requirement)) throw new Error('最新 Web 未声明有效的 Core 版本范围');
  const compatibleCore = semver.maxSatisfying(Object.keys(coreMetadata.versions || {}), requirement);
  if (!compatibleCore) throw new Error(`没有满足 ${requirement} 的 Core 版本`);
  return [
    status('Web', web?.version, latestWeb.version),
    status('Core', core?.version, compatibleCore),
  ].join('\n') + '\n\n请返回启动页更新';
}
check().then(console.log).catch(error => { console.error(`检查失败：${error.message}`); process.exitCode = 1; });
