// ===== switches: state is light, not a track and a knob =====
// Routing mirrors ModelSettings.vue: top-most enabled API that lists the model and shares a protocol. No failover.
EXTRA.power = { d: 'M10 2.8v6.4M6.1 5.4a6.2 6.2 0 1 0 7.8 0' }
const IMAGE_MODELS = ['gpt-image-2.5-sunburst', 'gpt-image-2.5-flare', 'gpt-image-2']
const isImg = id => IMAGE_MODELS.includes(id)
const natural = (a, b) => a.localeCompare(b, 'en', { numeric: true })
const conn = id => S.apis.find(a => a.id === id)
const wantedProtos = id => isImg(id) ? ['OpenAI'] : (m => m ? [protoOf(m)] : null)(meta(id))
function route(id, need) {
  if (!id) return null
  const w = wantedProtos(id)
  for (const o of S.model.order) {
    const a = o.on ? conn(o.id) : null
    if (!a || !a.models.includes(id)) continue
    const p = (w || a.proto).find(p => a.proto.includes(p) && (!need || p === need))
    if (p) return { a, p }
  }
  return null
}
const enabledApis = () => S.model.order.filter(o => o.on).map(o => conn(o.id)).filter(Boolean)
const bothProtos = () => ['OpenAI', 'Anthropic'].every(p => enabledApis().some(a => a.proto.includes(p)))
function pool(filter, need) {
  const out = new Set()
  for (const a of enabledApis()) for (const id of a.models) if (filter(id) && route(id, need)) out.add(id)
  return [...out].sort(natural)
}
const SLOTS = [
  { slot: 'main', key: 'model', icon: 'model', label: '主模型' },
  { slot: 'image', key: 'imgModel', icon: 'imageGenerate', label: '图片生成', need: 'OpenAI' },
  { slot: 'search', key: 'searchModel', icon: 'search', label: '搜索', need: 'OpenAI' },
]
const slotOf = slot => SLOTS.find(s => s.slot === slot)
const slotRoute = s => route(S.model[s.key], s.need)
function issueOf(slot) {
  if (slot === 'main') return !enabledApis().length ? '请至少启用一个 API。' : !S.model.model ? '请选择主模型。' : !route(S.model.model) ? '没有已启用的 API 提供此模型。' : ''
  const s = slotOf(slot)
  return S.model[s.key] && !slotRoute(s) ? `没有已启用的 OpenAI 兼容 API 提供此${slot === 'image' ? '图片' : '搜索'}模型。` : ''
}
const applyIssue = () => SLOTS.map(s => issueOf(s.slot)).find(Boolean) || ''
const wireOf = () => { const r = route(S.model.model); return r ? (r.p === 'Anthropic' ? 'Anthropic Messages' : 'OpenAI Responses') : '未选择' }
OPTS.model = () => pool(id => !isImg(id))
OPTS.imgModel = () => ['关闭', ...pool(isImg, 'OpenAI')]
OPTS.searchModel = () => ['关闭', ...pool(id => !isImg(id), 'OpenAI')]

