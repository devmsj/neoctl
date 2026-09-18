const { test } = require('node:test');
const assert = require('node:assert/strict');
const { existsSync, readFileSync, readdirSync } = require('node:fs');
const path = require('node:path');
const rust = readFileSync(path.join(__dirname, '../../src-tauri/src/lib.rs'), 'utf8');
const section = (start, end) => rust.slice(rust.indexOf(start), rust.indexOf(end, rust.indexOf(start)));
const root = path.resolve(__dirname, '../..');
const read = (file) => readFileSync(path.join(root, file), 'utf8');

// Source-only regression: no build, registry, private config or runtime data access.
test('desktop build no longer reads or emits an embedded remote-control configuration', () => {
  assert.equal(existsSync(path.join(root, 'src-tauri/control_config.rs')), false);
  assert.equal(existsSync(path.join(root, 'src-tauri/src/control_config.rs')), false);
  assert.match(read('src-tauri/build.rs'), /^fn main\(\) \{\s*tauri_build::build\(\)\s*\}\s*$/);
  const manifest = read('src-tauri/Cargo.toml');
  const buildDependencies = manifest.split('[build-dependencies]')[1].split('[dependencies]')[0];
  assert.doesNotMatch(buildDependencies, /serde_json/);
  assert.match(manifest.split('[dependencies]')[1], /serde_json\s*=/);
});

test('desktop production sources and build scripts have no remote-control injection or sync hooks', () => {
  const retired = /NEO_CONTROL_BUILD_CONFIG|NEO_DESKTOP_CONTROL_(?:CONFIG|FILE)|control_config|control-(?:config|pairing|sync-state|device)\.json|control-sync|\/api\/control|device\/register|device\/heartbeat/i;
  const inspect = (relative) => {
    for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const file = path.join(relative, entry.name);
      if (entry.isDirectory()) inspect(file);
      else if (/\.(?:rs|[cm]?js|json|html|css|ps1)$/.test(entry.name)) {
        assert.doesNotMatch(read(file), retired, file);
      }
    }
  };
  for (const directory of ['src-tauri/src', 'scripts', 'ui']) inspect(directory);
  for (const file of ['src-tauri/build.rs', 'src-tauri/Cargo.toml', 'src-tauri/tauri.conf.json', 'package.json', 'README.md']) {
    assert.doesNotMatch(read(file), retired, file);
  }
});

test('local backend lifecycle, tray and updates remain connected without remote configuration', () => {
  assert.match(rust, /mod runtime_control;/);
  for (const command of ['runtime_status', 'start_backend', 'stop_backend', 'enter_application']) {
    assert.ok(rust.includes(`runtime_control::${command}`), command);
    assert.match(read('src-tauri/src/runtime_control.rs'), new RegExp(`(?:async )?fn ${command}\\(`));
  }
  assert.match(read('src-tauri/src/tray.rs'), /runtime_control::runtime_status/);
  assert.match(rust, /mod tray;/);
  assert.match(rust, /mod updates;/);
  assert.match(rust, /\.env\("NEO_EMBED_RUNTIME", "true"\)/);
  assert.match(rust, /\.env\("NEO_WEB_DATA_DIR", &data_dir\)/);
});

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

test('independent updater owns npm installation and commit follows health check', () => {
  const updater = read('src-tauri/src/bin/neoctl-updater.rs');
  assert.match(rust, /Command::new\(updater_path\(app\)\?\)/);
  assert.doesNotMatch(rust, /fn run_npm_install/);
  assert.match(updater, /--install-strategy=nested/);
  assert.match(updater, /semver\.satisfies/);
  assert.match(updater, /runtime_store::commit/);
  assert.ok(rust.indexOf('launch_version(app, &window') < rust.indexOf('write_all(b"commit'));
  assert.doesNotMatch(rust, /fs::rename\(&runtime, &backup\)/);
});

test('smoke installation defaults to latest with an explicit bundled option and compatibility check', () => {
  const smoke = readFileSync(path.join(__dirname, '../smoke/smoke-runtime-install.mjs'), 'utf8');
  assert.match(smoke, /process\.argv\.includes\('--bundled'\)/);
  assert.match(smoke, /bundled \? 'file:packages\/neoctl-web\.tgz' : 'latest'/);
  assert.match(smoke, /if \(bundled\) await cp/);
  assert.match(smoke, /semver\.satisfies\(core\.version, requirement\)/);
});
