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
  assert.equal(h.element('pathOptions').open, false);
  assert.match(h.element('pathDisplay').textContent, /Neo/);
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
  assert.equal(h.element('pathOptions').open, true);
  assert.match(h.element('readyMessage').textContent, /重试.*更改目录/);
  assert.match(h.element('installLog').textContent, /network failure/);
});
test('successful install refreshes final path before launch, blocks duplicate submit', async () => {
  const job = deferred(); let boots = 0;
  const h = harness({ invoke(name) {
    if (name === 'install_runtime') return job.promise;
    if (name === 'bootstrap_state' && ++boots > 1) return { installed: true, install_dir: 'E:\\Fallback', auto_launch: false };
  } }); await tick();
  h.element('installPath').value = ' D:\\Neo 工作台 ';
  const pending = h.element('installForm').emit('submit');
  await h.element('installForm').emit('submit');
  job.resolve(); await pending;
  assert.equal(h.calls.filter((call) => call.name === 'install_runtime').length, 1);
  assert.equal(h.calls.at(-1).name, 'launch_runtime');
  assert.equal(h.calls.at(-1).args.installDir, 'E:\\Fallback');
  assert.equal(h.element('installPath').value, 'E:\\Fallback');
  assert.match(h.element('pathDisplay').textContent, /Fallback/);
  assert.equal(h.element('installPath').readOnly, true);
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
  assert.match(h.element('installLog').textContent, /Neo Desktop/);
  h.document.hidden = true; h.document.emit('visibilitychange');
  assert.equal(h.document.body.classList.contains('page-hidden'), true);
});
test('directory failure unlocks controls and blank input uses native default', async () => {
  const h = harness({ invoke: (name) => name === 'choose_install_directory' ? Promise.reject('denied') : undefined }); await tick();
  await h.element('browseButton').emit('click');
  assert.match(h.element('readyMessage').textContent, /无法选择目录/);
  assert.match(h.element('installLog').textContent, /denied/);
  assert.equal(h.element('browseButton').disabled, false);
  h.element('installPath').value = '  ';
  await h.element('installForm').emit('submit');
  assert.equal(h.calls.find((call) => call.name === 'install_runtime').args.installDir, 'C:\\Neo');
});
test('late install completion after exit cannot launch runtime', async () => {
  const job = deferred(); const h = harness({ invoke: (name) => name === 'install_runtime' ? job.promise : undefined }); await tick();
  const pending = h.element('installForm').emit('submit');
  h.window.emit('pagehide'); job.resolve(); await pending;
  assert.equal(h.calls.some((call) => call.name === 'launch_runtime'), false);
  assert.equal(h.removals, 2);
});
test('installed startup page updates Web and Core only while backend is stopped', async () => {
  const h = harness({ state: { installed: true, auto_launch: false, install_dir: 'D:\\Existing', default_install_dir: 'C:\\Neo', web_version: '0.1.10', core_version: '0.2.36' }, invoke(name) {
    if (name === 'update_runtime') return { web_version: '0.1.11', core_version: '0.2.37' };
  } }); await tick();
  assert.equal(h.element('readyTitle').textContent, 'Neo 启动页');
  assert.equal(h.element('installButton').hidden, true);
  assert.match(h.element('versionStatus').textContent, /Web 0\.1\.10 \/ Core 0\.2\.36/);
  assert.equal(h.element('updateRuntime').disabled, false);
  await h.element('updateRuntime').emit('click');
  assert.equal(h.calls.filter((call) => call.name === 'update_runtime').length, 1);
  assert.equal(h.document.body.dataset.state, 'ready');
  assert.match(h.element('versionStatus').textContent, /Web 0\.1\.11 \/ Core 0\.2\.37/);
});
test('running backend disables startup page update', async () => {
  const h = harness({ state: { installed: true, auto_launch: false, install_dir: 'D:\\Existing', default_install_dir: 'C:\\Neo' }, invoke(name) { if (name === 'runtime_status') return true; } }); await tick();
  assert.equal(h.element('updateRuntime').disabled, true);
  await h.element('updateRuntime').emit('click');
  assert.equal(h.calls.some((call) => call.name === 'update_runtime'), false);
});

test('first install explains latest Web and compatible Core before invoking installation', async () => {
  const job = deferred();
  const h = harness({ invoke: (name) => name === 'install_runtime' ? job.promise : undefined }); await tick();
  assert.match(h.element('readyMessage').textContent, /^首次安装需联网。$/);
  assert.equal(h.element('backendControls').hidden, true);
  const pending = h.element('installForm').emit('submit');
  assert.equal(h.document.body.dataset.state, 'installing');
  assert.equal(h.element('progressMessage').textContent, '正在准备安装…');
  assert.match(h.element('installLog').textContent, /联网获取最新 Web 与其兼容的 Core/);
  assert.equal(h.calls.filter((call) => call.name === 'install_runtime').length, 1);
  assert.equal(h.calls.some((call) => call.name === 'update_runtime'), false);
  job.resolve(); await pending;
});

