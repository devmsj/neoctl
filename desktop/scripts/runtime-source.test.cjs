const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const rust = readFileSync(path.join(__dirname, '../src-tauri/src/lib.rs'), 'utf8');
const section = (start, end) => rust.slice(rust.indexOf(start), rust.indexOf(end, rust.indexOf(start)));

test('first-install command defaults to registry latest, not the bundled snapshot', () => {
  const install = section('async fn install_runtime(', 'async fn update_runtime(');
  assert.match(install, /RuntimeSource::RegistryLatestInstall/);
  assert.doesNotMatch(install, /RuntimeSource::Bundled/);
});

test('startup-page update retains latest source and both registry sources resolve latest Web', () => {
  assert.match(section('async fn update_runtime(', 'async fn launch_runtime('), /RuntimeSource::RegistryLatest,/);
  assert.match(section('fn web_specifier(', 'fn is_update('), /Self::RegistryLatestInstall \| Self::RegistryLatest => "latest"/);
  assert.match(section('fn is_update(', 'fn label('), /matches!\(self, Self::RegistryLatest\)/);
  assert.match(rust, /let updating = source\.is_update\(\);/);
});

test('installer uses source specifier and leaves Core resolution to Web dependencies', () => {
  const install = section('fn install_runtime_blocking(', 'fn launch_runtime_blocking(');
  assert.match(install, /let web_specifier = source\.web_specifier\(\);/);
  assert.match(install, /"dependencies": \{\s*"neoctl-web": web_specifier\s*\}/);
  assert.match(install, /if matches!\(source, RuntimeSource::Bundled\) && !payload_source\.exists\(\)/);
  assert.match(install, /if matches!\(source, RuntimeSource::Bundled\) \{\s*fs::copy/);
});

test('smoke installation defaults to latest with an explicit bundled option and compatibility check', () => {
  const smoke = readFileSync(path.join(__dirname, 'smoke-runtime-install.mjs'), 'utf8');
  assert.match(smoke, /process\.argv\.includes\('--bundled'\)/);
  assert.match(smoke, /bundled \? 'file:packages\/neoctl-web\.tgz' : 'latest'/);
  assert.match(smoke, /if \(bundled\) await cp/);
  assert.match(smoke, /semver\.satisfies\(core\.version, requirement\)/);
});
