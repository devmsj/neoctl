const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../src-tauri/src/check-updates.cjs'), 'utf8');
const semver = require('../resources/node/node_modules/npm/node_modules/semver');
async function run({ webLatest = '1.0.0', requirement = '^2.0.0', coreVersions = ['2.0.0'], currentWeb = '0.9.0', currentCore = '1.9.0' } = {}) {
  let text = '';
  let reads = 0;
  const context = {
    require(name) {
      if (name === 'node:fs') return { readFileSync() { if (!currentWeb) throw Error('missing'); reads += 1; return JSON.stringify({ version: reads === 1 ? currentWeb : currentCore }); } };
      if (name === 'node:path') return path;
      return semver;
    },
    process: { execPath: 'C:/private/node.exe', argv: ['node', 'C:/private'], exitCode: 0 },
    AbortSignal,
    fetch: async (url) => ({ ok: true, json: async () => url.endsWith('/latest') ? { version: webLatest, dependencies: { neoctl: requirement } } : { versions: Object.fromEntries(coreVersions.map(version => [version, {}])) } }),
    console: { log: value => { text = value; }, error: value => { text = value; } },
  };
  vm.runInNewContext(source, context);
  await new Promise(resolve => setImmediate(resolve));
  return text;
}
test('semantic version comparison and compatible Core selection', async () => {
  const text = await run({ webLatest: '0.2.10', requirement: '^3.1.0', coreVersions: ['3.1.0', '3.4.2', '4.0.0'], currentWeb: '0.2.9', currentCore: '3.0.0' });
  assert.match(text, /Web：0\.2\.9 → 0\.2\.10（有更新）/);
  assert.match(text, /Core：3\.0\.0 → 3\.4\.2（有更新）/);
  assert.match(text, /请返回启动页更新$/);
  assert.doesNotMatch(text, /仅检查版本|软件源：/);
});
test('missing install and malformed metadata are explicit', async () => {
  assert.match(await run({ currentWeb: null }), /未安装/);
  assert.match(await run({ webLatest: 'garbage' }), /检查失败/);
  assert.match(await run({ requirement: 'not-a-range' }), /检查失败/);
  assert.match(await run({ requirement: '^9.0.0', coreVersions: ['1.0.0'] }), /没有满足/);
});