// ---- API priority: the index number is the switch ----
const servingSlots = id => SLOTS.filter(s => slotRoute(s)?.a.id === id)
const servingHtml = id => servingSlots(id).map(s => `<span class="serve" data-slot="${s.slot}" data-tip="${s.label}：${esc(S.model[s.key])}">${icon(s.icon)}</span>`).join('')
function connRow(o, i) {
  const a = conn(o.id); if (!a) return ''
  const sw = legacy()
    ? `<span class="conn-index mono">${i + 1}</span><input type="checkbox" class="conn-chk" ${o.on ? 'checked' : ''} aria-label="启用 ${esc(a.name)}">`
    : `<button type="button" class="pip" role="switch" aria-checked="${o.on}" data-act="conn-on" aria-label="启用 ${esc(a.name)}" data-tip="${o.on ? '停用' : '启用'}"><span class="pip-fill"></span><span class="pip-n mono">${i + 1}</span></button>`
  return `<div class="api-row conn${o.on ? '' : ' off'}" data-id="${a.id}" style="--i:${i}"><span class="grip" data-drag aria-label="拖动排序">${icon('grip')}</span>${sw}<div class="api-main"><strong>${esc(a.name)}</strong><span class="mono">${esc(a.url)}</span></div><span class="protos">${a.proto.map(p => `<i>${p}</i>`).join('')}</span><span class="serving" data-s="${servingSlots(a.id).map(s => s.slot).join()}">${servingHtml(a.id)}</span><button type="button" class="icon-btn conn-models" data-act="edit-api" data-tip="可用模型" aria-label="${esc(a.name)} 可用模型 ${a.models.length} 个">${icon('library')}<span class="mono">${a.models.length}</span></button>${ib('edit', '编辑 API', 'edit-api')}</div>`
}
const orderSig = () => S.model.order.map(o => o.id + (o.on ? '+' : '-')).join()
const apiCard = (i = 0) => `<section class="card capcard apicard" style="--i:${i}"><div class="card-head">${icon('plug')}<strong>API</strong><span class="strategy" tabindex="0" data-tip="每项能力使用最靠上、提供所选模型的已启用 API；请求失败不自动切换">顶部优先</span><span class="spacer"></span>${ib('plus', '添加 API', 'add-api')}</div><div class="api-list conn-list" id="apiList" data-sig="${orderSig()}">${S.model.order.map(connRow).join('')}</div></section>`
const routeHint = slot => { const r = slotRoute(slotOf(slot)); return `<span class="route" data-slot="${slot}" data-tip="生效 API"${r ? '' : ' hidden'}>${icon('plug')}<span>${r ? esc(r.a.name) : ''}</span></span>` }
const issueLine = slot => { const t = issueOf(slot); return `<p class="issue" data-slot="${slot}" role="alert"${t ? '' : ' hidden'}>${esc(t)}</p>` }
function renderConnList() {
  const list = $('#apiList'); if (!list) return
  list.innerHTML = S.model.order.map(connRow).join(''); list.dataset.sig = orderSig()
}
function setPip(btn, on) {
  btn.setAttribute('aria-checked', on); btn.dataset.tip = on ? '停用' : '启用'
  if (instant()) return
  btn.querySelector('.pip-fill').animate(on
    ? [{ clipPath: 'inset(100% 0 0 0)' }, { clipPath: 'inset(0 0 0 0)' }]
    : [{ clipPath: 'inset(0 0 0 0)' }, { clipPath: 'inset(0 0 100% 0)' }],
  { duration: on ? 460 : 280, easing: on ? 'cubic-bezier(.34,1.5,.64,1)' : 'cubic-bezier(.5,0,.75,0)' })
  btn.animate([{ scale: on ? .78 : 1.12 }, { scale: 1 }], { duration: 420, easing: 'cubic-bezier(.34,1.56,.64,1)' })
  if (on) { btn.classList.remove('pulse'); void btn.offsetWidth; btn.classList.add('pulse') }
}
// serving icons fly to whichever row now serves the capability
function syncRoutes() {
  const list = $('#apiList')
  if (list) {
    const before = new Map($$('.serve', list).map(n => [n.dataset.slot, n.getBoundingClientRect()]))
    for (const row of list.children) {
      const sv = row.querySelector('.serving'), s = servingSlots(row.dataset.id).map(x => x.slot).join()
      if (sv.dataset.s !== s) { sv.dataset.s = s; sv.innerHTML = servingHtml(row.dataset.id) }
      else for (const n of $$('.serve', sv)) { const x = slotOf(n.dataset.slot); n.dataset.tip = `${x.label}：${S.model[x.key]}` }
    }
    if (!instant()) for (const n of $$('.serve', list)) {
      const b = before.get(n.dataset.slot), r = n.getBoundingClientRect()
      if (!b) n.animate([{ opacity: 0, scale: .3 }, { opacity: 1, scale: 1 }], { duration: 360, easing: 'cubic-bezier(.34,1.56,.64,1)' })
      else if (b.left !== r.left || b.top !== r.top) n.animate([{ translate: `${b.left - r.left}px ${b.top - r.top}px` }, { translate: '0 0' }], { duration: 560, easing: 'cubic-bezier(.16,1,.3,1)' })
    }
  }
  for (const el of $$('#view .route')) {
    const r = slotRoute(slotOf(el.dataset.slot)), name = r ? r.a.name : ''
    const was = el.hidden; el.hidden = !r
    const t = el.querySelector('span'); if (t.textContent !== name) { t.textContent = name; if (!was && r && !instant()) t.animate([{ opacity: 0, translate: '0 5px' }, { opacity: 1, translate: '0 0' }], { duration: 260, easing: 'cubic-bezier(.16,1,.3,1)' }) }
  }
  for (const el of $$('#view .issue')) { const t = issueOf(el.dataset.slot); el.textContent = t; el.hidden = !t }
  const ap = $('#modelFoot [data-act="apply"]'); if (ap) ap.disabled = !!applyIssue()
  const et = $('#view .exa-tag'); if (et) et.textContent = S.model.searchModel ? '备用' : '直接搜索'
  const ip = $('#view [data-act="params"][data-v="image"]'); if (ip) ip.disabled = !S.model.imgModel
  const it = $('#view [data-act="test-one"][data-v="image"]'); if (it) it.disabled = !slotRoute(slotOf('image'))
}

