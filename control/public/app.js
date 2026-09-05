/* Neo Control: same-origin admin console. No dependencies or persistent secrets. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const TOKEN_KEY = 'neo-control-token';
  const MODEL_KEYS = new Set(['apiKey', 'baseUrl', 'model', 'endpoint', 'reasoningEffort', 'reasoningSummary', 'maxOutputTokens', 'timeoutMs', 'streamIdleTimeoutMs', 'maxRetries']);
  let token = '', epoch = 0, refreshing = false, dirty = false, editingId = null, jsonDirty = false;
  let state = { devices: [], profiles: [], sessions: [], broadcastProfileId: null };
  let modelProfile = { provider: 'openai', values: {} };
  let previewSession = null, previewGeneration = 0, successTimer;
  const selected = new Set();
  try { token = sessionStorage.getItem(TOKEN_KEY) || ''; } catch { /* Memory-only fallback. */ }
  const text = (id, value) => { $(id).textContent = String(value ?? ''); };
  const showError = (message, target = 'global-error') => {
    if (target === 'global-error') text('global-error-text', message);
    else text(target, message);
    $(target).hidden = !message;
  };
  function success(message) {
    text('global-success', message); $('global-success').hidden = false;
    clearTimeout(successTimer); successTimer = setTimeout(() => { $('global-success').hidden = true; }, 5500);
  }
  function connection(connected, message) {
    $('connection-dot').classList.toggle('connected', connected);
    text('connection-text', message);
    text('auth-button', token ? '管理令牌' : '设置令牌');
  }
  function node(tag, className, content) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (content !== undefined) el.textContent = String(content);
    return el;
  }
  function button(label, action, className = 'button button-quiet button-small') {
    const el = node('button', className, label); el.type = 'button'; el.addEventListener('click', action); return el;
  }
  function date(value) {
    if (!value) return '尚未连接';
    const d = new Date(value); return Number.isNaN(d.getTime()) ? '未知时间' : d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  }
  async function api(path, method = 'GET', body) {
    if (!token) throw new Error('请先设置管理员令牌。');
    const requestEpoch = epoch;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(path, { method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store', credentials: 'same-origin', signal: controller.signal });
      const data = await response.json().catch(() => ({}));
      if (requestEpoch !== epoch) throw new Error('管理连接已切换，请重试。');
      if (!response.ok) {
        if (response.status === 401) connection(false, '令牌无效');
        throw new Error(response.status === 401 ? '管理员令牌无效或已过期，请重新设置。' : `请求失败 (${response.status})：${data.error || response.statusText}`);
      }
      return data;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('请求超时，请检查服务连接后重试。');
      throw error;
    } finally { clearTimeout(timeout); }
  }
  async function action(el, work, errorTarget = 'global-error') {
    if (el.disabled) return;
    el.disabled = true;
    try { showError('', errorTarget); await work(); }
    catch (error) { showError(error.message, errorTarget); }
    finally { el.disabled = false; updateSelection(); }
  }
  const reportingRequests = new Set();
  let refreshTimer, stateRevision = 0, refreshPromise;
  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    if (token) refreshTimer = setTimeout(() => refresh(), document.hidden ? 30000 : state.broadcastStatus?.counts?.pending > 0 ? 1000 : 5000);
  }
  function refresh(force = false) {
    clearTimeout(refreshTimer);
    if (!token) return Promise.resolve(false);
    if (refreshing) return force ? refreshPromise.then(() => refresh(true)) : refreshPromise;
    refreshing = true;
    refreshPromise = fetchState();
    return refreshPromise;
  }
  async function fetchState() {
    const revision = stateRevision;
    try {
      const data = await api('/api/state');
      if (!Array.isArray(data.devices) || !Array.isArray(data.profiles) || !Array.isArray(data.sessions)) throw new Error('服务器返回了无效的工作空间数据。');
      if (revision !== stateRevision) return false;
      state = data;
      const ids = new Set(state.devices.map(d => d.deviceId));
      for (const id of selected) if (!ids.has(id)) selected.delete(id);
      render(); connection(true, '已连接'); text('last-refresh', `最近同步 ${new Date().toLocaleTimeString('zh-CN')}`);
      return true;
    } catch (error) { connection(false, '同步失败'); showError(error.message); return false; }
    finally { refreshing = false; scheduleRefresh(); }
  }
  function options(id, entries, placeholder) {
    const select = $(id), value = select.value;
    const signature = JSON.stringify(entries);
    if (select.dataset.signature === signature) return;
    select.dataset.signature = signature;
    select.replaceChildren(new Option(placeholder, ''));
    for (const [key, label] of entries) select.add(new Option(label, key));
    if (entries.some(([key]) => key === value)) select.value = value;
  }
  function visibleDevices() {
    const query = $('device-search').value.trim().toLocaleLowerCase();
    return state.devices.filter(d => !query || [d.name, d.deviceId, d.ip, d.machineCode, d.hostname, d.model, d.platform].some(v => String(v || '').toLocaleLowerCase().includes(query)));
  }
  function updateSelection() {
    text('selected-count', `已选 ${selected.size} 台`);
    $('dispatch-button').disabled = !selected.size || !$('dispatch-profile').value;
    $('clear-selection').disabled = !selected.size;
    const visible = visibleDevices(), count = visible.filter(d => selected.has(d.deviceId)).length;
    $('select-all').checked = visible.length > 0 && count === visible.length;
    $('select-all').indeterminate = count > 0 && count < visible.length;
    $('select-all').disabled = !visible.length;
  }
  function renderDevices() {
    // Keep focused controls in place when polling has not changed device data.
    const devices = visibleDevices();
    const signature = JSON.stringify([devices, [...selected], [...reportingRequests]]);
    const rows = $('device-rows');
    if (rows.dataset.signature !== signature) {
      rows.dataset.signature = signature; rows.replaceChildren();
      for (const d of devices) {
        const tr = node('tr', selected.has(d.deviceId) ? 'selected-row' : '');
        const checkCell = node('td', 'checkbox-cell'), checkbox = document.createElement('input');
        checkbox.type = 'checkbox'; checkbox.checked = selected.has(d.deviceId); checkbox.setAttribute('aria-label', `选择 ${d.name || d.deviceId}`);
        checkbox.addEventListener('change', () => { if (checkbox.checked) selected.add(d.deviceId); else selected.delete(d.deviceId); tr.classList.toggle('selected-row', checkbox.checked); updateSelection(); });
        checkCell.append(checkbox); tr.append(checkCell);
        const nameCell = node('td'); nameCell.append(node('strong', 'device-name', d.name || d.hostname || '未命名设备'), node('span', 'cell-secondary mono', d.deviceId));
        const network = node('td'); network.append(node('span', 'mono', d.ip || '等待连接'), node('span', 'cell-secondary mono', d.machineCode || '暂无机器码'));
        const system = node('td'); system.append(node('span', '', d.platform || '—'), node('span', 'cell-secondary', d.model || d.hostname || '—'));
        const status = node('td'); status.append(node('span', `badge ${d.online ? 'badge-online' : 'badge-neutral'}`, d.online ? '● 在线' : '○ 离线'), node('span', 'cell-secondary', date(d.lastSeen)));
        if (d.pendingCommand) status.append(node('span', 'cell-secondary pending-label', '配置待确认'));
        const blocked = d.reportingBlocked === true;
        status.append(node('span', 'cell-secondary', blocked ? '会话上报已暂停' : '会话上报正常'));
        const reporting = button(blocked ? '恢复上报' : '暂停上报', () => toggleReporting(d));
        reporting.disabled = reportingRequests.has(d.deviceId);
        reporting.setAttribute('aria-describedby', 'reporting-help');
        const controls = node('td', 'row-actions'); controls.append(reporting); controls.append(button('备注', () => renameDevice(d)), button('移除', () => removeDevice(d), 'button button-danger button-small'));
        tr.append(nameCell, network, system, status, controls); rows.append(tr);
      }
    }
    $('devices-empty').hidden = devices.length > 0;
    const empty = $('devices-empty'); empty.querySelector('strong').textContent = state.devices.length ? '没有匹配的设备' : '还没有设备';
    empty.querySelector('p').textContent = state.devices.length ? '试试其他名称、IP 或机器码。' : '启动已内置控制配置的定制客户端后，设备将自动注册。';
    updateSelection();
  }
  async function toggleReporting(d) {
    if (reportingRequests.has(d.deviceId)) return;
    reportingRequests.add(d.deviceId); renderDevices(); showError('');
    try {
      await api('/api/devices/' + encodeURIComponent(d.deviceId), 'PATCH', { reportingBlocked: d.reportingBlocked !== true });
      stateRevision++;
      if (!await refresh(true)) showError('设置请求已提交，但同步失败，请刷新确认；当前显示最后一次确认的状态。');
      else if (state.devices.find(device => device.deviceId === d.deviceId)?.reportingBlocked !== (d.reportingBlocked !== true)) showError('服务端尚未确认请求的上报状态，请刷新确认或检查服务版本。');
      else success('上报设置已同步。仅影响会话上报，心跳 / 广播不受影响；已有历史不删除，恢复后补传。');
    } catch { showError('上报设置失败，未确认状态变更，请刷新确认或重试。'); }
    finally { reportingRequests.delete(d.deviceId); renderDevices(); }
  }
  function renderBroadcast() {
    const broadcast = state.broadcastStatus, list = $('broadcast-clients');
    list.replaceChildren(); text('broadcast-summary', ''); text('broadcast-meta', '');
    $('broadcast-details').hidden = !broadcast;
    text('broadcast-empty', broadcast ? '' : state.broadcastProfileId ? '当前服务未提供广播确认状态，无法确认成功数量。' : '暂无当前广播，不显示成功统计。');
    if (!broadcast) return;
    const c = broadcast.counts;
    text('broadcast-summary', '共 ' + c.total + ' 台 · 成功 ' + c.succeeded + ' · 待确认 ' + c.pending + ' · 被定向覆盖 ' + c.superseded);
    text('broadcast-meta', '广播 ' + broadcast.id + ' · 创建于 ' + date(broadcast.createdAt));
    const labels = { pending: '待确认', succeeded: '成功（已应用 ACK）', superseded: '被定向覆盖' };
    for (const client of broadcast.clients) {
      const row = node('li', 'broadcast-client');
      row.append(node('strong', '', client.name || client.deviceId), node('span', 'mono', client.deviceId),
        node('span', 'badge ' + (client.online ? 'badge-online' : 'badge-neutral'), client.online ? '在线' : '离线'),
        node('span', 'badge ' + (client.status === 'succeeded' ? 'badge-online' : 'badge-neutral'), labels[client.status] || '未知状态'));
      row.append(node('span', 'broadcast-time', '成功确认：' + (client.status === 'succeeded' && typeof client.acknowledgedAt === 'number' ? new Date(client.acknowledgedAt).toLocaleString('zh-CN') : '—')));
      list.append(row);
    }
  }
  async function renameDevice(d) {
    const name = window.prompt('修改设备备注', d.name || '');
    if (name === null || name === d.name) return;
    if (!name.trim() || name.length > 120) { showError('备注应为 1–120 个字符。'); return; }
    try { await api(`/api/devices/${encodeURIComponent(d.deviceId)}`, 'PATCH', { name: name.trim() }); success('设备备注已更新。'); await refresh(true); }
    catch (error) { showError(error.message); }
  }
  async function removeDevice(d) {
    if (!window.confirm(`移除「${d.name || d.deviceId}」？该设备 ID 将被永久撤销，无法再次注册或同步。`)) return;
    try { await api(`/api/devices/${encodeURIComponent(d.deviceId)}`, 'DELETE'); selected.delete(d.deviceId); success('设备已移除。'); await refresh(true); }
    catch (error) { showError(error.message); }
  }
  function renderProfiles() {
    const entries = state.profiles.map(p => [p.id, p.name]);
    options('dispatch-profile', entries, '选择配置存档'); options('broadcast-profile', entries, '选择广播配置');
    const current = state.profiles.find(p => p.id === state.broadcastProfileId);
    text('broadcast-status', current ? `正在广播：${current.name} · 包含离线及新设备` : '当前未广播');
    renderBroadcast();
    $('stop-broadcast').disabled = !state.broadcastProfileId;
    $('broadcast-button').disabled = !$('broadcast-profile').value;
    text('profile-count', state.profiles.length); $('profiles-empty').hidden = state.profiles.length > 0;
    const list = $('profile-list'), signature = JSON.stringify([state.profiles.map(p => [p.id, p.name, p.updatedAt, p.profile?.provider, p.profile?.values?.model]), editingId]);
    if (list.dataset.signature !== signature) {
      list.dataset.signature = signature; list.replaceChildren();
      for (const p of state.profiles) {
        const item = button('', () => loadProfile(p), `profile-item${editingId === p.id ? ' is-active' : ''}`);
        item.append(node('strong', '', p.name), node('span', '', `${p.profile?.provider || '未知 provider'} · ${p.profile?.values?.model || '未指定模型'}`)); list.append(item);
      }
    }
    // Never write the profile form here: polling must not replace unsaved input.
  }
  function renderSessions() {
    options('session-device', state.devices.map(d => [d.deviceId, d.name || d.deviceId]), '全部设备');
    const filter = $('session-device').value;
    const sessions = state.sessions.filter(s => !filter || s.deviceId === filter).slice().sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));
    const list = $('session-list'), signature = JSON.stringify([sessions, state.devices.map(d => [d.deviceId, d.name])]);
    if (list.dataset.signature !== signature) {
      list.dataset.signature = signature; list.replaceChildren();
      for (const session of sessions) {
        const d = state.devices.find(device => device.deviceId === session.deviceId);
        const row = node('article', 'session-row'), info = node('div', 'session-info');
        info.append(node('strong', '', session.title || session.sessionId), node('span', '', `${d?.name || session.deviceId} · ${date(session.updatedAt)}`));
        const controls = node('div', 'toolbar-actions');
        controls.append(button('预览', () => preview(session), 'button button-secondary button-small'), button('在 neoctl-web 中查看 ↗', () => openViewer(session), 'button button-quiet button-small'));
        row.append(node('span', 'session-icon', '▤'), info, controls); list.append(row);
      }
    }
    $('sessions-empty').hidden = sessions.length > 0;
  }
  function render() {
    text('stat-total', state.devices.length); text('nav-device-count', state.devices.length); text('device-count', state.devices.length);
    text('stat-online', state.devices.filter(d => d.online).length); text('stat-profiles', state.profiles.length); text('stat-sessions', state.sessions.length);
    renderProfiles(); renderDevices(); renderSessions();
  }
  function validateProfile(profile, required = true) {
    if (!profile || typeof profile !== 'object' || Array.isArray(profile) || Object.keys(profile).some(k => !['provider', 'values'].includes(k))) throw new Error('配置只能包含 provider 和 values。');
    if (profile.provider !== 'openai') throw new Error('当前仅支持 openai 及其兼容服务。');
    if (!profile.values || typeof profile.values !== 'object' || Array.isArray(profile.values)) throw new Error('values 必须是 JSON 对象。');
    for (const [key, value] of Object.entries(profile.values)) {
      if (!MODEL_KEYS.has(key)) throw new Error(`不支持模型字段「${key}」。请使用表单字段名，不是环境变量名。`);
      if (typeof value !== 'string' || value.length > 8192 || /[\r\n\0]/.test(value)) throw new Error(`模型字段「${key}」必须是最多 8192 字符的单行字符串。`);
    }
    if (required && (typeof profile.values.apiKey !== 'string' || !profile.values.apiKey.trim() || typeof profile.values.model !== 'string' || !profile.values.model.trim())) throw new Error('API Key 和模型名称不能为空。');
    return profile;
  }
  function writeFields(profile) {
    ['profile-provider', 'profile-base', 'profile-model', 'profile-key'].forEach(id => { $(id).readOnly = false; });
    $('profile-provider').value = profile.provider;
    $('profile-base').value = profile.values.baseUrl ?? '';
    $('profile-model').value = profile.values.model ?? '';
    $('profile-key').value = profile.values.apiKey ?? '';
  }
  function syncFormToJson() {
    modelProfile.provider = $('profile-provider').value.trim();
    for (const [key, id] of [['baseUrl', 'profile-base'], ['model', 'profile-model'], ['apiKey', 'profile-key']]) {
      const value = $(id).value.trim(); if (value) modelProfile.values[key] = value; else delete modelProfile.values[key];
    }
    $('profile-json').value = JSON.stringify(modelProfile, null, 2); jsonDirty = false;
  }
  function markDirty() { dirty = true; text('editor-status', '有未保存更改'); showError('', 'profile-error'); }
  function discardAllowed() { return !dirty || window.confirm('当前配置尚未保存，确定放弃更改吗？'); }
  function loadProfile(p) {
    if (!discardAllowed()) return;
    editingId = p?.id || null; modelProfile = structuredClone(p?.profile || { provider: 'openai', values: {} });
    // Invalid legacy profiles remain inspectable in JSON and are rejected on save.
    $('profile-name').value = p?.name || '';
    writeFields({ provider: modelProfile.provider || '', values: modelProfile.values || {} });
    $('profile-json').value = JSON.stringify(modelProfile, null, 2); jsonDirty = false; dirty = false;
    $('profile-key').type = 'password'; text('toggle-profile-key', '显示'); $('toggle-profile-key').setAttribute('aria-pressed', 'false');
    text('editor-title', p ? '编辑模型配置' : '新建模型配置'); text('editor-status', p ? '已保存' : '未保存');
    $('delete-profile').hidden = !p; showError('', 'profile-error'); renderProfiles();
  }
  function applyJson() {
    let parsed; try { parsed = JSON.parse($('profile-json').value); } catch { throw new Error('JSON 格式无效，请检查引号、逗号和括号。'); }
    modelProfile = validateProfile(parsed, false); writeFields(modelProfile); jsonDirty = false; markDirty();
  }
  function openAuth() { $('admin-token').value = token; showError('', 'auth-error'); if (!$('auth-dialog').open) $('auth-dialog').showModal(); }
  function storeToken(value) { token = value; epoch++; stateRevision++; scheduleRefresh(); try { if (value) sessionStorage.setItem(TOKEN_KEY, value); else sessionStorage.removeItem(TOKEN_KEY); } catch { /* Fall back to current-page memory. Viewer can prompt independently. */ } }
  function openViewer(session) {
    if (!discardAllowed()) return;
    // Same-tab navigation retains sessionStorage without opener/token URL leakage.
    const url = new URL('/viewer/', location.origin);
    url.searchParams.set('deviceId', session.deviceId); url.searchParams.set('sessionId', session.sessionId);
    dirty = false; location.assign(url.href);
  }
  async function preview(session) {
    previewSession = session; const generation = ++previewGeneration;
    text('preview-title', session.title || session.sessionId); text('preview-meta', `设备 ${session.deviceId} · 只读`); text('preview-content', '正在加载会话…'); showError('', 'preview-error');
    if (!$('preview-dialog').open) $('preview-dialog').showModal();
    try {
      const result = await api(`/api/sessions/${encodeURIComponent(session.deviceId)}/${encodeURIComponent(session.sessionId)}`);
      if (generation !== previewGeneration || !$('preview-dialog').open) return;
      const transcript = typeof result.transcript === 'string' ? result.transcript : JSON.stringify(result.transcript ?? '', null, 2);
      text('preview-content', transcript.length > 200000 ? `${transcript.slice(0, 200000)}\n\n…预览已截断，请在 neoctl-web 查看完整记录。` : transcript || '该会话暂未上报 transcript。');
    } catch (error) { if (generation === previewGeneration) { text('preview-content', ''); showError(error.message, 'preview-error'); } }
  }
  $('auth-button').addEventListener('click', openAuth); $('sidebar-auth').addEventListener('click', openAuth);
  $('auth-form').addEventListener('submit', event => { event.preventDefault(); action($('connect-button'), async () => {
    storeToken($('admin-token').value.trim());
    // Serialize identity validation with polling to avoid overlapping state requests.
    if (!await refresh(true)) throw new Error('连接验证失败，请检查令牌及服务连接。');
    showError(''); $('auth-dialog').close(); $('admin-token').value = ''; success('已连接管理工作空间。');
  }, 'auth-error'); });
  $('logout-button').addEventListener('click', () => {
    if (!discardAllowed()) return;
    storeToken(''); selected.clear(); state = { devices: [], profiles: [], sessions: [], broadcastProfileId: null }; dirty = false; loadProfile(null); render();
    $('admin-token').value = ''; $('pair-key').value = ''; $('pair-device-id').value = ''; text('preview-content', ''); previewSession = null; previewGeneration++;
    connection(false, '尚未连接'); text('last-refresh', '等待首次同步'); showError(''); success('已清除本标签页令牌与配置数据。');
  });
  $('refresh-button').addEventListener('click', () => { if (!token) openAuth(); else action($('refresh-button'), () => refresh(true)); });
  $('dismiss-error').addEventListener('click', () => showError(''));
  document.querySelectorAll('[data-close]').forEach(el => el.addEventListener('click', () => $(el.dataset.close).close()));
  document.querySelectorAll('.nav-link').forEach(el => el.addEventListener('click', () => { document.querySelectorAll('.nav-link').forEach(link => link.classList.toggle('active', link === el)); }));
  $('device-search').addEventListener('input', renderDevices);
  $('select-all').addEventListener('change', () => { for (const d of visibleDevices()) { if ($('select-all').checked) selected.add(d.deviceId); else selected.delete(d.deviceId); } renderDevices(); });
  $('clear-selection').addEventListener('click', () => { selected.clear(); renderDevices(); });
  $('dispatch-profile').addEventListener('change', updateSelection);
  $('dispatch-button').addEventListener('click', () => action($('dispatch-button'), async () => {
    const deviceIds = [...selected], profileId = $('dispatch-profile').value;
    if (!deviceIds.length || !profileId) throw new Error('请选择设备和配置。');
    if (!window.confirm(`将此配置分发到选中的 ${deviceIds.length} 台设备？离线设备将在下次同步时接收。`)) return;
    await api('/api/dispatch', 'POST', { profileId, deviceIds }); success('配置已加入分发队列，等待设备确认。'); await refresh(true);
  }));
  $('pair-button').addEventListener('click', () => { if (!token) { openAuth(); return; } $('pair-form').hidden = false; $('pair-result').hidden = true; $('pair-name').value = ''; showError('', 'pair-error'); $('pair-dialog').showModal(); });
  $('pair-form').addEventListener('submit', event => { event.preventDefault(); action($('create-pair'), async () => {
    const name = $('pair-name').value.trim(); const result = await api('/api/devices', 'POST', name ? { name } : {});
    $('pair-device-id').value = result.deviceId; $('pair-key').value = result.key;
    $('pair-form').hidden = true; $('pair-result').hidden = false; text('pair-copy-status', '请立即复制，关闭后不再显示密钥。'); await refresh(true);
  }, 'pair-error'); });
  $('pair-dialog').addEventListener('close', () => { $('pair-key').value = ''; $('pair-device-id').value = ''; $('pair-result').hidden = true; });
  $('copy-pair').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(JSON.stringify({ deviceId: $('pair-device-id').value, key: $('pair-key').value }, null, 2)); text('pair-copy-status', '配对信息已复制。请安全保存。'); }
    catch { $('pair-key').select(); text('pair-copy-status', '浏览器不允许自动复制，请手动复制设备 ID 与配对密钥。'); }
  });
  $('new-profile').addEventListener('click', () => loadProfile(null));
  $('profile-name').addEventListener('input', markDirty);
  ['profile-provider', 'profile-base', 'profile-model', 'profile-key'].forEach(id => $(id).addEventListener('input', () => {
    markDirty();
    if (jsonDirty) { showError('JSON 有待应用的更改。请先应用 JSON，再修改常用字段。', 'profile-error'); return; }
    syncFormToJson();
  }));
  $('profile-json').addEventListener('input', () => {
    jsonDirty = true; markDirty();
    // Prevent conflicting edits while raw JSON is the source of truth.
    ['profile-provider', 'profile-base', 'profile-model', 'profile-key'].forEach(id => { $(id).readOnly = true; });
  });
  $('apply-json').addEventListener('click', () => { try { applyJson(); success('JSON 已应用到表单，尚未保存。'); } catch (error) { showError(error.message, 'profile-error'); } });
  $('toggle-profile-key').addEventListener('click', () => { const visible = $('profile-key').type === 'password'; $('profile-key').type = visible ? 'text' : 'password'; text('toggle-profile-key', visible ? '隐藏' : '显示'); $('toggle-profile-key').setAttribute('aria-pressed', String(visible)); });
  $('profile-form').addEventListener('submit', event => { event.preventDefault(); action($('save-profile'), async () => {
    if (jsonDirty) applyJson(); else syncFormToJson();
    const profile = validateProfile(modelProfile), name = $('profile-name').value.trim();
    if (!name) throw new Error('请输入配置名称。');
    if (editingId && state.broadcastProfileId === editingId && !window.confirm('此配置正在全局广播。保存将立即更新全部设备的目标配置，确定继续？')) return;
    const saved = await api('/api/profiles', 'POST', { ...(editingId ? { id: editingId } : {}), name, profile });
    editingId = saved.id; dirty = false; text('editor-status', '已保存'); text('editor-title', '编辑模型配置'); $('delete-profile').hidden = false;
    success('模型配置已保存。'); await refresh(true);
  }, 'profile-error'); });
  $('delete-profile').addEventListener('click', () => action($('delete-profile'), async () => {
    if (!editingId || !window.confirm('删除此配置存档？若正在广播会停止广播；已分发的独立任务不受影响。')) return;
    await api(`/api/profiles/${encodeURIComponent(editingId)}`, 'DELETE'); dirty = false; loadProfile(null); success('配置存档已删除。'); await refresh(true);
  }, 'profile-error'));
  $('broadcast-profile').addEventListener('change', () => { $('broadcast-button').disabled = !$('broadcast-profile').value; });
  $('broadcast-button').addEventListener('click', () => action($('broadcast-button'), async () => {
    const profileId = $('broadcast-profile').value; if (!profileId) throw new Error('请选择广播配置。');
    if (!window.confirm('向全部设备广播此配置？离线设备及之后新注册的设备也会接收。')) return;
    await api('/api/broadcast', 'POST', { profileId }); stateRevision++; state.broadcastStatus = null; state.broadcastProfileId = profileId; renderProfiles(); success('全局广播已开启。'); await refresh(true);
  }));
  $('stop-broadcast').addEventListener('click', () => action($('stop-broadcast'), async () => {
    if (!window.confirm('停止全局广播？已应用的模型配置不会自动撤回。')) return;
    await api('/api/broadcast', 'POST', { profileId: null }); stateRevision++; state.broadcastStatus = null; state.broadcastProfileId = null; renderProfiles(); success('广播已停止；已应用的配置保持不变。'); await refresh(true);
  }));
  $('session-device').addEventListener('change', renderSessions);
  $('preview-viewer').addEventListener('click', () => { if (previewSession) openViewer(previewSession); });
  $('preview-dialog').addEventListener('close', () => { previewGeneration++; text('preview-content', ''); previewSession = null; });
  window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); else scheduleRefresh(); });
  loadProfile(null); render();
  if (token) refresh(true); else openAuth();

})();
