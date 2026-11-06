// ===== render: shell, settings pages, dialogs (data lives only in S) =====
EXTRA.plug = { d: 'M7 2.5v4M13 2.5v4M5 6.5h10v3a5 5 0 0 1-10 0ZM10 14.5v3' }
const P = id => APPEARANCE_PRESETS.find(p => p.id === id)
S.prompt = 'If the user adds requirements mid-task, finish every unfinished item by default.\nDo not delegate to subagents unless the user explicitly asks.'
S.models = [
  { id: 'claude-opus-5-5', p: 'anthropic', ctx: 256000, out: 128000, img: true },
  { id: 'claude-haiku-5-5', p: 'anthropic', ctx: 256000, out: 64000, img: true },
  { id: 'gpt-6.1-sol', p: 'openai', ctx: 256000, out: 128000, img: true },
  { id: 'gpt-6-astra', p: 'openai', ctx: 256000, out: 128000, img: true },
  { id: 'deepseek-flash', p: 'anthropic', ctx: 256000, out: 32000, img: false },
]
S.cpa = { url: 'http://117.89.250.136:8317' }

const sel = (key, extra = '') => { const v = getVal(key); return `<div class="sel" data-key="${key}" ${extra}><button type="button" class="sel-trigger" data-act="sel" aria-haspopup="listbox" aria-expanded="false"><span class="sel-value"><span${v ? '' : ' class="ph"'}>${esc(v || '未配置')}</span></span>${icon('chevron', 'chev')}</button></div>` }
const tgl = (on, attrs) => `<span class="tgl"><input type="checkbox" ${on ? 'checked' : ''} ${attrs}><span class="track"></span></span>`
const chk = (label, on, attrs = '') => `<label class="chk"><input type="checkbox" ${on ? 'checked' : ''} ${attrs}><span class="box">${CHECK}</span>${label ? `<span>${label}</span>` : ''}</label>`
const field = (label, inner, side = '') => `<div class="field"><span class="label-line"><span>${label}</span>${side}</span>${inner}</div>`
const head = (title, actions = '') => `<header class="page-head">${ib('back', '返回', 'back')}<h2 class="vt-title">${esc(title)}</h2><span class="spacer"></span>${actions}</header>`
const dlgHead = (title, extra = '') => `<header class="dlg-head"><strong>${esc(title)}</strong>${extra}<span class="spacer"></span>${ib('close', '关闭', 'close')}</header>`

// ---- prototype bar ----
function syncProto() {
  const { p, s } = scheme()
  for (const b of $$('#pStyle button')) b.setAttribute('aria-pressed', String(b.dataset.v === S.style))
  placeSeg($('#pStyle'))
  $('#pPreset').value = S.preset
  $('#pMode').innerHTML = icon(S.mode === 'dark' ? 'moon' : 'sun')
  const r = s.radius ?? 6, b = s.borderWidth ?? 1, t = s.windowTransparency ?? 0
  $('#pRadius').value = r; $('#oRadius').textContent = r
  $('#pBorder').value = b; $('#oBorder').textContent = b
  $('#fTrans').hidden = !p.material
  $('#pTrans').value = t; $('#oTrans').textContent = t
  $('#pMotion').checked = S.motion === 'reduce'
}