// ---- lit tiles: a tile is its own switch; press and sweep to paint many ----
const lit = (kind, v, on, inner, cls = '') => `<button type="button" class="lit ${cls}" role="switch" aria-checked="${on}" data-kind="${kind}" data-v="${esc(v)}"><span class="lit-flood"></span>${inner}</button>`
const litSnap = kind => JSON.stringify((kind === 'tool' ? S.tools : S.plugins).map(x => x.on))
S.litApplied = { tool: litSnap('tool'), plugin: litSnap('plugin') }
const litDiff = kind => { const a = JSON.parse(S.litApplied[kind]); return (kind === 'tool' ? S.tools : S.plugins).filter((x, i) => x.on !== a[i]).length }
const litFoot = (kind, act) => `<div class="page-foot" id="litFoot" data-kind="${kind}" data-dirty="${litDiff(kind) > 0}">${pendTag('项未保存', litDiff(kind))}<span class="spacer"></span>${asyncBtn(act, 'save', '保存', '已保存')}</div>`
const litAll = label => `<button type="button" class="icon-btn lit-all" data-act="lit-all" aria-label="全部${label}" data-tip="全部开 / 关">${icon('power')}</button>`
const secCount = list => `${list.filter(x => x.on).length}/${list.length}`
function toolsView() {
  if (legacy()) return head('工具', `<span class="count" id="toolCount">${S.tools.filter(t => t.on).length} / ${S.tools.length}</span>`) + `<div class="card"><div class="tgl-list stagger">${S.tools.map((t, i) => `<label class="tgl-row" style="--i:${i}"><span class="tr-main"><code>${t.name}</code><small>${t.src}</small></span>${tgl(t.on, `data-act="tool" data-v="${t.name}"`)}</label>`).join('')}</div></div>` + litFoot('tool', 'save-tools')
  const groups = [...new Set(S.tools.map(t => t.src))].sort((a, b) => (b === '内置工具') - (a === '内置工具'))
  return head('工具', `<span class="count" id="toolCount">${S.tools.filter(t => t.on).length} / ${S.tools.length}</span>`) + `<div class="card lit-card stagger">${groups.map((g, gi) => {
    const list = S.tools.filter(t => t.src === g)
    return `<section class="lit-sec" style="--i:${gi}"><div class="lit-head"><strong>${esc(g)}</strong><span class="lit-n mono">${secCount(list)}</span><span class="spacer"></span>${litAll(g)}</div><div class="lit-grid">${list.map(t => lit('tool', t.name, t.on, `<code>${t.name}</code>`)).join('')}</div></section>`
  }).join('')}</div>` + litFoot('tool', 'save-tools')
}
function pluginsView() {
  if (legacy()) return head('插件') + `<div class="card"><div class="tgl-list one stagger">${S.plugins.map((p, i) => `<label class="tgl-row" style="--i:${i}"><span class="tr-main"><strong>${p.name}</strong><small>${p.tools} 个工具</small></span>${tgl(p.on, `data-act="plugin" data-v="${p.id}"`)}</label>`).join('')}</div></div>` + litFoot('plugin', 'save-plugins')
  return head('插件') + `<div class="card lit-card"><section class="lit-sec"><div class="lit-head"><span class="lit-n mono">${secCount(S.plugins)}</span><span class="spacer"></span>${litAll('插件')}</div><div class="lit-grid big stagger">${S.plugins.map((p, i) => lit('plugin', p.id, p.on, `<span class="lit-txt"><strong>${esc(p.name)}</strong><small>${p.tools} 个工具</small></span>`, 'big').replace('class="lit big"', `style="--i:${i}" class="lit big"`)).join('')}</div></section></div>` + litFoot('plugin', 'save-plugins')
}
function setLit(t, on, pt) {
  if (t.getAttribute('aria-checked') === String(on)) return
  t.setAttribute('aria-checked', on)
  const kind = t.dataset.kind, v = t.dataset.v
  const item = kind === 'tool' ? S.tools.find(x => x.name === v) : kind === 'plugin' ? S.plugins.find(x => x.id === v) : null
  if (item) item.on = on
  if (!instant()) {
    const r = t.getBoundingClientRect(), x = pt ? pt.x - r.left : r.width / 2, y = pt ? pt.y - r.top : r.height / 2
    const R = Math.ceil(Math.hypot(Math.max(x, r.width - x), Math.max(y, r.height - y)))
    t.querySelector('.lit-flood').animate([{ clipPath: `circle(${on ? 0 : R}px at ${x}px ${y}px)` }, { clipPath: `circle(${on ? R : 0}px at ${x}px ${y}px)` }], { duration: on ? 520 : 300, easing: on ? 'cubic-bezier(.16,1,.3,1)' : 'cubic-bezier(.5,0,.75,0)' })
  }
  litChanged(t)
}
function litChanged(t) {
  const kind = t.dataset.kind, sec = t.closest('.lit-sec')
  if (kind === 'tool' || kind === 'plugin') {
    if (sec) { const items = $$('.lit', sec); sec.querySelector('.lit-n').textContent = `${items.filter(x => x.getAttribute('aria-checked') === 'true').length}/${items.length}` }
    const c = $('#toolCount'); if (c && kind === 'tool') { const n = S.tools.filter(x => x.on).length; c.textContent = `${n} / ${S.tools.length}` }
    setFoot($('#litFoot'), litDiff(kind))
  } else if (kind === 'model') mdlCount(t.closest('.backdrop'))
}
let paint = null
addEventListener('pointerdown', e => {
  const t = e.target.closest('.lit'); if (!t || e.button !== 0 || t.disabled) return
  e.preventDefault(); t.focus({ preventScroll: true }); hideTip()
  if (t.classList.contains('lit-add')) return addModelTile(t.closest('.backdrop'))
  paint = { on: t.getAttribute('aria-checked') !== 'true', kind: t.dataset.kind, seen: new Set([t]) }
  setLit(t, paint.on, { x: e.clientX, y: e.clientY })
  root.classList.add('painting')
})
addEventListener('pointermove', e => {
  if (!paint) return
  const t = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('.lit')
  if (!t || paint.seen.has(t) || t.dataset.kind !== paint.kind || t.classList.contains('lit-add')) return
  paint.seen.add(t); setLit(t, paint.on, { x: e.clientX, y: e.clientY })
})
const endPaint = () => { if (!paint) return; paint = null; root.classList.remove('painting') }
addEventListener('pointerup', endPaint); addEventListener('pointercancel', endPaint)
// keyboard (Space / Enter) arrives as a click with detail 0
addEventListener('click', e => {
  const t = e.target.closest?.('.lit'); if (!t || e.detail !== 0) return
  if (t.classList.contains('lit-add')) return addModelTile(t.closest('.backdrop'))
  setLit(t, t.getAttribute('aria-checked') !== 'true')
})
function litAllAct(a) {
  const box = a.closest('.lit-sec') || a.closest('.backdrop')
  const tiles = $$('.lit:not(.lit-add)', box).filter(t => !t.hidden)
  const on = !tiles.every(t => t.getAttribute('aria-checked') === 'true')
  tiles.forEach((t, i) => { const r = t.getBoundingClientRect(), pt = { x: r.left + 6, y: r.top + r.height / 2 }; if (instant()) setLit(t, on); else setTimeout(() => setLit(t, on, pt), i * 22) })
}

