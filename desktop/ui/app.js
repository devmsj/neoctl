'use strict';

// Presentation only: command names and payloads are the existing Tauri contract.
const api = window.__TAURI__;
const $ = (selector) => document.querySelector(selector);
const views = [...document.querySelectorAll('.view')];
const pathInput = $('#installPath');
const installButton = $('#installButton');
const browseButton = $('#browseButton');
const enterButton = $('#enterButton');
const retryButton = $('#retryButton');
const installLog = $('#installLog');
const cleanups = [];
let disposed = false;
let busy = false;
let initialized = false;
let installedDir = '';
let backendRunning = false;
let retryAction = 'initialize';
let phase = 'booting';
let estimate = 0;

function on(target, event, handler) {
  target.addEventListener(event, handler);
  cleanups.push(() => target.removeEventListener(event, handler));
}

function showView(id, state, focus = true) {
  if (disposed) return;
  phase = state;
  document.body.dataset.state = state;
  views.forEach((view) => { view.hidden = view.id !== id; });
  if (focus) $(`#${id.replace('View', 'Title')}`)?.focus({ preventScroll: true });
}

function setBusy(value) {
  busy = value;
  installButton.disabled = value || !initialized || backendRunning;
  browseButton.disabled = value || !initialized;
  pathInput.disabled = value || !initialized;
  enterButton.disabled = value || !backendRunning;
  $('#startBackend').disabled = value || !installedDir || backendRunning;
  $('#stopBackend').disabled = value || !backendRunning;
  retryButton.disabled = value;
}

function appendLog(line) {
  if (disposed || !line) return;
  const follow = installLog.scrollHeight - installLog.scrollTop - installLog.clientHeight < 32;
  installLog.textContent = `${installLog.textContent}${String(line)}\n`;
  if (installLog.textContent.length > 24000) installLog.textContent = installLog.textContent.slice(-18000);
  if (follow) installLog.scrollTop = installLog.scrollHeight;
}

function applyProgress(payload = {}) {
  if (disposed || phase !== 'installing') return;
  const value = Number(payload.percent);
  if (Number.isFinite(value)) estimate = Math.max(0, Math.min(100, value));
  $('#progressTitle').textContent = payload.title || '正在安装';
  $('#progressMessage').textContent = payload.message || '';
  $('#progressStage').textContent = payload.stage || '准备中';
  $('#progressPercent').textContent = `${Math.round(estimate)}%`;
  $('#progressBar').style.transform = `scaleX(${estimate / 100})`;
  $('#progressTrack').setAttribute('aria-valuenow', String(estimate));
  $('#progressTrack').setAttribute('aria-valuetext', `${payload.stage || '准备中'}，${Math.round(estimate)}%`);
  if (payload.log) appendLog(payload.log);
}

function fail(error, action) {
  if (disposed) return;
  retryAction = action;
  $('#progressTitle').textContent = action === 'launch' ? '启动未完成' : action === 'install' ? '安装未完成' : '暂时无法准备';
  $('#progressMessage').textContent = String(error);
  $('#progressStage').textContent = '需要重试';
  $('#progressTrack').setAttribute('aria-valuetext', `操作失败，${Math.round(estimate)}%`);
  appendLog(error);
  retryButton.textContent = action === 'launch' ? '重新启动' : action === 'install' ? '返回并重试' : '重新连接';
  retryButton.hidden = false;
  showView('progressView', 'error');
}

async function subscribe(event, handler) {
  const unlisten = await api.event.listen(event, handler);
  // A subscription may resolve after the WebView has already navigated away.
  if (disposed) unlisten();
  else cleanups.push(unlisten);
}

let subscribed = false;
async function initialize() {
  let autoLaunch = true;
  if (busy || disposed) return;
  setBusy(true);
  retryButton.hidden = true;
  try {
    if (!api?.core?.invoke || !api?.event?.listen) throw new Error('请在 Neo Desktop 中打开此页面。');
    if (!subscribed) {
      // Roll back partial registration so initialization retries never duplicate events.
      const start = cleanups.length;
      try {
        await subscribe('install-progress', ({ payload }) => applyProgress(payload));
        if (disposed) return;
        await subscribe('runtime-log', ({ payload }) => appendLog(payload?.line));
        subscribed = true;
      } catch (error) {
        cleanups.splice(start).forEach((cleanup) => cleanup());
        throw error;
      }
    }
    if (disposed) return;
    const state = await api.core.invoke('bootstrap_state');
    if (disposed) return;
    autoLaunch = state.auto_launch !== false;
    installedDir = state.installed ? state.install_dir || '' : '';
    pathInput.value = installedDir || state.default_install_dir || '';
    initialized = true;
    enterButton.hidden = !installedDir;
    $('#readyMessage').textContent = '';
    $('#backendControls').hidden = !installedDir;
    await refreshBackend();
    showView('readyView', 'ready', false);
  } catch (error) {
    fail(error, 'initialize');
  } finally {
    if (!disposed) setBusy(false);
  }
  if (!disposed && initialized && installedDir && autoLaunch) await launch(installedDir);
}

