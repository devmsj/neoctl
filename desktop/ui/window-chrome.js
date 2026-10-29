// Shared frontend chrome for both the bootstrap page and the local workspace.
(() => {
  // Keep native WebView/Edge menus out of desktop surfaces; app handlers still run.
  document.addEventListener('contextmenu', event => {
    if (window.__TAURI_INTERNALS__?.invoke || window.__TAURI__?.core?.invoke) event.preventDefault();
  }, true);
  const mount = () => {
    const invoke = window.__TAURI_INTERNALS__?.invoke || window.__TAURI__?.core?.invoke;
    if (!invoke || document.querySelector('neo-window-chrome')) return;
    document.documentElement.dataset.neoDesktop = '';
    document.documentElement.style.setProperty('--neo-window-inset', '36px');
    if (!document.getElementById('app')) document.body.style.paddingTop = '36px';
    const host = document.createElement('neo-window-chrome');
    const shadow = host.attachShadow({ mode: 'open' });
    const icons = {
      app: '<rect x="3.5" y="3.5" width="6" height="6" rx="1.2"/><rect x="14.5" y="3.5" width="6" height="6" rx="1.2"/><rect x="3.5" y="14.5" width="6" height="6" rx="1.2"/><rect x="14.5" y="14.5" width="6" height="6" rx="1.2"/>',
      layout: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M8 4v16m8-16v16"/>',
      settings: '<path d="m10 3-.6 2.2-1.8 1L5.4 6l-2 3.5L5 11v2l-1.6 1.5 2 3.5 2.2-.2 1.8 1L10 21h4l.6-2.2 1.8-1 2.2.2 2-3.5L19 13v-2l1.6-1.5-2-3.5-2.2.2-1.8-1L14 3Z"/><circle cx="12" cy="12" r="3"/>',
      pin: '<path d="M8 3h8M9 3v6l-3 4v2h12v-2l-3-4V3M12 15v6"/>',
      minimize: '<path d="M5 12h14"/>', maximize: '<rect x="5" y="5" width="14" height="14" rx="1.5"/>',
      restore: '<path d="M9 7V4h11v11h-3"/><rect x="4" y="9" width="11" height="11" rx="1"/>',
      close: '<path d="m6 6 12 12M18 6 6 18"/>', home: '<path d="m3 10 9-7 9 7M5 9v11h5v-6h4v6h5V9"/>',
      sessions: '<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>',
      update: '<path d="M20 7v5h-5M4 17v-5h5M20 12a8 8 0 0 0-14-5M4 12a8 8 0 0 0 14 5"/>',
      sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
      moon: '<path d="M20 15.5A8.5 8.5 0 0 1 8.5 4a8.5 8.5 0 1 0 11.5 11.5Z"/>',
      system: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/>',
      uninstall: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5M14 11v5"/>'
    };
    const svg = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name]}</svg>`;
    shadow.innerHTML = `<style>
      :host { position:fixed; inset:0; z-index:2000; pointer-events:none; color:var(--chrome-muted, var(--muted, #737983)); font-family:var(--chrome-sans, system-ui, sans-serif); font-size:12px; }
      * { box-sizing:border-box; }
      [hidden] { display:none !important; }
      svg { width:15px; height:15px; fill:none; stroke:currentColor; stroke-width:1.55; stroke-linecap:round; stroke-linejoin:round; }
      button { display:inline-flex; align-items:center; justify-content:center; gap:10px; margin:0; padding:0; border:0; border-radius:5px; background:transparent; color:inherit; font:inherit; cursor:pointer; pointer-events:auto; transition:background-color 130ms, color 130ms; }
      button:hover, button[aria-expanded=true] { background:var(--chrome-hover, #8882); color:var(--chrome-text, var(--ink, #333)); }
      button:focus-visible { outline:1px solid var(--chrome-accent, #bb8ea6); outline-offset:2px; }
      button:disabled { opacity:.45; cursor:wait; }
      .drag { position:absolute; top:0; left:clamp(168px, calc(28vw - 64px), 280px); right:var(--controls-width, 116px); height:34px; pointer-events:auto; user-select:none; }
      :host-context([data-controls-left=false]) .drag { left:42px; }
      .controls { position:absolute; top:4px; right:6px; display:flex; align-items:center; gap:3px; }
      .controls button { width:32px; height:28px; }
      .controls .accent-control { color:var(--appearance-accent, var(--chrome-accent, #8c456e)); }
      .controls .accent-control:hover { background:color-mix(in srgb, currentColor 12%, transparent); }
      .controls .accent-control[aria-pressed=true] { background:color-mix(in srgb, currentColor 20%, transparent); box-shadow:inset 0 0 0 1px color-mix(in srgb, currentColor 48%, transparent); }
      .controls .close:hover { color:#e8a1ae; background:#b6495926; }
      .app { position:absolute; left:14px; bottom:14px; width:30px; height:30px; }
      .app svg { width:17px; height:17px; }
      .menu { position:absolute; left:12px; bottom:52px; width:208px; padding:5px; border:1px solid var(--chrome-line, #8884); border-radius:7px; background:var(--neo-menu-background, linear-gradient(var(--chrome-surface, #fff),var(--chrome-surface, #fff)),linear-gradient(var(--chrome-bg, #fff),var(--chrome-bg, #fff)),var(--menu-base, #fff)); box-shadow:0 8px 26px #0002; pointer-events:auto; }
      :host-context([data-theme=dark]) { --menu-base:#111418; }
      .menu button { justify-content:flex-start; width:100%; min-height:36px; padding:0 10px; text-align:left; }
      .menu [data-theme-cycle] { color:var(--chrome-accent); }
      .menu hr { border:0; border-top:1px solid var(--chrome-line); margin:5px 8px; opacity:.7; }
      .menu { max-height:calc(100dvh - 64px); overflow-y:auto; }
      .menu button:last-child { margin-top:4px; color:var(--chrome-danger, #b66d7b); }
      .error { position:absolute; left:52px; bottom:14px; max-width:min(420px, calc(100vw - 72px)); padding:7px 10px; border:1px solid var(--chrome-line, #8884); border-radius:5px; background:var(--chrome-surface, var(--surface, #fff)); color:var(--chrome-danger, #b66d7b); pointer-events:auto; line-height:1.6; }
      @media(max-width:820px) { .app { bottom:auto; top:4px; left:8px; width:28px; height:28px; } .drag { left:42px; } .menu { top:38px; bottom:auto; left:8px; } }
      @media(prefers-reduced-motion:reduce) { button { transition:none; } }
    </style>
    <div class="drag" aria-hidden="true"></div>
    <div class="controls" role="group" aria-label="窗口控制">
      <button type="button" class="accent-control" data-controls-action hidden aria-label="显示控件" data-tooltip="显示控件" aria-expanded="false">${svg('layout')}</button>
      <button type="button" class="accent-control" data-settings-action hidden data-tooltip="全局配置" aria-label="全局配置">${svg('settings')}</button>
      <button type="button" class="accent-control" data-pin-action hidden aria-pressed="false" data-tooltip="窗口置顶" aria-label="窗口置顶">${svg('pin')}</button>
      <button type="button" data-window="minimize" data-tooltip="最小化" aria-label="最小化">${svg('minimize')}</button>
      <button type="button" data-window="toggle_maximize" data-tooltip="最大化" aria-label="最大化">${svg('maximize')}</button>
      <button type="button" class="close" data-window="close" data-tooltip="关闭" aria-label="关闭">${svg('close')}</button>
    </div>
    <button class="app" type="button" aria-label="应用菜单" data-tooltip="应用" aria-haspopup="menu" aria-expanded="false">${svg('app')}</button>
    <div class="menu" role="menu" aria-label="应用" hidden>
      <button type="button" role="menuitem" data-navigate="chat" hidden>${svg('home')}<span>回到对话</span></button>
      <button type="button" role="menuitem" data-navigate="sessions" hidden>${svg('sessions')}<span>会话管理</span></button>
      <hr data-workspace-menu hidden />
      <button type="button" role="menuitem" data-navigate="settings" hidden>${svg('settings')}<span>全局配置</span></button>
      <button type="button" role="menuitem" data-theme-cycle hidden></button>
      <hr data-workspace-menu hidden />
      <button type="button" role="menuitem" data-app="start_page">${svg('home')}<span>返回启动页</span></button>
      <button type="button" role="menuitem" data-app="check_updates">${svg('update')}<span>检查核心与 Web 更新</span></button>
      <button type="button" role="menuitem" data-app="uninstall">${svg('uninstall')}<span>卸载 Neo Desktop</span></button>
    </div><div class="error" role="status" hidden></div>`;
    document.body.append(host);
    const menu = shadow.querySelector('.menu'), app = shadow.querySelector('.app'), error = shadow.querySelector('.error');
    const setOpen = open => { menu.hidden = !open; app.setAttribute('aria-expanded', String(open)); };
    const settingsAction = shadow.querySelector('[data-settings-action]');
    settingsAction.addEventListener('click', () => { setOpen(false); window.dispatchEvent(new Event('neo:open-settings')); });
    shadow.querySelectorAll('[data-navigate]').forEach(button => button.addEventListener('click', () => {
      setOpen(false); window.dispatchEvent(new CustomEvent('neo:menu-navigate', { detail: { panel: button.dataset.navigate } })); app.focus();
    }));
    const controlsAction = shadow.querySelector('[data-controls-action]');
    controlsAction.addEventListener('click', () => { setOpen(false); window.dispatchEvent(new Event('neo:display-controls')); });
    const pinAction = shadow.querySelector('[data-pin-action]');
    const themeAction = shadow.querySelector('[data-theme-cycle]');
    let systemThemeRequest = 0;
    const refreshSystemTheme = async () => {
      const request = ++systemThemeRequest;
      try {
        const dark = await invoke('plugin:desktop-chrome|system_theme');
        if (request !== systemThemeRequest || typeof dark !== 'boolean') return;
        document.documentElement.dataset.neoSystemTheme = dark ? 'dark' : 'light';
        window.dispatchEvent(new Event('neo:system-theme'));
      } catch (e) { console.warn('System theme unavailable', e); }
    };
    window.addEventListener('focus', refreshSystemTheme);
    window.addEventListener('neo:system-theme-changed', refreshSystemTheme);
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', refreshSystemTheme);
    void refreshSystemTheme();
    const syncThemeAction = () => {
      const hidden = !document.documentElement.hasAttribute('data-neo-theme-ready');
      settingsAction.hidden = pinAction.hidden = controlsAction.hidden = hidden;
      controlsAction.setAttribute('aria-expanded', String(document.documentElement.dataset.controlsOpen === 'true'));
      themeAction.hidden = hidden;
      const mode = document.documentElement.dataset.appearanceMode || 'system';
      const [label, icon] = { light: ['切到夜间', 'moon'], dark: ['日夜跟随系统', 'system'], system: ['切到白天', 'sun'] }[mode];
      themeAction.innerHTML = `${svg(icon)}<span>${label}</span>`;
      themeAction.dataset.tooltip = label;
      shadow.querySelectorAll('[data-navigate], [data-workspace-menu]').forEach(el => { el.hidden = hidden; });
      host.style.setProperty('--controls-width', hidden ? '116px' : '221px');
      const inSettings = document.documentElement.dataset.neoPanel === 'settings';
      settingsAction.innerHTML = svg(inSettings ? 'home' : 'settings');
      settingsAction.dataset.tooltip = settingsAction.ariaLabel = inSettings ? '返回对话' : '全局配置';
    };
    themeAction.addEventListener('click', async () => {
      await refreshSystemTheme();
      window.dispatchEvent(new Event('neo:cycle-theme'));
    });
    new MutationObserver(syncThemeAction).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-appearance-mode', 'data-neo-theme-ready', 'data-neo-panel', 'data-controls-open', 'data-controls-left'] });
    syncThemeAction();
    let errorTimer, resizeTimer;
    const showError = value => { error.textContent = String(value); error.hidden = false; clearTimeout(errorTimer); errorTimer = setTimeout(() => { error.hidden = true; }, 7000); };
    const setPinned = value => {
      pinAction.setAttribute('aria-pressed', String(value));
      pinAction.dataset.tooltip = pinAction.ariaLabel = value ? '取消置顶' : '窗口置顶';
    };
    pinAction.addEventListener('click', async () => {
      if (pinAction.disabled) return;
      pinAction.disabled = true;
      try { setPinned(await invoke('plugin:desktop-chrome|window_action', { action: 'toggle_pin' })); }
      catch (e) { showError(e); }
      finally { pinAction.disabled = false; }
    });
    invoke('plugin:desktop-chrome|window_action', { action: 'pin_state' }).then(setPinned).catch(showError);
    const setMaximized = value => {
      const button = shadow.querySelector('[data-window=toggle_maximize]');
      button.innerHTML = svg(value ? 'restore' : 'maximize');
      button.dataset.tooltip = button.ariaLabel = value ? '还原窗口' : '最大化';
    };
    // Ask the workspace's themed guard before leaving its document. Browser
    // beforeunload prompts cannot be styled and must not be used in the shell.
    let leaving = false;
    const guardedLeave = async (reason, action) => {
      if (leaving) return;
      leaving = true;
      try {
        const pending = [];
        window.dispatchEvent(new CustomEvent('neo:before-leave', { detail: {
          reason, waitUntil: promise => pending.push(Promise.resolve(promise)),
        } }));
        if ((await Promise.all(pending)).some(allowed => allowed !== true)) return;
        await action();
      } catch (e) { showError(e); }
      finally { leaving = false; }
    };
    document.addEventListener('keydown', event => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === 'F5' || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'r')) {
        event.preventDefault(); event.stopImmediatePropagation();
        void guardedLeave('reload', () => location.reload());
      }
    }, true);
    const windowAction = async action => {
      try { setMaximized(await invoke('plugin:desktop-chrome|window_action', { action })); }
      catch (e) { showError(e); }
    };
    shadow.querySelectorAll('[data-window]').forEach(button => button.addEventListener('click', () => windowAction(button.dataset.window)));
    const drag = shadow.querySelector('.drag');
    drag.addEventListener('mousedown', event => { if (event.button === 0 && event.detail === 1) { event.preventDefault(); void windowAction('drag'); } });
    drag.addEventListener('dblclick', event => { if (event.button === 0) void windowAction('toggle_maximize'); });
    app.addEventListener('click', () => setOpen(menu.hidden));
    app.addEventListener('keydown', event => { if (event.key === 'ArrowDown') { event.preventDefault(); event.stopPropagation(); setOpen(true); menu.querySelector('button:not([hidden])').focus(); } });
    shadow.querySelectorAll('[data-app]').forEach(button => button.addEventListener('click', async () => {
      setOpen(false); button.disabled = true;
      try {
        const action = button.dataset.app;
        if (action === 'start_page' || action === 'uninstall') await guardedLeave(action, () => invoke('plugin:desktop-chrome|application_action', { action }));
        else await invoke('plugin:desktop-chrome|application_action', { action });
      }
      catch (e) { showError(e); }
      finally { button.disabled = false; }
    }));
    document.addEventListener('pointerdown', event => { if (!event.composedPath().includes(host)) setOpen(false); });
    document.addEventListener('keydown', event => {
      if (menu.hidden || event.isComposing || event.keyCode === 229 || event.target?.composing) return;
      if (event.key === 'Escape') { setOpen(false); app.focus(); }
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) && shadow.activeElement?.matches('[role=menuitem], [role=menuitemradio]')) {
        event.preventDefault(); const items = [...menu.querySelectorAll('button:not([hidden])')], index = items.indexOf(shadow.activeElement);
        items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
      }
    });
    window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => windowAction('state'), 180); });
    // Only theme/style changes trigger surface synchronization, never resize frames.
    let surfaceFrame = 0, lastSurface = '', pendingSurface, applyingSurface = false;
    async function flushSurface() {
      if (applyingSurface) return;
      applyingSurface = true;
      while (pendingSurface) {
        const next = pendingSurface; pendingSurface = undefined;
        try {
          const enabled = await invoke('plugin:desktop-chrome|sync_surface', next.args);
          lastSurface = next.key;
          if (!pendingSurface) document.documentElement.dataset.windowMaterial = enabled === true ? 'on' : 'off';
        } catch (e) {
          lastSurface = ''; document.documentElement.dataset.windowMaterial = 'off'; showError(e);
        }
      }
      applyingSurface = false;
    }
    const syncSurface = () => {
      cancelAnimationFrame(surfaceFrame);
      surfaceFrame = requestAnimationFrame(() => {
        const root = document.documentElement, style = getComputedStyle(root);
        const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
        const css = getComputedStyle(document.querySelector('.shell') || document.body).backgroundColor;
        const parts = css.match(/[\d.]+/g)?.map(Number);
        const seed = style.getPropertyValue('--appearance-bg').trim();
        const color = /^#[\da-f]{6}$/i.test(seed) ? [1, 3, 5].map(i => parseInt(seed.slice(i, i + 2), 16))
          : css.startsWith('rgb') && parts?.length >= 3 && (parts.length < 4 || parts[3] > 0) ? parts.slice(0, 3).map(Math.round) : dark ? [17, 20, 24] : [255, 255, 255];
        const workspace = !!document.querySelector('.shell');
        const transparency = workspace ? Math.max(0, Math.min(100, Number(style.getPropertyValue('--appearance-window-transparency')) || 0)) : 0;
        const frost = workspace ? Math.max(0, Math.min(2, Number(style.getPropertyValue('--appearance-window-frost')) || 0)) : 0;
        const themeMode = root.dataset.appearanceMode || 'system';
        const args = { dark, color, transparency: Math.round(transparency), frost: Math.round(frost), themeMode };
        // Tint strength stays in CSS; only preset/theme changes reconfigure native material.
        const key = JSON.stringify({ ...args, transparency: transparency > 0 });
        if (!applyingSurface && key === lastSurface) return;
        pendingSurface = { key, args }; void flushSurface();
      });
    };
    new MutationObserver(syncSurface).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-appearance-mode', 'style', 'class'] });
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', syncSurface);
    window.addEventListener('load', syncSurface, { once: true });
    syncSurface();
    void windowAction('state');
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true }); else mount();
})();