// ---- API form: available models are lit tiles too ----
const PROTO_TAG = id => isImg(id) ? 'Images' : (m => m ? protoOf(m) : '')(meta(id))
function mdlCandidates(a) { return [...new Set([...S.models.map(m => m.id), ...IMAGE_MODELS.slice(0, 2), ...(a?.models || [])])].sort(natural) }
function mdlGrid(a) {
  const sel = new Set(a?.models || [])
  return mdlCandidates(a).map(id => lit('model', id, sel.has(id), `<code>${esc(id)}</code><span class="lit-tag">${PROTO_TAG(id)}</span>`)).join('')
}
function mdlChooser(a) {
  return `<div class="lit-sec mdl-sec"><div class="lit-head"><strong>模型</strong><span class="lit-n mono mdl-n"></span><span class="spacer"></span>${litAll('模型')}</div>
    <div class="mdl-find">${icon('search')}<input class="mdl-q" placeholder="搜索或输入模型 ID" aria-label="搜索或输入模型 ID" spellcheck="false"></div>
    <div class="lit-grid mdl-grid">${mdlGrid(a)}<button type="button" class="lit lit-add" hidden><span class="lit-flood"></span>${icon('plus')}<code></code></button></div></div>`
}
// tiles whose protocol is not offered by this API are hatched (selected) or hidden (unselected)
function mdlSync(b) {
  const protos = ['OpenAI', 'Anthropic'].filter(p => b.querySelector(`[data-f="${p}"]`)?.checked), q = (b.querySelector('.mdl-q')?.value || '').trim().toLowerCase()
  for (const t of $$('.mdl-grid .lit:not(.lit-add)', b)) {
    const tag = PROTO_TAG(t.dataset.v), need = tag === 'Images' ? 'OpenAI' : tag, ok = !need || protos.includes(need), on = t.getAttribute('aria-checked') === 'true'
    t.classList.toggle('na', !ok); t.dataset.tip = ok ? '' : `需要 ${need} 兼容`; if (ok) delete t.dataset.tip
    t.hidden = (!ok && !on) || (q && !t.dataset.v.toLowerCase().includes(q))
    t.querySelector('.lit-tag').hidden = !(protos.length > 1 || tag === 'Images' || !ok)
  }
  const add = b.querySelector('.lit-add'), raw = (b.querySelector('.mdl-q')?.value || '').trim()
  if (add) { add.hidden = !raw || $$('.mdl-grid .lit:not(.lit-add)', b).some(t => t.dataset.v.toLowerCase() === raw.toLowerCase()); add.querySelector('code').textContent = raw }
  mdlCount(b)
}
function mdlCount(b) { const n = b?.querySelector('.mdl-n'); if (n) n.textContent = `${$$('.mdl-grid .lit[aria-checked="true"]', b).length}` }
function addModelTile(b) {
  const q = b.querySelector('.mdl-q'), id = q.value.trim(); if (!id) return
  const add = b.querySelector('.lit-add'), box = document.createElement('div')
  box.innerHTML = lit('model', id, false, `<code>${esc(id)}</code><span class="lit-tag"></span>`)
  const t = box.firstElementChild; add.before(t); q.value = ''; mdlSync(b)
  const r = t.getBoundingClientRect(); setLit(t, true, { x: r.left + r.width / 2, y: r.top + r.height / 2 })
  q.focus()
}
addEventListener('input', e => { if (e.target.matches?.('.mdl-q')) mdlSync(e.target.closest('.backdrop')) })
addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.matches?.('.mdl-q')) { e.preventDefault(); const b = e.target.closest('.backdrop'); if (!b.querySelector('.lit-add').hidden) addModelTile(b) } })
addEventListener('change', e => { if (e.target.matches?.('[data-f="OpenAI"], [data-f="Anthropic"]')) { const b = e.target.closest('.backdrop'); if (b?.querySelector('.mdl-grid')) mdlSync(b) } })

