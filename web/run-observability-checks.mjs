// Run from any cwd after implementation. --list prints commands without executing them.
// Jobs and node:test files run sequentially; later success never masks earlier failure.
// Use Node >=20 directly, not npm.cmd / shell globs, for Windows and paths with spaces.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { writeFileSync } from 'node:fs'
const root = fileURLToPath(new URL('../', import.meta.url))
const tsx = resolve(root, 'engine/node_modules/tsx/dist/cli.mjs')
const unitTimeout = 60000
const defaultTimeout = 180000
const buildTimeout = 300000

// Delivered OBS07/11 baseline: these seven files together had 69 tests.
// The resolver and HTTP smoke are additional coverage, NOT part of that count.
const agentDataFiles = [
  ['agent-run-facts', 'src/agents/obs07-11-run-facts.test.ts'],
  ['agent-persistence', 'src/agents/agent-tool-persistence.test.ts'],
  ['agent-task-persistence', 'src/tasks/task-persistence.test.ts'],
  ['agent-task-tools', 'src/tasks/subagent-tools.test.ts'],
  ['agent-task-ack', 'src/tasks/task-ack-size.test.ts'],
  ['agent-visible-data', 'src/core/obs04-visible-data.test.ts'],
  ['agent-query-persistence', 'src/core/run-agent-persistence.test.ts'],
]

// All 17 currently inventoried non-browser web tests, including nested plugin tests.
// Deliberately repeats focused checks: this is also the full non-browser web gate.
// Explicit filenames avoid Node-version-dependent glob expansion and browser discovery.
const webNonBrowserFiles = [
  'agent-content-reader.test.mjs',
  'agent-task-presentation.test.mjs',
  'artifacts.test.mjs',
  'composer-presentation.test.mjs',
  'control-sync.test.mjs',
  'control-transcript.test.mjs',
  'cpa-quota.test.mjs',
  'image-original-dimensions.test.mjs',
  'memory-monitor.test.mjs',
  'neow.test.mjs',
  'observability-preservation.test.mjs',
  'plugin-settings.test.mjs',
  'plugins.test.mjs',
  'runtime-router-cleanup.test.mjs',
  'runtime-workspaces.test.mjs',
  'tool-settings.test.mjs',
  'plugins/xhs-artifact/version.test.mjs',
]

const jobs = [
  ['typecheck', 'engine', ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json', '--noEmit'], buildTimeout],
  // engine/package.json build, split into independently recorded commands (no shell &&).
  ['engine-build-clean', 'engine', ['--input-type=module', '-e', "import { rmSync } from 'node:fs'; rmSync('dist', { recursive: true, force: true })"], unitTimeout],
  ['engine-build-compile', 'engine', ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'], buildTimeout],
  ['engine-build-assets', 'engine', ['scripts/copy-model-metadata.mjs'], unitTimeout],
  ['web-build', 'web', ['node_modules/vite/bin/vite.js', 'build'], buildTimeout],
  ['details', 'engine', [tsx, 'src/web/smoke-tool-call-detail.ts']],
  ['details-http', 'engine', [tsx, 'src/web/smoke-tool-call-http.ts']],
  ['status', 'engine', [tsx, 'src/web/smoke-status-semantics.ts']],
  ['fields', 'engine', [tsx, '--test', 'src/web/tool-detail-fields.test.ts']],
  ['fields-http', 'engine', [tsx, 'src/web/smoke-tool-detail-fields-http.ts']],
  ['fields-browser', 'web', ['tool-detail-fields-browser.test.mjs']],
  ['preservation', 'web', ['--test', 'observability-preservation.test.mjs', 'agent-task-presentation.test.mjs']],
  ['details-browser', 'web', ['tool-call-detail-browser.test.mjs']],
  ['details-session', 'web', ['tool-call-session-browser.test.mjs']],
  ['status-browser', 'web', ['status-semantics-browser.test.mjs']],
  ['original-pixels', 'web', ['image-original-dimensions.test.mjs']],
  ['original-browser', 'web', ['image-original-dimensions-browser.test.mjs']],
  ['original-app-browser', 'web', ['image-original-dimensions-app-browser.test.mjs']],
  ['terminal-presentation', 'engine', [tsx, '--test', 'src/web/terminal-presentation.test.ts']],
  ['terminal-store', 'engine', [tsx, '--test', 'src/tools/terminal-output-store.test.ts']],
  ['terminal-chain', 'engine', [tsx, 'src/tools/smoke-terminal-output-chain.ts']],
  ['terminal-http', 'engine', [tsx, 'src/web/smoke-terminal-output-http.ts']],
  ['terminal-background', 'engine', [tsx, 'src/web/smoke-web-terminal-tasks.ts']],
  ['terminal-browser', 'web', ['terminal-output-browser.test.mjs']],
  ['terminal-transition-browser', 'web', ['--test', 'terminal-transition-browser.test.mjs']],
  ['artifact-version', 'web', ['--test', 'artifacts.test.mjs', 'plugins/xhs-artifact/version.test.mjs', 'xhs-version-browser.test.mjs']],
  ['agent-content-resolver', 'engine', [tsx, '--test', 'src/web/agent-content-detail.test.ts'], defaultTimeout],
  ['agent-content-http', 'engine', [tsx, 'src/web/smoke-agent-content-http.ts'], defaultTimeout],
  ...agentDataFiles.map(([name, file]) => [name, 'engine', [tsx, '--test', file], defaultTimeout]),
  // Paths verified in the workspace; these security regressions are required gates.
  // Missing/unfinished files fail normally, never skip or count as part of the 69 baseline.
  ['agent-report-safety', 'engine', [tsx, '--test', 'src/agents/agent-report-security.test.ts'], defaultTimeout],
  ['agent-tool-payload-safety', 'engine', [tsx, '--test', 'src/web/agent-tool-payload-security.test.ts'], defaultTimeout],
  ['agent-preview-safety', 'engine', [tsx, '--test', 'src/agents/live-preview-redaction-security.test.ts'], defaultTimeout],
  ['smoke-secrets', 'engine', [tsx, 'src/secrets/smoke-secrets.ts'], defaultTimeout],
  ['smoke-agents', 'engine', [tsx, 'src/agents/smoke-agents.ts'], defaultTimeout],
  ['smoke-agent-lifecycle', 'engine', [tsx, 'src/agents/smoke-agent-lifecycle.ts'], defaultTimeout],
  ['agent-reader-helper', 'web', ['--test', 'agent-content-reader.test.mjs'], unitTimeout],
  ['agent-reader-browser', 'web', ['agent-content-reader-browser.test.mjs'], defaultTimeout],
  // Formal App: five tests with up to 245s combined test budgets, plus Edge startup.
  ['agent-content-app-browser', 'web', ['--test', 'agent-content-app-browser.test.mjs'], 300000],
  // Eleven real-clock/SSE cases: allow all per-case budgets plus browser cleanup.
  ['agent-round-timing-browser', 'web', ['--test', 'agent-round-timing-browser.test.mjs'], 420000],
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
  console.error('Usage: node web/run-observability-checks.mjs [--list]')
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
