// Serialized into the existing editor; no dependencies or alternate visual surface.
export function installVersioning(initial, apiUrl, editor) {
  const $ = id => document.getElementById(id);
  let version = initial.version || 1, dirty = false, stale = false, saving = false, timer, checking = false;
  const identity = { artifact_id: initial.id, sessionId: initial.sessionId || '' };
  function siblingFrames() { try { return window === parent ? [] : [...parent.document.querySelectorAll('iframe')]; } catch { return []; } }
  const slot = window === parent ? 'standalone' : String(siblingFrames().indexOf(window.frameElement));
  const key = 'neoctl.xhs.draft.v1:' + JSON.stringify([identity.sessionId, identity.artifact_id, slot]);
  let basePayload = JSON.parse(JSON.stringify(initial.payload));
  let backup;
  try { backup = JSON.parse(sessionStorage.getItem(key) || 'null'); } catch {}
  const actions = document.createElement('span');
  actions.innerHTML = ' <span id="versionState" role="status"></span> <button type="button" id="latestVersion" hidden>加载最新版</button> <button type="button" id="downloadDraft" hidden>下载未保存草稿</button> <button type="button" id="restoreDraft" hidden>恢复草稿供人工处理</button>';
  $('status').after(actions);
  function status(text, error = false) { editor.status(text, error); }
  function controls() {
    $('versionState').textContent = 'v' + version + (stale ? ' · 已过期／只读' : '');
    $('latestVersion').hidden = !stale;
    $('downloadDraft').hidden = !backup;
    $('restoreDraft').hidden = !backup || stale;
    $('form').querySelectorAll('input,textarea,button').forEach(el => { el.disabled = stale; });
    $('save').disabled = stale || saving;
    $('add').disabled = $('upload').disabled = stale;
  }
  function persist() {
    backup = { ...identity, version, basePayload, payload: editor.payload() };
    try { sessionStorage.setItem(key, JSON.stringify(backup)); }
    catch { status('草稿备份失败，请勿关闭页面并下载草稿', true); }
    controls();
  }
  function expired() {
    stale = true; clearTimeout(timer);
    status('版本冲突：本实例已过期，只读；未保存草稿已保留', true); controls();
  }
  function valid(artifact) { return artifact?.id === identity.artifact_id && (artifact.sessionId || '') === identity.sessionId && Number.isSafeInteger(artifact.version); }
  async function fetchLatest() {
    const res = await fetch(apiUrl, { cache: 'no-store' });
    const body = await res.json();
    if (!res.ok || !valid(body.artifact)) throw new Error(body.error || '版本读取失败');
    return body.artifact;
  }
  async function check() {
    if (checking || saving) return;
    checking = true;
    const checkedVersion = version;
    try { const current = await fetchLatest(); if (!saving && version === checkedVersion && current.version > version) expired(); }
    catch (e) { status('版本检查失败，可重试：' + e.message, true); }
    finally { checking = false; }
  }
  function changed() {
    dirty = true; persist(); clearTimeout(timer);
    if (!stale) { timer = setTimeout(save, 600); status('待保存'); }
  }
  async function save() {
    clearTimeout(timer);
    if (stale || saving || !dirty) return;
    const sent = JSON.stringify(editor.payload());
    saving = true; controls(); status('保存中…');
    try {
      const res = await fetch(apiUrl, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: editor.payload().title, payload: JSON.parse(sent), expected_version: version }) });
      const body = await res.json();
      if (res.status === 409) { expired(); return; }
      if (!res.ok || !valid(body.artifact)) throw new Error(body.error || '保存失败');
      version = body.artifact.version;
      basePayload = body.artifact.payload;
      dirty = JSON.stringify(editor.payload()) !== sent;
      if (!dirty) {
        editor.replace(body.artifact.payload);
        backup = null; sessionStorage.removeItem(key);
      } else persist();
      status(dirty ? '待保存（保留保存期间的输入）' : '已保存');
      notify();
    } catch (e) { status(e.message || '保存失败，可重试', true); }
    finally { saving = false; controls(); if (dirty && !stale && JSON.stringify(editor.payload()) !== sent) timer = setTimeout(save, 600); }
  }
  function notify() {
    const message = { type: 'neo-xhs-version-invalidated', ...identity };
    if (window !== parent) for (const frame of siblingFrames()) {
      if (frame.contentWindow !== window) frame.contentWindow?.postMessage(message, location.origin);
    }
  }
  addEventListener('message', e => {
    if (e.origin !== location.origin || e.data?.type !== 'neo-xhs-version-invalidated' || e.data.artifact_id !== identity.artifact_id || e.data.sessionId !== identity.sessionId) return;
    if (window === parent || !siblingFrames().some(frame => frame.contentWindow === e.source && new URL(frame.src, location.href).origin === location.origin && new URL(frame.src, location.href).pathname === location.pathname && new URL(frame.src, location.href).searchParams.get('sessionId') === (identity.sessionId || null))) return;
    void check();
  });
  $('latestVersion').onclick = async () => {
    try {
      const latest = await fetchLatest();
      version = latest.version; basePayload = latest.payload; stale = false; dirty = false;
      editor.replace(latest.payload); status('已加载最新版；原草稿仍可下载或恢复'); controls();
    } catch (e) { status(e.message, true); }
  };
  $('downloadDraft').onclick = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = initial.id + '-draft.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  $('restoreDraft').onclick = () => {
    if (!backup || stale) return;
    const merged = { ...editor.payload() };
    for (const key of Object.keys(backup.payload)) if (!backup.basePayload || JSON.stringify(backup.payload[key]) !== JSON.stringify(backup.basePayload[key])) merged[key] = backup.payload[key];
    editor.replace(merged); dirty = true; persist();
    status('草稿已恢复，请人工核对后点击保存（不会自动覆盖最新版）');
  };
  $('save').onclick = save;
  addEventListener('focus', check);
  addEventListener('online', check);
  addEventListener('beforeunload', e => { if (dirty) { persist(); e.preventDefault(); e.returnValue = ''; } });
  setInterval(check, 1500);
  if (backup?.artifact_id === identity.artifact_id && backup.sessionId === identity.sessionId) {
    editor.replace(backup.payload); dirty = true;
    basePayload = backup.basePayload || basePayload;
    if (backup.version !== version) { version = backup.version; expired(); }
    else status('已恢复未保存草稿，请核对后保存');
  } else backup = null;
  controls(); void check();
  return { changed, save, readonly: () => stale };
}