// ---- per-capability parameters (source: parameters(slot) dialog, 确定 writes the draft) ----
const PARAM_TITLE = { main: '主模型参数', image: '图片生成参数', search: '搜索参数' }
const ro = v => `<span class="ro mono">${esc(v)}</span>`
function ctxSeg(v) { return `<div class="seg tseg" role="group" aria-label="搜索上下文" data-f="context"><span class="seg-ind"></span>${['', 'low', 'medium', 'high'].map(x => `<button type="button" data-act="seg-pick" data-v="${x}" aria-pressed="${v === x}">${x || '默认'}</button>`).join('')}</div>` }
function paramsDialog(slot) {
  const P = S.model.p[slot], L = legacy()
  const num = (f, ph, tip, steps = 'ms', ic = 'timer') => L ? `<label class="field"><span>${tip}</span><input class="inp mono" data-f="${f}" value="${esc(P[f])}" placeholder="${ph}" inputmode="numeric"></label>` : prow(ic, tip.replace(/（ms）/, ''), scrub({ f, value: P[f], ph, ic, tip, steps }))
  const txt = (f, ph, label, ic) => L ? `<label class="field"><span>${label}</span><input class="inp mono" data-f="${f}" value="${esc(P[f])}" placeholder="${ph}"></label>` : prow(ic, label, ink(`class="mono" data-f="${f}" value="${esc(P[f])}" placeholder="${ph}" aria-label="${label}"`))
  const info = v => L ? `<dl class="param-sum"><dt>接口</dt><dd>${esc(v)}</dd></dl>` : prow('plug', '接口', ro(v))
  const sub = t => `<div class="sub-h">${t}</div>`
  let body = ''
  if (slot === 'main') body = info(wireOf()) + num('timeout', 360000, '请求超时（ms）') + num('idle', 360000, '流式空闲超时（ms）', 'ms', 'idle')
  if (slot === 'image') body = info('OpenAI Images') + num('timeout', 360000, '请求超时（ms）')
  if (slot === 'search') body = sub('OpenAI') + (L ? `<label class="field"><span>搜索上下文</span><input class="inp" data-f="context" value="${esc(P.context)}" placeholder="默认"></label>` : prow('context', '搜索上下文', ctxSeg(P.context)))
    + num('tokens', 1200, '最大输出 Token', 'tokens', 'out') + num('timeout', 120000, '请求超时（ms）') + txt('toolType', 'web_search', '搜索工具类型', 'tools')
    + sub('Exa') + txt('exaUrl', 'https://mcp.exa.ai/mcp', 'MCP URL', 'globe') + txt('exaTool', 'web_search_exa', '工具名称', 'tools') + num('exaTimeout', 120000, '请求超时（ms）')
  const b = openDialog(dlgHead(PARAM_TITLE[slot]) + `<div class="dlg-body ${L ? 'form-grid' : 'sheet'}">${body}</div>
    <footer class="dlg-foot"><span class="spacer"></span><button type="button" class="btn" data-act="close">取消</button><button type="button" class="btn primary" data-act="save-params">${icon('check')}确定</button></footer>`, { cls: 'narrow' })
  b._slot = slot
  const seg = b.querySelector('.tseg'); if (seg) requestAnimationFrame(() => placeSeg(seg, false))
}
const SWITCH_ACT = {
  'conn-on'(a) {
    const row = a.closest('.api-row'), o = S.model.order.find(x => x.id === row.dataset.id)
    o.on = !o.on; setPip(a, o.on); row.classList.toggle('off', !o.on)
    $('#apiList').dataset.sig = orderSig(); syncModel()
  },
  'lit-all': a => litAllAct(a),
  params: a => paramsDialog(a.dataset.v),
  'seg-pick'(a) { for (const x of a.parentElement.querySelectorAll('button')) x.setAttribute('aria-pressed', String(x === a)); placeSeg(a.parentElement) },
  'save-params'(a) {
    const b = a.closest('.backdrop'), P = { ...S.model.p[b._slot] }
    for (const el of $$('[data-f]', b)) P[el.dataset.f] = el.matches('.tseg') ? el.querySelector('[aria-pressed="true"]')?.dataset.v || '' : el.value.trim()
    S.model.p[b._slot] = P; closeDialog(b); syncModel()
  },
  async 'save-tools'(a) { if (!await runAsync(a, 500)) return; S.litApplied.tool = litSnap('tool'); setFoot($('#litFoot'), 0); toast('已生效') },
  async 'save-plugins'(a) { if (!await runAsync(a, 500)) return; S.litApplied.plugin = litSnap('plugin'); setFoot($('#litFoot'), 0); toast('已生效') },
}
