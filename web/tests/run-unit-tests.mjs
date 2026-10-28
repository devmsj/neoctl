// Explicit allowlist: browser/real-model checks must never enter npm test by discovery.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const webRoot = fileURLToPath(new URL('../', import.meta.url));
const files = [
  'appearance.test.mjs',
  'appearance-controller.test.mjs',
  'attachment-input.test.mjs',
  'observation-idle.test.mjs',
  'execution-signal.test.mjs',
  'agent-content-reader.test.mjs',
  'agent-task-presentation.test.mjs',
  'app-url.test.mjs',
  'artifacts.test.mjs',
  'chunk-uploads.test.mjs',
  'composer-presentation.test.mjs',
  'composer-drop.test.mjs',
  'desktop-file-drop.test.mjs',
  'demo-trigger.test.mjs',
  'core-timing.test.mjs',
  'cpa-quota.test.mjs',
  'image-original-dimensions.test.mjs',
  'interrupt-regression.test.mjs',
  'run-control.test.mjs',
  'queued-attachments.test.mjs',
  'execution-label.test.mjs',
  'isolation-startup.test.mjs',
  'isolation.test.mjs',
  'memory-monitor.test.mjs',
  'local-resources.test.mjs',
  'markdown-render.test.mjs',
  'math-markdown.test.mjs',
  'neow.test.mjs',
  'observability-preservation.test.mjs',
  'plugin-settings.test.mjs',
  'plugin-hotplug.test.mjs',
  'plugins.test.mjs',
  'plugins/downloads/downloads.test.mjs',
  'plugins/video-share/video-share.test.mjs',
  'plugins/xhs-artifact/version.test.mjs',
  'prompt-library.test.mjs',
  'prompt-usage.test.mjs',
  'runtime-router-cleanup.test.mjs',
  'runtime-workspaces.test.mjs',
  'workspace-scope.test.mjs',
  'server-startup.test.mjs',
  'tool-settings.test.mjs',
  'tool-guidance.test.mjs',
  'tool-activity.test.mjs',
  'terminal-ansi.test.mjs',
  'transcript-follow.test.mjs',
  'transcript-lookup.test.mjs',
  'upload-progress.test.mjs',
  'ui-separators.test.mjs',
].map(file => `tests/${file}`);

const options = process.argv.slice(2);
if (options.some(option => option !== '--list')) {
  console.error('Usage: node web/tests/run-unit-tests.mjs [--list]');
  process.exitCode = 1;
} else if (options.includes('--list')) {
  console.log(JSON.stringify({ cwd: webRoot, files }, null, 2));
} else {
  const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files], {
    cwd: webRoot,
    // Tests that use the adapter and tests that import engine/dist should use the same build.
    env: { ...process.env, NEO_CORE_SOURCE: process.env.NEO_CORE_SOURCE || 'local' },
    stdio: 'inherit',
    shell: false,
    windowsHide: true,
  });
  if (result.error) console.error(result.error);
  if (result.signal) console.error(`Unit test process stopped by ${result.signal}`);
  process.exitCode = result.error || result.signal ? 1 : (result.status ?? 1);
}
