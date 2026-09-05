// Read-only version checks: no npm command, install, lifecycle scripts or host configuration.
const fs = require('node:fs');
const path = require('node:path');
const semver = require(path.join(path.dirname(process.execPath), 'node_modules/npm/node_modules/semver'));
const root = process.argv[1];
const webPath = root ? path.join(root, 'runtime/node_modules/neoctl-web/package.json') : '';
function read(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
const web = read(webPath);
const core = root ? read(path.join(path.dirname(webPath), 'node_modules/neoctl/package.json')) : null;
async function check(name, local) {
  try {
    const response = await fetch(`https://registry.npmmirror.com/${name}/latest`, { signal: AbortSignal.timeout(12000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const metadata = await response.json();
    if (!semver.valid(metadata.version)) throw new Error('软件源返回无效版本');
    const current = local?.version;
    return `${name === 'neoctl' ? 'Core' : 'Web'}：${current || '未安装'} → ${metadata.version}（${!current ? '可安装版本' : !semver.valid(current) ? '本地版本未知' : semver.gt(metadata.version, current) ? '有更新' : '无需更新'}）`;
  } catch (error) { return `${name === 'neoctl' ? 'Core' : 'Web'}：检查失败 · ${error.message}`; }
}
Promise.all([check('neoctl-web', web), check('neoctl', core)]).then(lines => {
  console.log(lines.join('\n') + '\n\n仅检查版本，不修改已安装依赖。Core 的适配版本由 Web 声明，不能仅凭 latest 单独替换。\n软件源：registry.npmmirror.com');
}).catch(error => { console.error(error.message); process.exitCode = 1; });
