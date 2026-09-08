'use strict';

// Presentation only: command names and payloads are the existing Tauri contract.
const api = window.__TAURI__;
const $ = (selector) => document.querySelector(selector);
const views = [...document.querySelectorAll('.view')];
const pathInput = $('#installPath');
const installButton = $('#installButton');
const browseButton = $('#browseButton');
const enterButton = $('#enterButton');
const updateButton = $('#updateRuntime');
const retryButton = $('#retryButton');
const installLog = $('#installLog');
const cleanups = [];
let disposed = false;
let busy = false;
let initialized = false;
let installedDir = '';
let defaultDir = '';
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
  browseButton.disabled = value || !initialized || Boolean(installedDir);
  pathInput.disabled = value || !initialized;
  enterButton.disabled = value || !backendRunning;
  $('#startBackend').disabled = value || !installedDir || backendRunning;
  $('#stopBackend').disabled = value || !backendRunning;
  updateButton.disabled = value || !installedDir || backendRunning;
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
  if (disposed || !['installing', 'updating'].includes(phase)) return;
  const value = Number(payload.percent);
  if (Number.isFinite(value)) estimate = Math.max(0, Math.min(100, value));
  $('#progressTitle').textContent = payload.title || '正在安装';
  $('#progressMessage').textContent = payload.message || '';
  $('#progressStage').textContent = payload.stage || '准备中';
  $('#progressPercent').textContent = `${Math.round(estimate)}%`;
  $('#progressBar').style.transform = `scaleX(${estimate / 100})`;
  $('#progressTrack').setAttribute('aria-valuenow', String(estimate));
  $('#progressTrack').setAttribute('aria-valuetext', `${payload.stage || '准备中'}，${Math.round(estimate)}%`);
  if (payload.message) appendLog(payload.message);
  if (payload.log && payload.log !== payload.message) appendLog(payload.log);
}

function fail(error, action) {
  if (disposed) return;
  retryAction = action;
  $('#progressTitle').textContent = action === 'launch' ? '启动未完成' : action === 'install' ? '安装未完成' : action === 'update' ? '更新未完成' : '暂时无法准备';
  $('#progressMessage').textContent = action === 'install' ? '请重试，或更改目录。详情见日志。' : '请重试，详情见日志。';
  $('#progressStage').textContent = '需要重试';
  $('#progressTrack').setAttribute('aria-valuetext', `操作失败，${Math.round(estimate)}%`);
  appendLog(error);
  retryButton.textContent = action === 'launch' ? '重新启动' : action === 'update' ? '返回启动页' : action === 'install' ? '返回并重试' : '重新连接';
  if (action === 'refresh-install') retryButton.textContent = '重新读取位置并启动';
  retryButton.hidden = false;
  showView('progressView', 'error');
}

async function subscribe(event, handler) {
  const unlisten = await api.event.listen(event, handler);
  // A subscription may resolve after the WebView has already navigated away.
  if (disposed) unlisten();
  else cleanups.push(unlisten);
}

function updatePathDisplay() {
  $('#pathDisplay').textContent = `${installedDir ? '数据位置' : '安装位置'}：${pathInput.value.trim() || defaultDir}`;
}
on(pathInput, 'input', updatePathDisplay);

function applyBootstrap(state) {
  // Any configured path is existing data, even if runtime validation failed.
  if (state.installed && !state.install_dir) throw new Error('已有安装缺少数据位置，请检查配置后重试。');
  installedDir = state.install_dir || '';
  defaultDir = state.default_install_dir || '';
  pathInput.value = installedDir || defaultDir;
  updatePathDisplay();
  $('#pathOptions').open = false;
  $('#pathSummary').textContent = installedDir ? '查看目录（只读）' : '更改目录';
  initialized = true;
  enterButton.hidden = !installedDir;
  installButton.hidden = Boolean(installedDir);
  browseButton.disabled = Boolean(installedDir);
  pathInput.readOnly = Boolean(installedDir);
  $('#readyTitle').textContent = installedDir ? 'Neo 启动页' : '安装 Neo';
  $('#readyMessage').textContent = installedDir ? '' : '首次安装需联网。';
  $('#versionStatus').textContent = installedDir
    ? `当前 Web ${state.web_version || '未知'} / Core ${state.core_version || '未知'}。`
    : '';
  $('#backendControls').hidden = !installedDir;
}

