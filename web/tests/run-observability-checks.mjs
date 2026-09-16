// Run from any cwd after implementation. --list prints commands without executing them.
// Jobs and node:test files run sequentially; later success never masks earlier failure.
// Use Node >=20 directly, not npm.cmd / shell globs, for Windows and paths with spaces.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { writeFileSync } from 'node:fs'
const root = fileURLToPath(new URL('../../', import.meta.url))
const tsx = resolve(root, 'engine/node_modules/tsx/dist/cli.mjs')
const unitTimeout = 60000
const defaultTimeout = 180000
const buildTimeout = 300000

// Delivered OBS07/11 baseline: these seven files together had 69 tests.
// The resolver and HTTP smoke are additional coverage, NOT part of that count.
const agentDataFiles = [
  ['agent-run-facts', 'tests/agents/obs07-11-run-facts.test.ts'],
  ['agent-persistence', 'tests/agents/agent-tool-persistence.test.ts'],
  ['agent-task-persistence', 'tests/tasks/task-persistence.test.ts'],
  ['agent-task-tools', 'tests/tasks/subagent-tools.test.ts'],
  ['agent-task-ack', 'tests/tasks/task-ack-size.test.ts'],
  ['agent-visible-data', 'tests/core/obs04-visible-data.test.ts'],
  ['agent-query-persistence', 'tests/core/run-agent-persistence.test.ts'],
]

// The original 17-test-file non-browser observability selection, including nested plugin tests.
// Deliberately repeats focused checks: use run-unit-tests.mjs for the full non-browser web suite.
// Explicit filenames avoid Node-version-dependent glob expansion and browser discovery.
const webNonBrowserFiles = [
  'tests/agent-content-reader.test.mjs',
  'tests/agent-task-presentation.test.mjs',
  'tests/artifacts.test.mjs',
  'tests/composer-presentation.test.mjs',
  'tests/cpa-quota.test.mjs',
  'tests/image-original-dimensions.test.mjs',
  'tests/memory-monitor.test.mjs',
  'tests/neow.test.mjs',
  'tests/observability-preservation.test.mjs',
  'tests/plugin-settings.test.mjs',
  'tests/plugins.test.mjs',
  'tests/runtime-router-cleanup.test.mjs',
  'tests/runtime-workspaces.test.mjs',
  'tests/tool-settings.test.mjs',
  'tests/plugins/xhs-artifact/version.test.mjs',
]

