const invoke = window.__TAURI__.core.invoke;
const listen = window.__TAURI__.event.listen;

const views = [...document.querySelectorAll('.view')];
const pathInput = document.querySelector('#installPath');
const installButton = document.querySelector('#installButton');
const browseButton = document.querySelector('#browseButton');
const enterButton = document.querySelector('#enterButton');
const retryButton = document.querySelector('#retryButton');
const progressTitle = document.querySelector('#progressTitle');
const progressMessage = document.querySelector('#progressMessage');
const progressStage = document.querySelector('#progressStage');
const progressPercent = document.querySelector('#progressPercent');
const progressBar = document.querySelector('#progressBar');
const installLog = document.querySelector('#installLog');

function showView(id) {
  views.forEach((view) => view.classList.toggle('active', view.id === id));
}

function appendLog(line) {
  if (!line) return;
  installLog.textContent += `${line}\n`;
  if (installLog.textContent.length > 24000) installLog.textContent = installLog.textContent.slice(-18000);
  installLog.scrollTop = installLog.scrollHeight;
}

function applyProgress(payload) {
  const percent = Math.max(0, Math.min(100, Number(payload.percent || 0)));
  progressTitle.textContent = payload.title || '正在安装';
  progressMessage.textContent = payload.message || '';
  progressStage.textContent = payload.stage || '处理中';
  progressPercent.textContent = `${Math.round(percent)}%`;
  progressBar.style.width = `${percent}%`;
  if (payload.log) appendLog(payload.log);
}

async function initialize() {
  await listen('install-progress', ({ payload }) => applyProgress(payload));
  await listen('runtime-log', ({ payload }) => appendLog(payload.line));
  const state = await invoke('bootstrap_state');
  pathInput.value = state.default_install_dir;
  enterButton.classList.toggle('hidden', !state.installed);
  if (state.installed && state.install_dir) {
    pathInput.value = state.install_dir;
    showView('launchView');
    try {
      await invoke('launch_runtime', { installDir: state.install_dir });
    } catch (error) {
      showView('progressView');
      applyProgress({ title: '自动启动失败', stage: '需要处理', message: String(error), log: String(error) });
      retryButton.classList.remove('hidden');
    }
  }
}

browseButton.addEventListener('click', async () => {
  const selected = await invoke('choose_install_directory', { initial: pathInput.value });
  if (selected) pathInput.value = selected;
});

installButton.addEventListener('click', async () => {
  const installDir = pathInput.value.trim();
  if (!installDir) return pathInput.focus();
  installButton.disabled = true;
  installLog.textContent = '';
  retryButton.classList.add('hidden');
  showView('progressView');
  try {
    await invoke('install_runtime', { installDir });
    showView('launchView');
    await invoke('launch_runtime', { installDir });
  } catch (error) {
    applyProgress({ percent: 0, title: '安装未完成', stage: '发生错误', message: String(error), log: String(error) });
    retryButton.classList.remove('hidden');
  } finally {
    installButton.disabled = false;
  }
});

enterButton.addEventListener('click', async () => {
  showView('launchView');
  try {
    await invoke('launch_runtime', { installDir: pathInput.value.trim() });
  } catch (error) {
    showView('progressView');
    applyProgress({ title: '启动失败', stage: '需要处理', message: String(error), log: String(error) });
    retryButton.classList.remove('hidden');
  }
});

retryButton.addEventListener('click', () => showView('readyView'));

initialize().catch((error) => {
  showView('progressView');
  applyProgress({ title: '初始化失败', stage: '发生错误', message: String(error), log: String(error) });
  retryButton.classList.remove('hidden');
});