async function finishInstall() {
  if (busy || disposed) return;
  setBusy(true);
  let ready = false;
  try {
    const state = await api.core.invoke('bootstrap_state');
    if (disposed) return;
    if (!state.installed || !state.install_dir) throw new Error('安装已完成，但未能确认最终数据位置。请重新读取后启动。');
    applyBootstrap(state);
    ready = true;
  } catch (error) {
    fail(error, 'refresh-install');
  } finally {
    if (!disposed) setBusy(false);
  }
  if (ready && !disposed) await launch(installedDir);
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
    autoLaunch = state.installed && state.auto_launch !== false;
    applyBootstrap(state);
    await refreshBackend();
    setBusy(false);
    showView('readyView', 'ready', false);
  } catch (error) {
    autoLaunch = false;
    initialized = false;
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
  if (busy || !initialized || disposed || installedDir) return;
  const installDir = pathInput.value.trim() || defaultDir;
  if (!installDir) {
    $('#readyMessage').textContent = '请选择安装位置。';
    $('#pathOptions').open = true;
    pathInput.focus();
    return;
  }
  setBusy(true);
  installLog.textContent = '';
  $('#logDetails').open = false;
  retryButton.hidden = true;
  showView('progressView', 'installing');
  applyProgress({ percent: 0, title: '准备运行环境', stage: '准备中', message: '正在准备安装…', log: '正在准备内置 Node.js，将联网获取最新 Web 与其兼容的 Core…' });
  let completed = false;
  try {
    await api.core.invoke('install_runtime', { installDir });
    if (disposed) return;
    completed = true;
  } catch (error) {
    fail(error, 'install');
  } finally {
    if (!disposed) setBusy(false);
  }
  if (completed && !disposed) await finishInstall();
});

on(updateButton, 'click', async () => {
  if (busy || disposed || !installedDir || backendRunning) return;
  setBusy(true);
  installLog.textContent = '';
  $('#logDetails').open = false;
  retryButton.hidden = true;
  showView('progressView', 'updating');
  applyProgress({ percent: 0, title: '准备更新 Web 和 Core', stage: '准备中', message: '正在连接软件源…' });
  try {
    const versions = await api.core.invoke('update_runtime');
    if (disposed) return;
    $('#versionStatus').textContent = `当前 Web ${versions.web_version} / Core ${versions.core_version}。`;
    $('#readyMessage').textContent = '更新完成。';
    showView('readyView', 'ready');
  } catch (error) {
    fail(error, 'update');
  } finally {
    if (!disposed) setBusy(false);
  }
});

on(browseButton, 'click', async () => {
  if (busy || !initialized || disposed || installedDir) return;
  setBusy(true);
  try {
    const selected = await api.core.invoke('choose_install_directory', { initial: pathInput.value });
    if (!disposed && selected) { pathInput.value = selected; updatePathDisplay(); }
  } catch (error) {
    if (!disposed) { appendLog(error); $('#readyMessage').textContent = '无法选择目录，请重试或手动输入。'; }
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
  if (retryAction === 'refresh-install') return finishInstall();
  if (retryAction === 'initialize') return initialize();
  if (retryAction === 'launch') return launch(installedDir);
  $('#readyMessage').textContent = $('#progressMessage').textContent;
  showView('readyView', 'ready');
  if (retryAction === 'install') {
    $('#pathOptions').open = true;
    pathInput.focus();
  } else updateButton.focus();
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