// ---- sidebar / window bar / info ----
function renderSidebar() {
  $('#sidebar').innerHTML = `<div class="side-head">${ib('search', '搜索', 'q-search')}${ib('list', '会话管理', 'nav-sessions')}${ib('plus', '新会话', 'new-session')}</div><div id="qs"></div><nav class="quick" id="quick" aria-label="会话"></nav><div class="side-foot">${ib('grid', '菜单', 'app-menu', 'app-trigger', 'aria-haspopup="menu" aria-expanded="false"')}</div>`
  renderQuick()
}
function qItem(s, fresh = false) {
  const cur = s.id === S.current
  return `<button type="button" class="q-item${fresh ? ' q-new' : ''}" data-act="open" data-id="${s.id}" aria-current="${cur}">${cur ? '<span class="q-frame"><span class="f1"></span><span class="f2"></span></span>' : ''}<span class="q-title">${esc(s.t)}</span>${s.id === S.running ? '<span class="q-run" aria-label="运行中"><i></i><i></i></span>' : ''}</button>`
}
function renderQuick(freshId) {
  let g = '', html = ''
  for (const s of S.sessions) { if (s.g !== g) { g = s.g; html += `<div class="q-group" data-g="${g}">${g}</div>` } html += qItem(s, s.id === freshId) }
  $('#quick').innerHTML = html
}
function renderWinbar() {
  $('#winbar').innerHTML = ib('panel', '信息栏', 'toggle-info') + ib('gear', '设置', 'nav-settings') + ib('pin', '置顶', 'pin') + ib('minimize', '最小化', 'noop') + ib('maximize', '最大化', 'noop') + ib('close', '关闭', 'noop')
}
const mem = Array.from({ length: 36 }, (_, i) => 210 + Math.sin(i / 3) * 6 + (i % 7 === 3 ? 18 : 0))
function sparkPaths() {
  const lo = 180, hi = 260, pts = mem.map((v, i) => [(i / (mem.length - 1)) * 100, 44 - ((v - lo) / (hi - lo)) * 40])
  const line = 'M' + pts.map(([x, y]) => `${x.toFixed(2)} ${y.toFixed(2)}`).join(' L')
  return [line, `${line} L100 44 L0 44 Z`]
}
function renderInfo() {
  const [line, area] = sparkPaths()
  $('#info').innerHTML = `
  <section class="icard"><div class="ihead">${icon('tasks')}<span>后台任务</span></div><button type="button" class="irow" data-act="nav-sessions">${icon('clock')}<span>最近结束</span><b>411</b>${icon('chevron')}</button></section>
  <section class="icard"><div class="ihead">${icon('quota')}<span>剩余额度</span><span class="big" id="quotaV">0%</span></div><div class="bar"><i id="quotaBar" style="--v:0"></i></div></section>
  <section class="icard"><div class="ihead">${icon('memory')}<span>内存</span><span class="big" id="memV">${Math.round(mem.at(-1))} MB</span></div>
    <svg class="spark" viewBox="0 0 100 44" preserveAspectRatio="none" aria-hidden="true"><defs><linearGradient id="sg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="currentColor" stop-opacity=".22"/><stop offset="1" stop-color="currentColor" stop-opacity="0"/></linearGradient></defs><path class="spark-area" fill="url(#sg)" style="d:path('${area}')"/><path class="spark-line" style="d:path('${line}')"/></svg></section>`
  requestAnimationFrame(() => requestAnimationFrame(() => { $('#quotaBar').style.setProperty('--v', S.quota / 100); tween($('#quotaV'), 0, S.quota, v => Math.round(v) + '%', 900) }))
}