const jobs = [
  ['typecheck', 'engine', ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json', '--noEmit'], buildTimeout],
  ['typecheck-tests', 'engine', ['node_modules/typescript/bin/tsc', '-p', 'tests/tsconfig.json', '--noEmit'], buildTimeout],
  // engine/package.json build, split into independently recorded commands (no shell &&).
  ['engine-build-clean', 'engine', ['--input-type=module', '-e', "import { rmSync } from 'node:fs'; rmSync('dist', { recursive: true, force: true })"], unitTimeout],
  ['engine-build-compile', 'engine', ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'], buildTimeout],
  ['engine-build-assets', 'engine', ['scripts/copy-model-metadata.mjs'], unitTimeout],
  ['engine-build-prompts', 'engine', ['scripts/copy-prompt-resources.mjs'], unitTimeout],
  ['web-build', 'web', ['node_modules/vite/bin/vite.js', 'build'], buildTimeout],
  ['virtual-message-anchor-browser', 'web', ['--test', 'tests/virtual-message-anchor-browser.test.mjs']],
  ['details', 'engine', [tsx, 'tests/web/smoke-tool-call-detail.ts']],
  ['details-http', 'engine', [tsx, 'tests/web/smoke-tool-call-http.ts']],
  ['status', 'engine', [tsx, 'tests/web/smoke-status-semantics.ts']],
  ['fields', 'engine', [tsx, '--test', 'tests/web/tool-detail-fields.test.ts']],
  ['fields-http', 'engine', [tsx, 'tests/web/smoke-tool-detail-fields-http.ts']],
  ['fields-browser', 'web', ['tests/tool-detail-fields-browser.test.mjs']],
  ['preservation', 'web', ['--test', 'tests/observability-preservation.test.mjs', 'tests/agent-task-presentation.test.mjs']],
  ['details-browser', 'web', ['tests/tool-call-detail-browser.test.mjs']],
  ['details-session', 'web', ['tests/tool-call-session-browser.test.mjs']],
  ['status-browser', 'web', ['tests/status-semantics-browser.test.mjs']],
  ['original-pixels', 'web', ['tests/image-original-dimensions.test.mjs']],
  ['original-browser', 'web', ['tests/image-original-dimensions-browser.test.mjs']],
  ['original-app-browser', 'web', ['tests/image-original-dimensions-app-browser.test.mjs']],
  ['terminal-presentation', 'engine', [tsx, '--test', 'tests/web/terminal-presentation.test.ts']],
  ['terminal-store', 'engine', [tsx, '--test', 'tests/tools/terminal-output-store.test.ts']],
  ['terminal-chain', 'engine', [tsx, 'tests/tools/smoke-terminal-output-chain.ts']],
  ['terminal-http', 'engine', [tsx, 'tests/web/smoke-terminal-output-http.ts']],
  ['terminal-background', 'engine', [tsx, 'tests/web/smoke-web-terminal-tasks.ts']],
  ['terminal-browser', 'web', ['tests/terminal-output-browser.test.mjs']],
  ['terminal-transition-browser', 'web', ['--test', 'tests/terminal-transition-browser.test.mjs']],
  ['artifact-version', 'web', ['--test', 'tests/artifacts.test.mjs', 'tests/plugins/xhs-artifact/version.test.mjs', 'tests/xhs-version-browser.test.mjs']],
  ['agent-content-resolver', 'engine', [tsx, '--test', 'tests/web/agent-content-detail.test.ts'], defaultTimeout],
  ['agent-content-http', 'engine', [tsx, 'tests/web/smoke-agent-content-http.ts'], defaultTimeout],
  ...agentDataFiles.map(([name, file]) => [name, 'engine', [tsx, '--test', file], defaultTimeout]),
  // Paths verified in the workspace; these security regressions are required gates.
  // Missing/unfinished files fail normally, never skip or count as part of the 69 baseline.
  ['agent-report-safety', 'engine', [tsx, '--test', 'tests/agents/agent-report-security.test.ts'], defaultTimeout],
  ['agent-tool-payload-safety', 'engine', [tsx, '--test', 'tests/web/agent-tool-payload-security.test.ts'], defaultTimeout],
  ['agent-preview-safety', 'engine', [tsx, '--test', 'tests/agents/live-preview-redaction-security.test.ts'], defaultTimeout],
  ['smoke-secrets', 'engine', [tsx, 'tests/secrets/smoke-secrets.ts'], defaultTimeout],
  ['smoke-agents', 'engine', [tsx, 'tests/agents/smoke-agents.ts'], defaultTimeout],
  ['smoke-agent-lifecycle', 'engine', [tsx, 'tests/agents/smoke-agent-lifecycle.ts'], defaultTimeout],
  ['agent-reader-helper', 'web', ['--test', 'tests/agent-content-reader.test.mjs'], unitTimeout],
  ['agent-reader-browser', 'web', ['tests/agent-content-reader-browser.test.mjs'], defaultTimeout],
  // Formal App: five tests with up to 245s combined test budgets, plus Edge startup.
  ['agent-content-app-browser', 'web', ['--test', 'tests/agent-content-app-browser.test.mjs'], 300000],
  // Eleven real-clock/SSE cases: allow all per-case budgets plus browser cleanup.
  ['agent-round-timing-browser', 'web', ['--test', 'tests/agent-round-timing-browser.test.mjs'], 420000],
  // plugins.test.mjs imports engine/dist and resolves 'plugins' relative to web cwd.
  ['web-non-browser', 'web', ['--test', ...webNonBrowserFiles], 300000],
]

// Do not let node:test default to CPU-count file concurrency (notably on Windows).
const commands = jobs.map(([name, cwd, args, timeout = defaultTimeout]) => ({
  name,
  cwd,
  command: [process.execPath, ...args.flatMap(arg => arg === '--test' ? [arg, '--test-concurrency=1'] : [arg])],
  timeout,
}))
const options = process.argv.slice(2)
if (options.some(option => option !== '--list')) {
  console.error('Usage: node web/tests/run-observability-checks.mjs [--list]')
  process.exitCode = 1
} else if (options.includes('--list')) {
  // Read-only inventory mode: no child processes, builds, tests or OBS_CHECK_LOG writes.
  console.log(JSON.stringify({ jobs: commands }, null, 2))
} else {
  let failed = false
  const results = []
  for (const { name, cwd, command, timeout } of commands) {
    console.log(`RUN ${name} (cwd=${cwd}, timeout=${timeout}ms)`)
    const started = Date.now()
    let result
    try {
      result = spawnSync(command[0], command.slice(1), {
        cwd: resolve(root, cwd), encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024,
        shell: false, windowsHide: true,
      })
    } catch (error) {
      // Invalid spawn options / other synchronous errors must not hide later groups.
      result = { status: null, signal: null, error }
    }
    const passed = result.status === 0 && !result.error && !result.signal
    const entry = {
      name, command, cwd, timeout, durationMs: Date.now() - started,
      status: result.status, signal: result.signal, error: result.error?.message,
      errorCode: result.error?.code, stdout: result.stdout, stderr: result.stderr, passed,
    }
    results.push(entry)
    console.log(`${passed ? 'PASS' : 'FAIL'} ${name}`)
    if (!passed) {
      failed = true
      console.error(`status=${entry.status}, signal=${entry.signal ?? 'none'}, error=${entry.errorCode ?? entry.error ?? 'none'}`)
      if (entry.error) console.error(entry.error)
      if (entry.stderr) console.error(entry.stderr)
      if (entry.stdout) console.error(entry.stdout)
    }
  }
  // Preserve the existing optional JSON-array log format; logging failure is also nonzero.
  if (process.env.OBS_CHECK_LOG) {
    try {
      writeFileSync(process.env.OBS_CHECK_LOG, JSON.stringify(results, null, 2))
    } catch (error) {
      failed = true
      console.error(`FAIL OBS_CHECK_LOG: ${error.message}`)
    }
  }
  console.log(`${results.filter(r => r.passed).length}/${results.length} commands passed`)
  process.exitCode = failed ? 1 : 0
}