test('failed startup-page update returns to installed controls without reinstalling', async () => {
  const h = harness({ state: { installed: true, auto_launch: false, install_dir: 'D:\\Existing' }, invoke(name) {
    if (name === 'update_runtime') return Promise.reject('network failure');
  } }); await tick();
  assert.match(h.element('versionStatus').textContent, /Web .*Core/);
  await h.element('updateRuntime').emit('click');
  assert.equal(h.element('progressTitle').textContent, '更新未完成');
  assert.equal(h.element('retryButton').textContent, '返回启动页');
  await h.element('retryButton').emit('click');
  assert.equal(h.document.body.dataset.state, 'ready');
  assert.equal(h.element('updateRuntime').disabled, false);
  assert.equal(h.element('installButton').hidden, true);
  assert.equal(h.calls.some((call) => call.name === 'install_runtime'), false);
});


test('fallback progress message is visible and retained in logs', async () => {
  const job = deferred();
  const h = harness({ invoke: name => name === 'install_runtime' ? job.promise : undefined }); await tick();
  const pending = h.element('installForm').emit('submit');
  const message = '目录不可写，已更换安装位置。';
  h.events.get('install-progress')({ payload: { message } });
  assert.equal(h.element('progressMessage').textContent, message);
  h.events.get('install-progress')({ payload: { message: '正在下载…' } });
  assert.ok(h.element('installLog').textContent.includes(message));
  job.reject('denied'); await pending;
});

test('final bootstrap failure retries state only and never launches stale selected path', async () => {
  let boots = 0;
  const h = harness({ invoke(name) {
    if (name === 'bootstrap_state') {
      boots++;
      if (boots === 2) return Promise.reject('config unavailable');
      if (boots === 3) return { installed: true, install_dir: 'E:/Final' };
    }
  } }); await tick();
  await h.element('installForm').emit('submit');
  assert.equal(h.document.body.dataset.state, 'error');
  assert.equal(h.calls.some(c => c.name === 'launch_runtime'), false);
  assert.match(h.element('installLog').textContent, /config unavailable/);
  await h.element('retryButton').emit('click');
  assert.equal(h.calls.filter(c => c.name === 'install_runtime').length, 1);
  assert.equal(h.calls.at(-1).args.installDir, 'E:/Final');
});

test('configured but incomplete installation remains read-only without auto launch', async () => {
  const h = harness({ state: { installed: false, install_dir: 'D:/Existing', default_install_dir: 'C:/Other' } }); await tick();
  assert.equal(h.element('installPath').value, 'D:/Existing');
  assert.equal(h.element('installPath').readOnly, true);
  assert.equal(h.element('browseButton').disabled, true);
  assert.equal(h.element('installButton').hidden, true);
  await h.element('browseButton').emit('click');
  await h.element('installForm').emit('submit');
  assert.equal(h.calls.some(c => ['install_runtime', 'choose_install_directory', 'launch_runtime'].includes(c.name)), false);
});

test('unreadable configuration fails visibly without enabling fresh install', async () => {
  const h = harness({ invoke: name => name === 'bootstrap_state' ? Promise.reject('config denied') : undefined }); await tick();
  assert.equal(h.document.body.dataset.state, 'error');
  assert.equal(h.element('installButton').disabled, true);
  assert.equal(h.element('browseButton').disabled, true);
  assert.equal(h.element('retryButton').hidden, false);
  assert.match(h.element('installLog').textContent, /config denied/);
  await h.element('installForm').emit('submit');
  assert.equal(h.calls.some(c => c.name === 'install_runtime'), false);
});

test('native directory disclosure starts closed and submit needs no explicit selection', () => {
  const html = readFileSync(`${__dirname}/index.html`, 'utf8');
  assert.match(html, /<details id="pathOptions">/);
  assert.match(html, /<summary id="pathSummary">更改目录<\/summary>/);
  assert.match(html, /<details id="pathOptions">[\s\S]*id="installPath"[\s\S]*id="browseButton"[\s\S]*<\/details>/);
  assert.ok(html.indexOf('id="pathDisplay"') < html.indexOf('id="pathOptions"'));
  assert.doesNotMatch(html.match(/<input id="installPath"[^>]+>/)[0], /required/);
  assert.match(html, /安装并启动/);
});