// ---- views ----
function renderView() {
  const v = $('#view'), main = $('#main')
  main.dataset.view = S.view
  v.className = 'view' + (S.view === 'chat' ? ' v-chat' : '')
  v.innerHTML = S.view === 'chat' ? chatView() : S.view === 'sessions' ? sessionsView() : S.sub ? subView(S.sub) : settingsIndex()
  $('#scroller').scrollTop = 0
  for (const seg of $$('#view .seg')) placeSeg(seg, false)
}
function chatView() {
  return `<div class="chat">
  <div class="ctx-bar">${icon('context')}<span>运行上下文</span><span class="spacer"></span><span class="ctx-n">${icon('document')}3</span><span class="ctx-n">${icon('tools')}${S.tools.filter(t => t.on).length}</span><span class="ctx-n">${icon('plugins')}${S.plugins.filter(p => p.on).length}</span></div>
  <div class="u-msg">ciallo</div>
  <div class="act-row">${icon('brain')}<span>思考</span></div>
  <div class="answer"><p>Ciallo～(∠・ω&lt; )⌒☆</p><p>I'm neo. What can I help you with? I can write or edit code, run commands, look things up online, or make images.</p></div>
  <div class="elapsed">${icon('clock')}<span>3s</span></div>
  <div class="composer"><textarea rows="2" placeholder="有什么想做的?" aria-label="消息"></textarea>
    <div class="cmp-stat"><b class="mono">${esc(S.model.model || '未配置')}</b><span>上下文 5.1%</span><span>输入 13k</span><span>输出 118</span></div>
    <div class="cmp-acts">${ib('folder', '工作目录', 'noop')}${ib('fast', '快速模式', 'fast', S.fast ? 'on' : '', `aria-pressed="${S.fast}"`)}${ib('compact', '压缩上下文', 'compact')}<span class="spacer"></span>${ib('attach', '附件', 'noop')}<button type="button" class="send" data-act="send" aria-label="发送">${icon('send')}</button></div>
  </div></div>`
}
const TILE_IC = { appearance: 'palette', prompt: 'prompts', model: 'model', cpa: 'drive', tools: 'tools', plugins: 'plugins', feedback: 'feedback' }
function tileVal(id) {
  if (id === 'model') { const k = EFFORTS.indexOf(S.model.effort); return `<span class="mono">${esc(S.model.model || '未配置')}</span><span class="meter" aria-label="${S.model.effort}">${EFFORTS.slice(1).map((_, i) => `<i style="--h:${i + 1}" class="${i < k ? 'on' : ''}"></i>`).join('')}</span>` }
  if (id === 'appearance') return `<span>${P(S.preset).name}</span>`
  if (id === 'tools') return `<span class="mono">${S.tools.filter(t => t.on).length}/${S.tools.length}</span>`
  if (id === 'plugins') return `<span class="mono">${S.plugins.filter(t => t.on).length}/${S.plugins.length}</span>`
  if (id === 'feedback') return S.feedback.length ? `<span class="mono">${S.feedback.length}</span>` : ''
  if (id === 'cpa') return `<span class="mono">${esc(S.cpa.url.replace(/^https?:\/\//, ''))}</span>`
  return ''
}
function settingsIndex() {
  if (S.style === 'legacy') return `<header class="page-head"><h2>设置</h2></header><div class="legacy-list">${PAGES.map(([id, t]) => `<button type="button" class="legacy-entry" data-act="sub" data-v="${id}"><strong>${t}</strong><span>${icon('chevron')}</span></button>`).join('')}</div>`
  const mini = `<div class="mini" aria-hidden="true"><div class="mini-win"><div class="mini-side"><i></i><i></i><i></i><i></i></div><div class="mini-chat"><div class="mini-user"></div><div class="mini-ans"><i></i><i></i><i></i></div><div class="mini-comp"><b></b></div></div></div></div>`
  return `<header class="page-head"><h2>设置</h2></header><div class="bento stagger">${PAGES.map(([id, t], i) => `<button type="button" class="tile t-${id}" data-act="sub" data-v="${id}" style="--i:${i}"><span class="tile-ic">${icon(TILE_IC[id])}</span>${id === 'appearance' ? mini : ''}<span class="tile-title">${t}</span><span class="tile-go">${icon('chevron')}</span><span class="tile-val">${tileVal(id)}</span></button>`).join('')}</div>`
}
function subView(id) {
  const foot = (act, label = '保存', done = '已保存') => `<div class="page-foot"><span class="spacer"></span>${asyncBtn(act, 'save', label, done)}</div>`
  if (id === 'appearance') return head('外观') + `
    <div class="look-bar"><div class="seg" role="group" aria-label="日夜"><span class="seg-ind"></span><button type="button" data-act="mode" data-v="light" aria-pressed="${S.mode === 'light'}">日间</button><button type="button" data-act="mode" data-v="dark" aria-pressed="${S.mode === 'dark'}">夜间</button></div><span class="spacer"></span>${followCtl()}<button type="button" class="btn" data-act="designer">${icon('edit')}设计外观</button></div>
    <div class="presets stagger">${APPEARANCE_PRESETS.map(pcard).join('')}</div>`
  if (id === 'prompt') return promptView()
  if (id === 'promptOld') return head('提示词') + `<div class="card"><div class="card-body one"><textarea class="inp prompt-area" id="promptText" spellcheck="false" aria-label="提示词">${esc(S.prompt)}</textarea></div></div>` + foot('save-prompt')
  if (id === 'model') return modelView()
  if (id === 'cpa') return cpaView()
  if (id === 'cpaOld') return head('CPA') + `<div class="card"><div class="card-body">
      <label class="field"><span>管理地址</span><input class="inp mono" id="cpaUrl" value="${esc(S.cpa.url)}"></label>
      <label class="field"><span>管理密码</span><input class="inp" type="password" value="cpa-management-key" placeholder="请输入管理密码"></label></div></div>` + foot('save-cpa')
  if (id === 'tools') return toolsView()
  if (id === 'plugins') return pluginsView()
  if (id === 'feedback') return head('框架改进建议', `<span class="count" id="fbCount">${S.feedback.length}</span>`) + `<div class="card" id="fbCard">${feedbackList()}</div>`
  return ''
}
const empty = () => `<div class="empty">${icon('check')}<span>暂无</span></div>`
function feedbackList() {
  if (!S.feedback.length) return empty()
  return `<div class="stagger">${S.feedback.map((f, i) => `<div class="cl" data-id="${f.id}" style="--i:${i}"><div><div class="fb-item">${icon('feedback')}<div><strong>${esc(f.t)}</strong><p>${esc(f.b)}</p></div>${ib('copy', '复制', 'fb-copy')}${ib('trash', '删除', 'fb-del')}</div></div></div>`).join('')}</div>`
}

