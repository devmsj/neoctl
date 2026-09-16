# Web tests

All web test files, plugin tests, browser fixtures and test runners live here. Production modules remain in `web/` and `web/plugins/`.

## Default offline suite

From the repository root:

```sh
npm --prefix engine run build
npm --prefix web test
```

Or run `node web/tests/run-unit-tests.mjs` from the repository root. The runner anchors child-process cwd to `web/`, uses an explicit list of 26 non-browser files and defaults `NEO_CORE_SOURCE` to `local` (an explicit environment override is preserved). It needs installed web dependencies and a built local Engine, but does not build or install anything automatically. It includes local HTTP/server-startup integration regressions and mocked runtime tests, not real browsers or real model requests. `server-startup.test.mjs` checks that removed remote-control modules/viewer are absent and an obsolete launcher setting cannot start background enrollment or synchronization; its loopback-only mock also verifies ordinary model-configuration and chat proxy requests. A separate embedded-runtime case starts the real local Engine, reads `/api/state`, saves and reloads `/api/login`, and checks the temporary env file. HOME, sessions and settings are isolated in a temporary directory; no real model request is made.

`npm --prefix web run test:unit` is the same suite. Inspect its list without running anything:

```sh
node web/tests/run-unit-tests.mjs --list
```

The existing focused npm scripts (`test:xhs`, `test:runtime`, `test:isolation`, `test:plugins`, `test:monitoring`, `test:server`, `test:cli`) also point here. Plugin-specific tests can be run from `web/`:

```sh
node --test tests/plugins/downloads/downloads.test.mjs
node --test tests/plugins/video-share/video-share.test.mjs
node --test tests/plugins/xhs-artifact/version.test.mjs
```

For direct test-file commands use `web/` as cwd: `plugins.test.mjs` intentionally resolves its plugin directory and test data relative to that directory. `observability-preservation.test.mjs` additionally requires Git history containing baseline commit `d40cb8b67525b8646587480c43bce3854c153dca`. Assertions are preserved; existing presentation/source-baseline mismatches are not skipped by the default runner.

## Optional browser regressions

The 26 `*browser.test.mjs` files are deliberately excluded from `npm test`. Do not use bare `node --test` or a recursive test glob as the default suite: these would discover browser tests as well.

Most browser tests serve built `web/dist`; build it first. For example, from the repository root:

```sh
npm --prefix web run build
node --test web/tests/composer-compact-browser.test.mjs
npm --prefix web run test:image-create-browser
```

These tests require a real local browser (usually Microsoft Edge) and separately installed `playwright-core`; it is not a web package dependency. The shared fixture and several standalone tests try `PLAYWRIGHT_CORE_PATH`, the repository's `desktop/.cache/ui-test/node_modules/playwright-core`, the system temporary directory's `neoctl-observability-tests/node_modules/playwright-core`, and then normal module resolution. Use absolute paths for environment overrides.

- Shared-fixture tests and the standalone reader support `BROWSER_CHANNEL` (default `msedge`). Several other standalone tests deliberately require Edge and do not honor that override.
- `image-create-browser.test.mjs` and `isolation-browser.test.mjs` support `NEO_PLAYWRIGHT_MODULE`; `agent-task-browser.test.mjs` directly uses the desktop cache.
- `xhs-version-browser.test.mjs` uses the temporary-directory Playwright installation and a fixed Windows Edge executable path.
- `agent-content-reader-browser.test.mjs` runs Vite against the real web root instead of serving `dist`.
- `isolation-browser.test.mjs` also needs the local Engine build.
- `status-semantics-browser.test.mjs` reads the temporary file `obs08-browser-lines.json`, produced by the Engine status-semantics smoke check.

Browser fixtures generally use mocked/read-only API data rather than real model requests, but still require real browser infrastructure. Run only the applicable checks explicitly.

## Full observability gate

```sh
node web/tests/run-observability-checks.mjs --list
node web/tests/run-observability-checks.mjs
```

This preserved, opt-in cross-module runner resolves the repository root independently of cwd. It builds Engine and web, runs selected Engine tests/smokes via `tsx` from `engine/tests/`, and runs selected web unit/browser tests. It is **not** the default unit entry point and its 15-file web non-browser selection is not the complete 26-file suite. It requires all build, browser and smoke prerequisites; inspect `--list` before running. `OBS_CHECK_LOG` optionally records its results. An npm alias is available as `npm --prefix web run test:observability`.
