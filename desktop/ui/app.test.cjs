// Run: node --test desktop/ui/app.test.cjs (no dependencies or native runtime).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const source = readFileSync(`${__dirname}/app.js`, 'utf8');
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function harness(options = {}) {
  const elements = new Map();
  const events = new Map();
  const calls = [];
  let removals = 0;
  function element(id) {
    if (elements.has(id)) return elements.get(id);
    const handlers = new Map(), classes = new Set();
    const el = { id, value: '', textContent: '', hidden: id === 'enterButton', disabled: false, style: {}, dataset: {}, attributes: {}, scrollHeight: 0, scrollTop: 0, clientHeight: 0,
      classList: { toggle(name, force) { const next = force ?? !classes.has(name); next ? classes.add(name) : classes.delete(name); return next; }, contains: (name) => classes.has(name) },
      addEventListener(name, fn) { handlers.set(name, fn); }, removeEventListener(name) { handlers.delete(name); },
      emit(name) { return handlers.get(name)?.({ preventDefault() {} }); },
      setAttribute(name, value) { this.attributes[name] = value; }, focus() { document.activeElement = el; },
    };
    elements.set(id, el); return el;
  }
  const document = element('document');
  document.body = element('body');
  document.querySelector = (selector) => element(selector.slice(1));
  document.querySelectorAll = () => ['readyView', 'progressView', 'launchView'].map(element);
  const window = element('window');
  window.__TAURI__ = options.noApi ? undefined : {
    core: { async invoke(name, args) { calls.push({ name, args }); if (options.invoke) { const result = options.invoke(name, args); if (result !== undefined) return result; } if (name === 'bootstrap_state') return options.state || { default_install_dir: 'C:\\Neo', installed: false }; return null; } },
    event: { async listen(name, fn) { if (options.listen) await options.listen(name); events.set(name, fn); return () => { events.delete(name); removals++; }; } },
  };
  const intervals = new Set();
  const setInterval = (fn) => { intervals.add(fn); return fn; };
  const clearInterval = (fn) => intervals.delete(fn);
  vm.runInNewContext(source, { window, document, console, setInterval, clearInterval });
  return { element, document, window, calls, events, get removals() { return removals; } };
}