// ---- appearance previews from the real compiler ----
function sampleVars(p) {
  const s = normalizeScheme({ ...p[S.mode], ...S.ov[p.id]?.[S.mode] }), t = appearanceTokens(s, S.mode), D = DEFAULT_COLORS[S.mode]
  return `--sample-bg:${t['--appearance-bg'] || D.background};--sample-panel:${t['--appearance-panel'] || D.panel};--sample-surface:${t['--appearance-surface'] || D.surface};--sample-text:${t['--appearance-text'] || D.text};--sample-accent:${t['--appearance-accent'] || D.accent};--sample-radius:${(s.radius ?? 6) / 2}px`
}
function pcard(p, i) {
  const on = p.id === S.preset
  return `<article class="pcard${p.material ? ' is-material' : ''}" data-id="${p.id}" data-applied="${on}" style="--i:${i}">
  <button type="button" class="pcard-prev" data-act="preset" data-v="${p.id}" aria-label="应用 ${p.name}"><span class="scene" style="${sampleVars(p)}"><span class="orbit"></span><span class="win"><span class="side"><i></i><i></i><i></i><i></i></span><span class="chatp"><span class="user"></span><span class="ans"><i></i><i></i><i></i></span><span class="comp"><i></i><b>↑</b></span></span></span></span></button>
  <div class="pcap"><span class="pname">${p.name}</span>${p.material ? '<span class="pkind">材质</span>' : ''}<span class="pacts">${ib('edit', '编辑', 'edit-preset', '', `data-v="${p.id}"`)}${ib('undo', '恢复', 'reset-preset', '', `data-v="${p.id}"`)}<button type="button" class="icon-btn papply" data-act="preset" data-v="${p.id}" aria-pressed="${on}" aria-label="应用" data-tip="${on ? '使用中' : '应用'}">${icon(on ? 'check' : 'apply')}</button></span></div></article>`
}
function refreshLook() {
  for (const c of $$('.pcard')) {
    const p = P(c.dataset.id), on = p.id === S.preset
    c.dataset.applied = on
    c.querySelector('.scene').setAttribute('style', sampleVars(p))
    const b = c.querySelector('.papply'); b.setAttribute('aria-pressed', on); b.dataset.tip = on ? '使用中' : '应用'; b.innerHTML = icon(on ? 'check' : 'apply')
  }
  for (const b of $$('#view .seg button[data-act="mode"]')) b.setAttribute('aria-pressed', String(b.dataset.v === S.mode))
  for (const seg of $$('#view .seg')) placeSeg(seg)
  const tv = $('.t-appearance .tile-val'); if (tv) tv.innerHTML = tileVal('appearance')
}

