import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

for (const layout of ['hoisted', 'nested']) {
  test(`core runtime reads the version from a ${layout} package dependency`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'neo-core-resolution-'));
    try {
      const web = path.join(root, 'node_modules', 'neoctl-web');
      const core = path.join(layout === 'hoisted' ? root : web, 'node_modules', 'neoctl');
      await mkdir(web, { recursive: true });
      await mkdir(path.join(core, 'web'), { recursive: true });
      await copyFile(new URL('../core-runtime.mjs', import.meta.url), path.join(web, 'core-runtime.mjs'));
      await writeFile(path.join(core, 'package.json'), JSON.stringify({ name: 'neoctl', version: '9.8.7', type: 'module', exports: { '.': './index.js', './package.json': './package.json', './web/index.js': './web/index.js' } }));
      await writeFile(path.join(core, 'index.js'), 'export const QueryEngine = class {};');
      await writeFile(path.join(core, 'web', 'index.js'), 'export const WebRepl = class {};');
      await writeFile(path.join(web, 'probe.mjs'), "const {coreRuntimeInfo}=await import('./core-runtime.mjs'); console.log(JSON.stringify(coreRuntimeInfo));");
      const run = spawnSync(process.execPath, [path.join(web, 'probe.mjs')], { encoding: 'utf8', env: { ...process.env, NEO_CORE_SOURCE: 'package' } });
      assert.equal(run.status, 0, run.stderr);
      assert.deepEqual(JSON.parse(run.stdout), { source: 'package', version: '9.8.7', location: 'neoctl' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}