test('bootstrap uses native default; browse passes current path; cancel retains it', async () => {
  const h = harness(); await tick();
  assert.equal(h.element('installPath').value, 'C:\\Neo');
  assert.equal(h.element('installButton').disabled, false);
  await h.element('browseButton').emit('click');
  assert.equal(h.calls.at(-1).args.initial, 'C:\\Neo');
  assert.equal(h.element('installPath').value, 'C:\\Neo');
});
test('install event estimate, bounded values, collapsed logs, failure and retry', async () => {
  const job = deferred();
  const h = harness({ invoke: (name) => name === 'install_runtime' ? job.promise : undefined }); await tick();
  const pending = h.element('installForm').emit('submit');
  assert.equal(h.element('logDetails').open, false);
  h.events.get('install-progress')({ payload: { percent: 42, stage: '安装依赖', log: '<b>raw</b>' } });
  assert.equal(h.element('progressBar').style.transform, 'scaleX(0.42)');
  assert.match(h.element('progressTrack').attributes['aria-valuetext'], /安装依赖，42%/);
  assert.match(h.element('installLog').textContent, /<b>raw<\/b>/);
  h.events.get('install-progress')({ payload: { percent: 'bad' } });
  assert.equal(h.element('progressPercent').textContent, '42%');
  h.events.get('install-progress')({ payload: { percent: 200 } });
  assert.equal(h.element('progressPercent').textContent, '100%');
  job.reject(new Error('network failure')); await pending;
  assert.equal(h.document.body.dataset.state, 'error');
  assert.equal(h.element('retryButton').hidden, false);
  const before = h.element('progressMessage').textContent;
  h.events.get('install-progress')({ payload: { percent: 10, message: 'late' } });
  assert.equal(h.element('progressMessage').textContent, before);
  h.element('retryButton').emit('click');
  assert.equal(h.document.body.dataset.state, 'ready');
  assert.equal(h.document.activeElement.id, 'installPath');
});
test('successful install launches exact selected path, blocks duplicate submit', async () => {
  const job = deferred(); const h = harness({ invoke: (name) => name === 'install_runtime' ? job.promise : undefined }); await tick();
  h.element('installPath').value = ' D:\\Neo 工作台 ';
  const pending = h.element('installForm').emit('submit');
  await h.element('installForm').emit('submit');
  job.resolve(); await pending;
  assert.equal(h.calls.filter((call) => call.name === 'install_runtime').length, 1);
  assert.equal(h.calls.at(-1).name, 'launch_runtime');
  assert.equal(h.calls.at(-1).args.installDir, 'D:\\Neo 工作台');
});
test('installed auto-launch and launch retry never reinstall', async () => {
  let attempts = 0;
  const h = harness({ state: { installed: true, install_dir: 'D:\\Existing', default_install_dir: 'C:\\Neo' }, invoke(name) { if (name === 'launch_runtime' && ++attempts === 1) return Promise.reject('busy port'); } }); await tick();
  assert.equal(h.element('progressTitle').textContent, '启动未完成');
  await h.element('retryButton').emit('click');
  assert.equal(h.document.body.dataset.state, 'launching');
  assert.equal(h.calls.filter((call) => call.name === 'launch_runtime').length, 2);
  assert.equal(h.calls.some((call) => call.name === 'install_runtime'), false);
});
test('bootstrap retry preserves one pair of subscriptions', async () => {
  let attempts = 0;
  const h = harness({ invoke(name) { if (name === 'bootstrap_state' && ++attempts === 1) return Promise.reject('not ready'); } }); await tick();
  await h.element('retryButton').emit('click');
  assert.equal(h.events.size, 2);
  assert.equal(h.document.body.dataset.state, 'ready');
  h.window.emit('pagehide');
  assert.equal(h.removals, 2);
  assert.equal(h.events.size, 0);
});
test('late subscription after page exit immediately unlistens', async () => {
  const wait = deferred(); const h = harness({ listen: () => wait.promise });
  h.window.emit('pagehide'); wait.resolve(); await tick();
  assert.equal(h.removals, 1);
  assert.equal(h.calls.length, 0);
});
test('partial subscription failure rolls back and retry is clean', async () => {
  let attempts = 0;
  const h = harness({ listen(name) { if (name === 'runtime-log' && ++attempts === 1) return Promise.reject('listen failed'); } }); await tick();
  assert.equal(h.removals, 1);
  await h.element('retryButton').emit('click');
  assert.equal(h.events.size, 2);
  assert.equal(h.document.body.dataset.state, 'ready');
});
test('missing Tauri fails visibly and hidden pages pause animation work', async () => {
  const h = harness({ noApi: true }); await tick();
  assert.match(h.element('progressMessage').textContent, /Neo Desktop/);
  h.document.hidden = true; h.document.emit('visibilitychange');
  assert.equal(h.document.body.classList.contains('page-hidden'), true);
});
test('directory failure unlocks controls and empty path does not install', async () => {
  const h = harness({ invoke: (name) => name === 'choose_install_directory' ? Promise.reject('denied') : undefined }); await tick();
  await h.element('browseButton').emit('click');
  assert.match(h.element('readyMessage').textContent, /denied/);
  assert.equal(h.element('browseButton').disabled, false);
  h.element('installPath').value = '  ';
  await h.element('installForm').emit('submit');
  assert.equal(h.calls.some((call) => call.name === 'install_runtime'), false);
});
test('late install completion after exit cannot launch runtime', async () => {
  const job = deferred(); const h = harness({ invoke: (name) => name === 'install_runtime' ? job.promise : undefined }); await tick();
  const pending = h.element('installForm').emit('submit');
  h.window.emit('pagehide'); job.resolve(); await pending;
  assert.equal(h.calls.some((call) => call.name === 'launch_runtime'), false);
  assert.equal(h.removals, 2);
});