// ---- model page ----
const meta = id => S.models.find(m => m.id === id)
function modelViewOld() {
  const m = meta(S.model.model)
  const img = m?.img ? `<span class="cap" data-tip="图片输入">${icon('image', 'cap-ok')}</span>` : ''
  return head('模型', `<button type="button" class="btn" data-act="library">${icon('library')}模型库</button>${ib('refresh', '刷新', 'refresh')}`) + `
  <div class="stagger">
  ${apiCard(0)}
  <section class="card" style="--i:1"><div class="card-head">${icon('model')}<strong>主模型</strong><span class="spacer"></span>${ib('sliders', '参数', 'params', '', 'data-v="main"')}${ib('diagnose', '检测', 'test-one', '', 'data-v="main"')}</div>
    <div class="card-body">${field('模型', sel('model'), `<span id="capSlot">${img}</span><span class="spacer"></span>${routeHint('main')}`)}${field('推理强度', sel('effort'))}
    <label class="field"><span>最大输出 Token</span><input class="inp mono" id="maxTok" inputmode="numeric" value="${esc(S.model.maxTokens)}" placeholder="${m ? m.out : ''}"></label></div>${issueLine('main')}</section>
  <section class="card" style="--i:2"><div class="card-head">${icon('imageGenerate')}<strong>图片生成</strong><span class="spacer"></span>${ib('sliders', '参数', 'params', '', `data-v="image"${S.model.imgModel ? '' : ' disabled'}`)}${ib('diagnose', '检测', 'test-one', '', 'data-v="image"')}</div>
    <div class="card-body one">${field('模型', sel('imgModel'), `<span class="spacer"></span>${routeHint('image')}`)}</div>${issueLine('image')}</section>
  <section class="card" style="--i:3"><div class="card-head">${icon('search')}<strong>搜索</strong><span class="spacer"></span>${ib('sliders', '参数', 'params', '', 'data-v="search"')}${ib('diagnose', '检测', 'test-one', '', 'data-v="search"')}</div>
    <div class="card-body one">${field('模型', sel('searchModel'), `<span class="spacer"></span>${routeHint('search')}`)}</div>${issueLine('search')}
    <div class="card-extra">${chk('Exa', S.model.exa, 'id="exaChk"')}<span class="tag exa-tag">${S.model.searchModel ? '备用' : '直接搜索'}</span></div></section>
  </div>
  <div class="page-foot" id="modelFoot" data-dirty="${dirty()}">${pendTag('项未应用', modelDiff())}<span class="spacer"></span><button type="button" class="btn dirty-only" data-act="revert">${icon('undo')}撤销</button><button type="button" class="btn" data-act="test">${icon('diagnose')}检测</button>${asyncBtn('apply', 'apply', '应用', '已生效')}</div>`
}
function syncModel() {
  setFoot($('#modelFoot'), modelDiff())
  const m = meta(S.model.model), slot = $('#capSlot'), mt = $('#maxTok')
  if (slot) slot.innerHTML = m?.img ? `<span class="cap" data-tip="图片输入">${icon('image', 'cap-ok')}</span>` : ''
  if (mt) mt.placeholder = m ? m.out : ''
  syncRoutes()
}

