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
let runtimeComplete = false;
let externalRuntime = false;
let retryAction = 'initialize';
let phase = 'booting';
let cleanupPending = false;
let directoryNeedsCleanup = false;
let estimate = 0;
let entryTimer = null, finishEntryWait = null;
let lastProgressMessage = '';
const ENTRY_DURATION = 2000;

function on(target, event, handler) {
  target.addEventListener(event, handler);
  cleanups.push(() => target.removeEventListener(event, handler));
}

function showView(id, state, focus = true) {
  if (disposed) return;
  phase = state;
  document.body.dataset.state = state;
  document.body.dataset.light = state === 'ready' ? (installedDir ? 'ready' : 'welcome') : state === 'error' ? 'error' : 'busy';
  views.forEach((view) => { view.hidden = view.id !== id; });
  if (focus) $(`#${id.replace('View', 'Title')}`)?.focus({ preventScroll: true });
}

function setBusy(value) {
  busy = value;
  installButton.disabled = value || !initialized || backendRunning || directoryNeedsCleanup;
  $('#clearInstallDirectory').disabled = value || Boolean(installedDir);
  browseButton.disabled = value || !initialized || Boolean(installedDir);
  pathInput.disabled = value || !initialized;
  enterButton.disabled = value || !installedDir || !runtimeComplete || (externalRuntime && !backendRunning);
  $('#startBackend').disabled = value || !installedDir || backendRunning;
  $('#stopBackend').disabled = value || !backendRunning;
  updateButton.disabled = value || !installedDir || externalRuntime;
  $('#cleanupRuntime').disabled = value || !installedDir || externalRuntime;
  retryButton.disabled = value;
  enterButton.setAttribute('aria-busy', String(value));
}

function appendLog(line) {
  if (disposed || !String(line ?? '').trim()) return;
  $('#logDetails').hidden = false;
  const follow = installLog.scrollHeight - installLog.scrollTop - installLog.clientHeight < 32;
  installLog.textContent = `${installLog.textContent}${String(line)}\n`;
  if (installLog.textContent.length > 24000) installLog.textContent = installLog.textContent.slice(-18000);
  if (follow) installLog.scrollTop = installLog.scrollHeight;
}

function applyProgress(payload = {}) {
  if (disposed || !['installing', 'updating'].includes(phase)) return;
  const value = Number(payload.percent);
  if (Number.isFinite(value)) estimate = Math.max(estimate, Math.max(0, Math.min(100, value)));
  $('#progressTitle').textContent = phase === 'updating' ? '正在更新运行环境' : '正在安装工作台';
  $('#progressMessage').textContent = payload.message || '';
  if (payload.stage) $('#progressStage').textContent = payload.stage;
  $('#progressTrack').dataset.active = String(estimate >= 30 && estimate < 72);
  $('#progressTrack').setAttribute('aria-label', phase === 'updating' ? '更新阶段进度' : '安装阶段进度');
  $('#progressPercent').textContent = `${Math.round(estimate)}%`;
  $('#progressBar').style.transform = `scaleX(${estimate / 100})`;
  $('#progressTrack').setAttribute('aria-valuenow', String(estimate));
  $('#progressTrack').setAttribute('aria-valuetext', `${payload.stage || '准备中'}，${Math.round(estimate)}%`);
  if (payload.message && payload.message !== lastProgressMessage) appendLog(payload.message);
  if (payload.message) lastProgressMessage = payload.message;
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
  $('#logDetails').open = true;
  const retryLabel = action === 'refresh-install' ? '重新读取位置并启动' : action === 'launch' ? '重新启动' : action === 'update' ? '返回启动页' : action === 'install' ? '返回并重试' : '重新连接';
  $('#retryLabel').textContent = retryLabel;
  retryButton.setAttribute('aria-label', retryLabel);
  retryButton.setAttribute('data-tooltip', retryLabel);
  retryButton.hidden = false;
  showView('progressView', 'error');
  // Reveal the actual failure even when the log panel just became visible.
  window.requestAnimationFrame?.(() => { if (!disposed) installLog.scrollTop = installLog.scrollHeight; });
}

async function subscribe(event, handler) {
  const unlisten = await api.event.listen(event, handler);
  // A subscription may resolve after the WebView has already navigated away.
  if (disposed) unlisten();
  else cleanups.push(unlisten);
}

