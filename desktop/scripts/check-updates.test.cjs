const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../src-tauri/src/check-updates.cjs'), 'utf8');
const semver = require('../resources/node/node_modules/npm/node_modules/semver');
async function run(latest, current) {
  let text = '';
  const context = { require: name => name === 'node:fs' ? { readFileSync: () => { if (!current) throw Error('missing'); return JSON.stringify({ version: current }); } } : name === 'node:path' ? path : semver, process: { execPath: 'C:/private/node.exe', argv: ['node','C:/private'] }, AbortSignal, fetch: async () => ({ ok: true, json: async () => ({ version: latest }) }), console: { log: t => { text=t; }, error: t => { text=t; } } };
  vm.runInNewContext(source, context);
  await new Promise(resolve => setImmediate(resolve));
  return text;
}
test('semantic version comparison, not lexical order', async () => { assert.match(await run('0.2.10','0.2.9'), /有更新/); assert.match(await run('0.2.9','0.2.10'), /无需更新/); });
test('missing install and malformed remote versions are explicit', async () => { assert.match(await run('1.0.0',null), /未安装/); assert.match(await run('garbage','1.0.0'), /检查失败/); });