// ---- dialogs ----
function apiFormOld(a) {
  const sel = new Set(a?.models || [])
  const b = openDialog(dlgHead(a ? '编辑 API' : '添加 API') + `<div class="dlg-body form-grid">
    <label class="field"><span>名称</span><input class="inp" data-f="name" value="${esc(a?.name || '')}" placeholder="自定义名称"></label>
    <div class="field"><span>接口类型</span><div class="chips">${chk('OpenAI 兼容', a ? a.proto.includes('OpenAI') : true, 'data-f="OpenAI"')}${chk('Anthropic 兼容', a?.proto.includes('Anthropic'), 'data-f="Anthropic"')}</div></div>
    <label class="field"><span>Base URL</span><input class="inp mono" data-f="url" value="${esc(a?.url || '')}" placeholder="https://"></label>
    <label class="field"><span>API Key</span><input class="inp" type="password" data-f="key" value="" placeholder="${a ? '留空保留原密钥' : '输入 API Key'}"></label>
    <div class="field"><span>模型</span><div class="old-models">${mdlCandidates(a).map(id => chk(id, sel.has(id), `data-m="${esc(id)}"`)).join('')}</div></div></div>
    <footer class="dlg-foot">${a ? ib('trash', '删除 API', 'del-api') : ''}<span class="spacer"></span><button type="button" class="btn" data-act="close">取消</button>${asyncBtn('save-api', 'save', '保存', '已保存')}</footer>`, { cls: 'mid' })
  b._api = a
}
function libRow(m, fresh = false) {
  return `<div class="api-row lib-row${fresh ? ' fresh' : ''}" data-id="${esc(m.id)}"><div class="api-main"><strong class="mono">${esc(m.id)}</strong><span>${m.p} · ${Math.round(m.ctx / 1000)}k / ${Math.round(m.out / 1000)}k</span></div>${m.img ? `<span class="cap" data-tip="图片输入">${icon('image', 'cap-ok')}</span>` : ''}${ib('edit', '编辑', 'edit-model')}${ib('trash', '删除', 'del-model')}</div>`
}
function libraryDialog() {
  openDialog(dlgHead('模型库') + `<div class="dlg-body"><div class="search-box lib-search">${icon('search')}<input class="inp" data-act="lib-filter" placeholder="搜索模型" aria-label="搜索模型"></div><div class="api-list stagger" id="libList">${S.models.map((m, i) => libRow(m).replace('class="api-row', `style="--i:${i}" class="api-row`)).join('')}</div></div>
  <footer class="dlg-foot"><button type="button" class="btn" data-act="add-model">${icon('plus')}添加模型</button><span class="spacer"></span><button type="button" class="btn primary" data-act="close">完成</button></footer>`, { cls: 'wide' })
}
function modelFormOld(m) {
  const b = openDialog(dlgHead(m ? '编辑模型' : '添加模型') + `<div class="dlg-body form-grid">
    <label class="field"><span>模型 ID</span><input class="inp mono" data-f="id" value="${esc(m?.id || '')}"></label>
    <div class="row2"><label class="field"><span>供应商</span><input class="inp" data-f="p" value="${esc(m?.p || 'openai')}"></label><div class="field"><span>图片输入</span><div class="chips">${chk('支持', m ? m.img : true, 'data-f="img"')}</div></div></div>
    <div class="row2"><label class="field"><span>上下文 Token</span><input class="inp mono" data-f="ctx" value="${m?.ctx || 256000}"></label><label class="field"><span>最大输出 Token</span><input class="inp mono" data-f="out" value="${m?.out || 128000}"></label></div></div>
    <footer class="dlg-foot"><span class="spacer"></span><button type="button" class="btn" data-act="close">取消</button>${asyncBtn('save-model', 'save', '保存', '已保存')}</footer>`, { cls: 'narrow' })
  b._model = m
}
const TESTS = [['main', 'model', '主模型'], ['vision', 'image', '图片输入'], ['image', 'imageGenerate', '图片生成'], ['search', 'search', '搜索'], ['exa', 'search', 'Exa 备用']]
function testDialog(only) {
  const pick = k => !only || k === only || (only === 'main' && k === 'vision') || (only === 'search' && k === 'exa')
  const b = openDialog(dlgHead('检测') + `<div class="dlg-body tests">${TESTS.map(([k, ic, l]) => `<div class="test-row" data-k="${k}">${chk('', pick(k) && (k !== 'exa' || S.model.exa), `aria-label="${l}"`)}${icon(ic)}<span>${l}</span><span class="st"></span><span class="ms"></span></div>`).join('')}</div>
  <footer class="dlg-foot"><span class="spacer"></span><button type="button" class="btn primary" data-act="run-test">${icon('diagnose')}<span>开始检测</span></button></footer>`)
  if (only) setTimeout(() => runTests(b), 260)
}
function presetDialogOld(id) {
  const p = P(id), s = { ...p[S.mode], ...S.ov[id]?.[S.mode] }, D = DEFAULT_COLORS[S.mode]
  const row = (k, l) => { const v = s[k] || D[k]; return `<label class="field"><span>${l}</span><span class="color-row"><input type="color" class="swatch" data-k="${k}" value="${v}" aria-label="${l}"><input class="inp mono" data-hex="${k}" value="${v}" maxlength="7"></span></label>` }
  const b = openDialog(dlgHead(p.name, `<span class="tag">${S.mode === 'dark' ? '夜间' : '日间'}</span>`) + `<div class="dlg-body form-grid">${row('accent', '重点色')}${row('background', '背景')}</div>
    <footer class="dlg-foot"><span class="spacer"></span><button type="button" class="btn" data-act="close">取消</button>${asyncBtn('save-preset', 'save', '保存', '已保存')}</footer>`, { cls: 'narrow' })
  b._preset = id; b._prev = structuredClone(S.ov)
  b._resolve = saved => { if (!saved) { S.ov = b._prev; applyAppearance(); refreshLook() } }
}
