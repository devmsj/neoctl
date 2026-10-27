// Release-only UI checks use fixture data; never call a model or mutate user sessions.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const files = [
  'attachments-browser.test.mjs',
  'chrome-theme-browser.test.mjs',
  'composer-metrics-browser.test.mjs',
  'elapsed-clock-browser.test.mjs',
  'execution-resume-browser.test.mjs',
  'execution-signal-browser.test.mjs',
  'observation-idle-browser.test.mjs',
  'tool-connector-browser.test.mjs',
  'user-text-format-browser.test.mjs',
  'streaming-highlight-browser.test.mjs',
  'composer-ime-browser.test.mjs',
  'small-desktop-browser.test.mjs',
  'global-settings-browser.test.mjs',
  'session-loading-browser.test.mjs',
  'session-pagination-browser.test.mjs',
  'session-quick-list-browser.test.mjs',
  'session-context-menu-browser.test.mjs',
  'compaction-stream-browser.test.mjs',
  'context-chrome-browser.test.mjs',
  'workspace-layout-browser.test.mjs',
  'workspace-pages-browser.test.mjs',
  'task-chrome-browser.test.mjs',
  'runtime-tool-list-browser.test.mjs',
].map(file => `tests/${file}`)
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files], {
  cwd: fileURLToPath(new URL('../', import.meta.url)),
  env: process.env,
  stdio: 'inherit',
  windowsHide: true,
})
if (result.error) console.error(result.error)
process.exitCode = result.error || result.signal ? 1 : (result.status ?? 1)
