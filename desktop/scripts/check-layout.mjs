#!/usr/bin/env node
import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const required = [
  'ui/index.html', 'ui/app.js', 'ui/styles.css',
  'src-tauri/Cargo.toml', 'src-tauri/tauri.conf.json', 'src-tauri/src/lib.rs',
  'resources/payload/neoctl-web.tgz', 'resources/payload/payload-manifest.json',
  'tests/scripts/backend-ui.test.cjs', 'tests/scripts/check-updates.test.cjs',
  'tests/scripts/runtime-source.test.cjs', 'tests/ui/app.test.cjs', 'tests/ui/browser.test.cjs',
  'tests/smoke/smoke-runtime-install.mjs', 'tests/smoke/smoke-runtime-launch.mjs',
  'tests/rust/node_isolation_tests.rs',
  'src-tauri/src/bin/neoctl-updater.rs', 'src-tauri/src/runtime_store.rs',
  'src-tauri/src/directory_gate.rs', 'src-tauri/src/health_check.rs',
  'resources/updater/neoctl-updater.exe', 'tests/smoke/smoke-versioned-updater.mjs',
  'scripts/verify-release-versions.mjs', 'tests/smoke/smoke-updater-network.mjs',
];
for (const file of required) await access(path.join(root, file));
for (const directory of ['scripts', 'ui', 'src-tauri/src']) {
  for (const file of await readdir(path.join(root, directory))) {
    if (/\.(?:test|spec)\.[cm]?[jt]sx?$|^smoke-runtime-.*\.mjs$|_tests\.rs$/.test(file)) {
      throw new Error(`test file must live under tests/: ${directory}/${file}`);
    }
  }
}
const isolation = await readFile(path.join(root, 'src-tauri/src/node_isolation.rs'), 'utf8');
if (!isolation.includes('#[path = "../../tests/rust/node_isolation_tests.rs"]')) {
  throw new Error('node isolation tests must remain a unit-test submodule under tests/rust');
}
const config = JSON.parse(await readFile(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
if (config.build.frontendDist !== '../ui') throw new Error('unexpected frontendDist');
console.log(`[check] desktop layout valid (${required.length} required files)`);