async function launch(installDir) {
  if (busy || disposed) return;
  setBusy(true);
  retryButton.hidden = true;
  showView('launchView', 'launching');
  $('#launchMessage').textContent = '正在启动本地服务…';
  try {
    await api.core.invoke('launch_runtime', { installDir });
    if (!disposed) $('#launchMessage').textContent = '正在进入工作台…';
  } catch (error) {
    fail(error, 'launch');
  } finally {
    if (!disposed) setBusy(false);
  }
}

on($('#installForm'), 'submit', async (event) => {
  event.preventDefault();
  if (busy || !initialized || disposed) return;
  const installDir = pathInput.value.trim();
  if (!installDir) {
    $('#readyMessage').textContent = '请选择安装位置。';
    pathInput.focus();
    return;
  }
  setBusy(true);
  installLog.textContent = '';
  $('#logDetails').open = false;
  retryButton.hidden = true;
  showView('progressView', 'installing');
  applyProgress({ percent: 0, title: '准备运行环境', stage: '准备中', message: '正在检查内置资源…' });
  let completed = false;
  try {
    await api.core.invoke('install_runtime', { installDir });
    if (disposed) return;
    installedDir = installDir;
    enterButton.hidden = false;
    completed = true;
  } catch (error) {
    fail(error, 'install');
  } finally {
    if (!disposed) setBusy(false);
  }
  if (completed && !disposed) await launch(installDir);
});

on(browseButton, 'click', async () => {
  if (busy || !initialized || disposed) return;
  setBusy(true);
  try {
    const selected = await api.core.invoke('choose_install_directory', { initial: pathInput.value });
    if (!disposed && selected) pathInput.value = selected;
  } catch (error) {
    if (!disposed) $('#readyMessage').textContent = `无法选择目录：${String(error)}`;
  } finally {
    if (!disposed) { setBusy(false); browseButton.focus(); }
  }
});
on(enterButton, 'click', async () => {
  if (busy || !backendRunning) return;
  setBusy(true);
  try { await api.core.invoke('enter_application'); } catch(error) { $('#readyMessage').textContent = String(error); await refreshBackend(); } finally { if (!disposed) setBusy(false); }
});
on(retryButton, 'click', () => {
  if (busy || disposed) return;
  if (retryAction === 'initialize') return initialize();
  if (retryAction === 'launch') return launch(installedDir);
  showView('readyView', 'ready');
  pathInput.focus();
});

on(document, 'visibilitychange', () => {
  document.body.classList.toggle('page-hidden', document.hidden);
});
function dispose() {
  if (disposed) return;
  disposed = true;
  cleanups.splice(0).forEach((cleanup) => {
    try { cleanup(); } catch { /* WebView may already be disconnected. */ }
  });
}
on(window, 'pagehide', dispose);
on(window, 'beforeunload', dispose);
initialize();

async function refreshBackend() {
  try { backendRunning = (await api.core.invoke('runtime_status')) === true; } catch { backendRunning = false; }
  if (disposed) return;
  $('#backendStatus').textContent = backendRunning ? '核心和后台运行中' : '核心和后台已关闭';
  setBusy(busy);
}
for (const [id, command] of [['#startBackend','start_backend'],['#stopBackend','stop_backend']]) {
  on($(id), 'click', async () => {
    if (busy || disposed) return;
    setBusy(true);
    try { await api.core.invoke(command); } catch(error) { if(!disposed) $('#readyMessage').textContent = String(error); }
    finally { if (!disposed) { await refreshBackend(); setBusy(false); } }
  });
}
const statusTimer = setInterval(() => { if (!busy && !disposed && initialized && phase === 'ready') refreshBackend(); }, 2000);
cleanups.push(() => clearInterval(statusTimer));