function updatePathDisplay() {
  const path = pathInput.value.trim() || defaultDir;
  $('#pathDisplay').textContent = path;
  $('#pathName').textContent = path || '—';
  $('#pathName').setAttribute('data-tooltip', path);
  $('#pathOptions').setAttribute('aria-label', installedDir ? '查看数据位置' : '更改安装位置');
}
on(pathInput, 'input', () => { directoryNeedsCleanup = false; $('#clearInstallDirectory').hidden = true; updatePathDisplay(); setBusy(busy); });

function setVersions(state) {
  const web = state.web_version || '未知', core = state.core_version || '未知';
  $('#versionStatus').textContent = installedDir ? `Web ${web} / Core ${core}` : '';
}

function applyBootstrap(state) {
  // Any configured path is existing data, even if runtime validation failed.
  if (state.installed && !state.install_dir) throw new Error('已有安装缺少数据位置，请检查配置后重试。');
  externalRuntime = state.external_runtime === true;
  runtimeComplete = state.installed === true;
  installedDir = state.install_dir || '';
  document.body.dataset.installed = String(Boolean(installedDir));
  $('#startBackend').hidden = true;
  $('#stopBackend').hidden = externalRuntime;
  updateButton.hidden = externalRuntime;
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
  $('#readyTitle').textContent = installedDir ? (externalRuntime ? '本地开发服务' : state.installed ? 'Neo Desktop' : '运行环境需要更新') : '安装工作台';
  $('#readyMessage').textContent = installedDir ? (state.installed ? '' : '保留原位置与工作数据，请更新运行环境。') : '首次安装需联网。';
  setVersions(state);
  $('#backendControls').hidden = !installedDir;
  setCleanup(state.cleanup_pending ? ['检测到上次更新的清理或恢复任务，将重试删除非当前版本。'] : []);
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
    if (!installedDir) await checkInstallDirectory();
    if (cleanupPending && !externalRuntime) await retryCleanup();
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
    await api.core.invoke('launch_runtime', { installDir, deferNavigation: true });
    if (!disposed) await enterWithLight();
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
  $('#logDetails').hidden = true;
  $('#logDetails').open = false;
  estimate = 0; lastProgressMessage = '';
  retryButton.hidden = true;
  showView('progressView', 'installing');
  applyProgress({ percent: 0, title: '准备运行环境', stage: '准备中', message: '正在准备安装…', log: '正在准备内置 Node.js，将联网获取最新 Web 与其兼容的 Core…' });
  let completed = false;
  try {
    const inspection = await api.core.invoke('inspect_install_directory', { installDir });
    if (disposed) return;
    if (inspection?.nonempty) { showDirectoryContents(inspection); showView('readyView', 'ready'); return; }
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
  if (busy || disposed || !installedDir || externalRuntime) return;
  setBusy(true);
  installLog.textContent = '';
  $('#logDetails').hidden = true;
  $('#logDetails').open = false;
  estimate = 0; lastProgressMessage = '';
  retryButton.hidden = true;
  showView('progressView', 'updating');
  applyProgress({ percent: 0, title: '准备更新 Web 和 Core', stage: '准备中', message: '正在连接软件源…' });
  try {
    const versions = await api.core.invoke('update_runtime');
    if (disposed) return;
    runtimeComplete = true;
    $('#readyTitle').textContent = 'Neo Desktop';
    setVersions(versions);
    setCleanup(versions.cleanup_pending || []);
    $('#readyMessage').textContent = cleanupPending ? '新版本已启用，旧版本清理未完成。' : '更新完成，旧版本已删除。';
    await refreshBackend();
    if (disposed) return;
    showView('readyView', 'ready');
  } catch (error) {
    try { const state = await api.core.invoke('bootstrap_state'); if (!disposed) applyBootstrap(state); } catch { /* retain original update error */ }
    await refreshBackend();
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
    if (!disposed && selected) { pathInput.value = selected; updatePathDisplay(); await checkInstallDirectory(); }
  } catch (error) {
    if (!disposed) { appendLog(error); $('#readyMessage').textContent = '无法选择目录，请重试或手动输入。'; }
  } finally {
    if (!disposed) { setBusy(false); browseButton.focus(); }
  }
});
async function enterWithLight() {
  if (disposed) return;
  phase = 'entering';
  document.body.dataset.state = 'entering';
  document.body.dataset.light = 'entering';
  $('.shell').inert = true;
  await new Promise(resolve => {
    finishEntryWait = resolve;
    entryTimer = setTimeout(resolve, ENTRY_DURATION);
  });
  entryTimer = null; finishEntryWait = null;
  if (disposed) return;
  try { await api.core.invoke('enter_application'); }
  finally { if (!disposed) $('.shell').inert = false; }
}
on(enterButton, 'click', async () => {
  if (busy || disposed || !installedDir || !runtimeComplete || (externalRuntime && !backendRunning)) return;
  if (!backendRunning) return launch(installedDir);
  setBusy(true);
  try { await enterWithLight(); }
  catch (error) { if (!disposed) { fail(error, 'launch'); await refreshBackend(); } }
  finally { if (!disposed) setBusy(false); }
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
  if (entryTimer !== null) clearTimeout(entryTimer);
  finishEntryWait?.(); finishEntryWait = null;
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
  const status = backendRunning ? '已就绪' : externalRuntime ? '开发服务未连接' : '未启动';
  enterButton.setAttribute('data-tooltip', backendRunning ? '进入应用' : '启动并进入');
  enterButton.setAttribute('aria-label', backendRunning ? '进入应用' : '启动并进入');
  $('#enterLabel').textContent = backendRunning ? '进入工作台' : '启动工作台';
  $('#stopBackend').hidden = externalRuntime || !backendRunning;
  $('#backendStatus').textContent = status;
  $('#logDetails').hidden = !installLog.textContent.trim();
  $('#runtimeIndicator').dataset.running = String(backendRunning);
  $('#runtimeIndicator').setAttribute('data-tooltip', status);
  $('#runtimeIndicator').setAttribute('aria-label', status);
  setBusy(busy);
}
for (const [id, command] of [['#startBackend','start_backend'],['#stopBackend','stop_backend']]) {
  on($(id), 'click', async () => {
    if (busy || disposed || externalRuntime) return;
    setBusy(true);
    try { await api.core.invoke(command); } catch(error) { if(!disposed) { $('#readyMessage').textContent = '未能启动，详情见日志。'; appendLog(error); $('#logDetails').open = true; } }
    finally { if (!disposed) { await refreshBackend(); setBusy(false); } }
  });
}
const statusTimer = setInterval(() => { if (!busy && !disposed && initialized && phase === 'ready') refreshBackend(); }, 2000);
cleanups.push(() => clearInterval(statusTimer));


function setCleanup(warnings) {
  cleanupPending = warnings.length > 0;
  $('#cleanupRuntime').hidden = !cleanupPending || externalRuntime;
  $('#cleanupStatus').hidden = !cleanupPending;
  $('#cleanupStatus').textContent = warnings.join('\n');
}
async function retryCleanup() {
  if (busy || disposed || !installedDir || externalRuntime) return;
  setBusy(true);
  try {
    const warnings = await api.core.invoke('cleanup_runtime');
    if (disposed) return;
    setCleanup(warnings || []);
    if (!cleanupPending) $('#readyMessage').textContent = '旧版本已删除，仅保留当前版本。';
  } catch (error) {
    if (!disposed) setCleanup([String(error)]);
  } finally { if (!disposed) setBusy(false); }
}
on($('#cleanupRuntime'), 'click', retryCleanup);


function showDirectoryContents(info) {
  directoryNeedsCleanup = Boolean(info?.nonempty);
  $('#clearInstallDirectory').hidden = !directoryNeedsCleanup;
  if (directoryNeedsCleanup) $('#readyMessage').textContent = `此目录已有内容：${(info.entries || []).slice(0, 8).join('、')}。请先备份，再选择清空，或更换目录；不会自动覆盖。`;
  setBusy(busy);
}
async function checkInstallDirectory() {
  if (disposed || installedDir) return;
  const installDir = pathInput.value.trim() || defaultDir;
  const info = await api.core.invoke('inspect_install_directory', { installDir });
  if (!disposed) showDirectoryContents(info);
}
on($('#clearInstallDirectory'), 'click', async () => {
  if (busy || disposed || installedDir) return;
  setBusy(true);
  try {
    const installDir = pathInput.value.trim() || defaultDir;
    const cleared = await api.core.invoke('clear_install_directory', { installDir });
    if (disposed || !cleared) return;
    const info = await api.core.invoke('inspect_install_directory', { installDir });
    if (disposed) return;
    showDirectoryContents(info);
    if (info?.nonempty) throw new Error('目录仍有内容，清理未完成，不允许安装。');
    $('#readyMessage').textContent = '已验证目录为空且可写，可以安装。';
  } catch (error) {
    if (!disposed) { directoryNeedsCleanup = true; $('#clearInstallDirectory').hidden = false; $('#readyMessage').textContent = String(error); }
  } finally { if (!disposed) setBusy(false); }
});
