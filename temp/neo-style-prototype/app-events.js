// ===== sessions page, actions, drag, init =====
function sessCard(s, i = 0) {
  const cur = s.id === S.current, run = s.id === S.running
  return `<div class="cl" data-id="${s.id}" style="--i:${i}"><div><div class="sess-card${cur ? ' current' : ''}"><div class="sess-main"><strong>${esc(s.t)}</strong>${run ? '<span class="pill live"><span class="q-run" aria-hidden="true"><i></i><i></i></span>运行中</span>' : ''}${cur ? '<span class="pill">当前</span>' : ''}</div><div class="sess-meta"><span>${s.time}</span><code>${s.sid}</code></div><div class="sess-acts">${ib('right', '打开', 'open', '', `data-id="${s.id}"`)}${ib('trash', '删除', 'del-session', '', `data-id="${s.id}"`)}</div></div></div></div>`
}
function sessionsView() {
  return `<header class="page-head"><h2 class="vt-title">会话</h2><span class="count" id="sessCount">${S.sessions.length}</span><span class="spacer"></span><button type="button" class="btn primary" data-act="new-session">${icon('plus')}新会话</button></header>
  <div class="sess-bar"><div class="search-box">${icon('search')}<input class="inp" data-act="sess-filter" placeholder="搜索会话" aria-label="搜索会话"></div></div>
  <div class="sess-pad stagger" id="sessList">${S.sessions.map(sessCard).join('')}</div>`
}

// ---- navigation ----
function go(view, sub = '', opt = {}) {
  if (S.view === view && S.sub === sub) return
  vt(() => { S.view = view; S.sub = sub; renderView(); opt.after?.() }, opt)
}
function toTitle(sub, el) { go('settings', sub, { dir: 'forward', from: el?.querySelector('.tile-title') || null }) }
function back() {
  const old = S.sub
  go('settings', '', { dir: 'back', after: () => { const t = $(`.t-${old} .tile-title`); if (t && S.style === 'new' && !reduced()) t.style.viewTransitionName = 'page-title' } })
}
function point(e) { const r = e?.target?.getBoundingClientRect?.(); return e?.clientX ? { x: e.clientX, y: e.clientY } : r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : { x: innerWidth / 2, y: 60 } }
function setMode(mode, e) {
  if (mode === S.mode) return
  const { x, y } = point(e)
  vt(() => { S.mode = mode; applyAppearance(); refreshLook() }, { type: 'theme', x, y })
}
function applyPreset(id, e) {
  if (id === S.preset) return
  const { x, y } = point(e)
  vt(() => { S.preset = id; S.transparency = null; applyAppearance(); refreshLook() }, { type: 'theme', x, y })
}
function newSession() {
  const id = 's' + Date.now(), s = { id, g: '今天', t: '未命名会话', time: '刚刚', sid: sid(S.sessions.length + 3) }
  S.sessions.unshift(s); S.current = id
  renderQuick(id)
  if (S.view === 'sessions') {
    const list = $('#sessList'), box = document.createElement('div')
    box.innerHTML = sessCard(s); const n = box.firstElementChild; n.classList.add('fresh-in')
    flip(list, () => { for (const c of $$('.sess-card.current', list)) { c.classList.remove('current'); c.querySelector('.pill:not(.live)')?.remove() } list.prepend(n) })
    tween($('#sessCount'), S.sessions.length - 1, S.sessions.length, v => Math.round(v), 400)
  } else go('chat')
}
function openSession(id) {
  if (S.current !== id) { S.current = id; renderQuick() }
  if (S.view !== 'chat') go('chat'); else { const v = $('#view'); v.classList.remove('entering'); void v.offsetWidth; if (!instant()) v.classList.add('entering') }
}
function removeRow(el, after) {
  if (instant()) { el.remove(); after?.(); return }
  const h = el.offsetHeight
  el.style.overflow = 'hidden'
  el.animate([{ height: h + 'px', opacity: 1 }, { height: '0px', opacity: 0, paddingTop: 0, paddingBottom: 0, marginTop: 0 }], { duration: 300, easing: 'cubic-bezier(.16,1,.3,1)' }).onfinish = () => { el.remove(); after?.() }
}
function shake(el) { el.classList.remove('shake'); void el.offsetWidth; el.classList.add('shake'); el.focus() }
let toolToast = 0
function quietToast(text) { if (performance.now() - toolToast < 1400) return; toolToast = performance.now(); toast(text) }

// ---- detection: every item resolves on its own ----
async function runTests(b) {
  const btn = b.querySelector('[data-act="run-test"]'); if (!btn || btn.disabled) return
  const rows = $$('.test-row', b).filter(r => r.querySelector('input').checked)
  if (!rows.length) return
  btn.disabled = true; btn.querySelector('span').textContent = '检测中'
  for (const r of $$('.test-row', b)) { r.classList.toggle('off', !rows.includes(r)); r.querySelector('.st').innerHTML = ''; r.querySelector('.ms').textContent = '' }
  const ms = { main: 1840, vision: 1320, image: 4100, search: 2650, exa: 980 }
  await Promise.all(rows.map(async r => {
    r.querySelector('.st').innerHTML = '<span class="spin"></span>'
    const t = instant() ? 300 : ms[r.dataset.k] * (.8 + Math.random() * .4)
    await sleep(t)
    if (!b.isConnected) return
    r.querySelector('.st').innerHTML = '<svg class="ok" viewBox="0 0 20 20"><path d="m4.5 10.5 3.5 3.5 7.5-8"/></svg>'
    r.querySelector('.ms').textContent = (t / 1000).toFixed(1) + ' s'
  }))
  if (!b.isConnected) return
  btn.disabled = false; btn.querySelector('span').textContent = '重新检测'
}

// ---- action table ----
const ACT = {
  noop() {},
  sel: a => openSel(a.closest('.sel')),
  opt(a) {
    const s = a.closest('.sel'), k = s.dataset.key, v = a.dataset.v
    if (getVal(k) !== v) { setVal(k, v); swapValue(s, v); if (k === 'follow') toast('已生效'); else syncModel() }
    closeSel(s); s.querySelector('.sel-trigger').focus({ preventScroll: true })
  },
  'app-menu'(a) {
    if ($('.app-menu')) return closeAppMenu()
    const items = [['chat', 'back', '回到对话'], ['new', 'plus', '新会话'], ['sessions', 'list', '会话管理'], ['settings', 'gear', '全局配置'], '-', ['info', 'panel', '显示控件'], ['theme', S.mode === 'dark' ? 'sun' : 'moon', S.mode === 'dark' ? '日间' : '夜间']]
    const m = document.createElement('div'); m.className = 'app-menu'; m.setAttribute('role', 'menu')
    m.innerHTML = items.map((x, i) => x === '-' ? '<hr>' : `<button type="button" role="menuitem" data-act="menu" data-v="${x[0]}" style="--i:${i}">${icon(x[1])}<span>${x[2]}</span></button>`).join('')
    a.closest('.side-foot').append(m); a.setAttribute('aria-expanded', 'true')
    m.querySelector('button').focus({ preventScroll: true })
  },
  menu(a, e) {
    const v = a.dataset.v; closeAppMenu()
    if (v === 'chat') go('chat'); else if (v === 'new') newSession(); else if (v === 'sessions') go('sessions'); else if (v === 'settings') go('settings', '')
    else if (v === 'info') ACT['toggle-info'](); else if (v === 'theme') setMode(S.mode === 'dark' ? 'light' : 'dark', e)
  },
  'q-search'() {
    const box = $('#qs'), cur = $('.q-search', box)
    if (cur) { if (cur.classList.contains('leaving')) return; cur.classList.add('leaving'); setTimeout(() => cur.remove(), instant() ? 0 : 200); for (const n of $$('#quick [hidden]')) n.hidden = false; return }
    box.innerHTML = '<div class="q-search"><input class="inp" data-act="q-filter" placeholder="搜索" aria-label="搜索会话"></div>'
    box.querySelector('input').focus()
  },
  'nav-sessions': () => go('sessions'),
  'nav-settings': () => go('settings', ''),
  'new-session': () => newSession(),
  open: a => openSession(a.dataset.id),
  'toggle-info'() { $('#shell').classList.toggle('info-off'); $$('[data-act="toggle-info"]').forEach(b => b.classList.toggle('on', !$('#shell').classList.contains('info-off'))) },
  pin: a => a.classList.toggle('on'),
  sub: a => toTitle(a.dataset.v, a),
  back: () => S.view === 'settings' && S.sub ? back() : go('settings', '', { dir: 'back' }),
  mode: (a, e) => setMode(a.dataset.v, e),
  preset: (a, e) => applyPreset(a.dataset.v, e),
  'edit-preset': a => presetDialog(a.dataset.v),
  designer: () => presetDialog(S.preset),
  'reset-preset'(a) {
    const id = a.dataset.v
    if (!S.ov[id]) { toast('已是默认', 'undo'); return }
    delete S.ov[id]; applyAppearance(); refreshLook(); toast('已恢复', 'undo')
  },
  close: a => closeDialog(a.closest('.backdrop')),
  'cfm-no': a => closeDialog(a.closest('.backdrop'), false),
  'cfm-ok': a => closeDialog(a.closest('.backdrop'), true),
  async 'save-preset'(a) {
    const b = a.closest('.backdrop')
    if (await runAsync(a, 450)) { b._resolve = null; closeDialog(b); refreshLook(); toast('已生效') }
  },
  async 'save-prompt'(a) { S.prompt = $('#promptText').value; if (await runAsync(a)) toast('运行中的会话下一轮生效') },
  async 'save-cpa'(a) { S.cpa.url = $('#cpaUrl').value; if (await runAsync(a)) toast('已生效') },
  async apply(a) {
    if (!dirty()) { toast('已是当前方案'); return }
    if (await runAsync(a, 700)) { S.applied = JSON.stringify(S.model); syncModel(); toast('已生效，运行中的会话下一轮生效') }
  },
  revert() {
    S.model = JSON.parse(S.applied)
    refreshControls(); syncModel()
  },
  refresh(a) { a.classList.remove('spinning'); void a.offsetWidth; a.classList.add('spinning'); setTimeout(() => a.classList.remove('spinning'), 750) },
  test: () => testDialog(),
  'test-one': a => testDialog(a.dataset.v),
  'run-test': a => runTests(a.closest('.backdrop')),
  library: () => libraryDialog(),
  'add-api': () => apiForm(null),
  'edit-api': a => apiForm(conn(a.closest('.api-row').dataset.id)),
  // source: delete lives in the API dialog; a running session served by it is interrupted, the next eligible API takes over
  async 'del-api'(a) {
    const b = a.closest('.backdrop'), api = b._api, busy = servingSlots(api.id).length > 0
    if (!await confirmDlg(`删除「${api.name}」？`, busy ? '有活动会话正通过此 API 调用，删除将打断会话；之后由下方符合条件的 API 生效。' : '', busy ? '删除并中断' : '删除')) return
    S.apis = S.apis.filter(x => x !== api)
    S.model.order = S.model.order.filter(o => o.id !== api.id)
    const ap = JSON.parse(S.applied); ap.order = ap.order.filter(o => o.id !== api.id); S.applied = JSON.stringify(ap)
    closeDialog(b)
    const row = $(`#apiList [data-id="${api.id}"]`)
    const done = () => { renderConnList(); syncModel() }
    if (row) removeRow(row, done); else done()
    toast('已删除，已生效', 'trash')
  },
  async 'save-api'(a) {
    const b = a.closest('.backdrop'), f = k => b.querySelector(`[data-f="${k}"]`)
    const name = f('name').value.trim(), url = f('url').value.trim(), proto = ['OpenAI', 'Anthropic'].filter(p => f(p).checked)
    if (!name) return shake(f('name'))
    if (!url) return shake(f('url'))
    if (!proto.length) return shake(f('OpenAI').closest('.chips'))
    const models = legacy() ? $$('[data-m]', b).filter(x => x.checked).map(x => x.dataset.m) : $$('.mdl-grid .lit[aria-checked="true"]', b).map(t => t.dataset.v)
    if (!await runAsync(a, 500)) return
    if (b._api) Object.assign(b._api, { name, url, proto, models })
    else {
      const api = { id: 'x' + Date.now(), name, url, proto, models }; S.apis.push(api)
      for (const c of [S.model]) c.order.push({ id: api.id, on: true })
      const ap = JSON.parse(S.applied); ap.order.push({ id: api.id, on: true }); S.applied = JSON.stringify(ap)
    }
    closeDialog(b); renderConnList(); refreshControls(); syncModel()
    if (!b._api) { const r = $('#apiList')?.lastElementChild; if (r && !instant()) r.classList.add('fresh') }
    toast('已保存，已生效')
  },
  'add-model': () => modelForm(null),
  'edit-model': a => modelForm(meta(a.closest('.api-row').dataset.id)),
  async 'del-model'(a) {
    const row = a.closest('.api-row'), id = row.dataset.id, busy = S.model.model === id
    if (!await confirmDlg(`删除 ${id}？`, busy ? '有会话正在使用该模型，删除将中断会话。' : '')) return
    S.models = S.models.filter(m => m.id !== id)
    if (busy) { S.model.model = ''; S.applied = JSON.stringify({ ...JSON.parse(S.applied), model: '' }) }
    removeRow(row, () => { refreshControls(); syncModel() })
    toast('已删除', 'trash')
  },
  async 'save-model'(a) {
    const b = a.closest('.backdrop'), f = k => b.querySelector(`[data-f="${k}"]`)
    const id = f('id').value.trim(), ctx = +f('ctx').value, out = +f('out').value
    if (!id) return shake(f('id'))
    if (S.models.some(m => m.id === id && m !== b._model)) return shake(f('id'))
    if (!(ctx > 0)) return shake(f('ctx'))
    if (!(out > 0)) return shake(f('out'))
    if (!await runAsync(a, 450)) return
    const next = { id, p: f('p').value.trim() || 'openai', ctx, out, img: f('img').checked }, list = $('#libList')
    if (b._model) {
      const old = b._model.id; Object.assign(b._model, next)
      if (old !== id) for (const x of S.apis) x.models = x.models.map(v => v === old ? id : v)
      if (S.model.model === old) { S.model.model = id; refreshControls() }
      const row = list?.querySelector(`[data-id="${CSS.escape(old)}"]`); if (row) row.outerHTML = libRow(b._model, true)
    } else {
      S.models.push(next); S.models.sort((x, y) => x.id.localeCompare(y.id, 'en', { numeric: true }))
      if (list) { const t = document.createElement('div'); t.innerHTML = libRow(next, true); const n = t.firstElementChild, i = S.models.indexOf(next); flip(list, () => list.insertBefore(n, list.children[i] || null)) }
    }
    syncModel(); closeDialog(b); toast(S.model.model === id ? '已生效，运行中的会话下一轮生效' : '已保存')
  },
  async 'fb-del'(a) {
    const cl = a.closest('.cl'), f = S.feedback.find(x => x.id === cl.dataset.id)
    if (!await confirmDlg('删除这条建议？', f.t)) return
    S.feedback = S.feedback.filter(x => x !== f)
    tween($('#fbCount'), S.feedback.length + 1, S.feedback.length, v => Math.round(v), 400)
    collapse(cl, () => { if (!S.feedback.length) morph($('#fbCard'), empty()) })
  },
  async 'fb-copy'(a) {
    const f = S.feedback.find(x => x.id === a.closest('.cl').dataset.id)
    try { await navigator.clipboard.writeText(`${f.t}\n${f.b}`) } catch {}
    toast('已复制', 'copy')
  },
  async 'del-session'(a) {
    const id = a.dataset.id, s = S.sessions.find(x => x.id === id), run = id === S.running
    if (!await confirmDlg(`删除「${s.t}」？`, run ? '会话正在运行，删除将中断。' : '')) return
    S.sessions = S.sessions.filter(x => x !== s)
    if (run) S.running = ''
    if (S.current === id) S.current = S.sessions[0]?.id || ''
    tween($('#sessCount'), S.sessions.length + 1, S.sessions.length, v => Math.round(v), 400)
    collapse($(`#sessList .cl[data-id="${id}"]`))
    const q = $(`#quick [data-id="${id}"]`); if (q) removeRow(q, () => renderQuick())
    toast('已删除', 'trash')
  },
  fast(a) {
    S.fast = !S.fast; a.classList.toggle('on', S.fast); a.setAttribute('aria-pressed', S.fast)
    toast(S.fast ? '已开启快速模式，消耗倍率增加' : '已关闭快速模式', 'fast')
  },
  compact: () => toast('已压缩上下文', 'compact'),
  send() { const t = $('.composer textarea'); if (!t.value.trim()) return shake(t); t.value = '' },
}

// ---- delegation ----
document.addEventListener('click', e => {
  if (!e.target.closest('.sel')) for (const s of $$('.sel.open')) closeSel(s)
  if (!e.target.closest('.app-menu, .app-trigger')) closeAppMenu()
  const a = e.target.closest('[data-act]')
  if (!a || a.matches('input')) return
  hideTip(); ACT[a.dataset.act]?.(a, e)
})
document.addEventListener('change', e => {
  const t = e.target, act = t.dataset.act
  if (act === 'tool' || act === 'plugin') {
    (act === 'tool' ? S.tools.find(x => x.name === t.dataset.v) : S.plugins.find(x => x.id === t.dataset.v)).on = t.checked
    const c = $('#toolCount'); if (c) c.textContent = `${S.tools.filter(x => x.on).length} / ${S.tools.length}`
    setFoot($('#litFoot'), litDiff(act))
  } else if (t.matches('.conn-chk')) {
    const row = t.closest('.api-row'), o = S.model.order.find(x => x.id === row.dataset.id); o.on = t.checked
    row.classList.toggle('off', !o.on); $('#apiList').dataset.sig = orderSig(); syncModel()
  }
  else if (t.id === 'exaChk') { S.model.exa = t.checked; syncModel() }
})
document.addEventListener('input', e => {
  const t = e.target, act = t.dataset.act
  if (t.id === 'maxTok') { S.model.maxTokens = t.value.replace(/\D/g, ''); if (t.value !== S.model.maxTokens) t.value = S.model.maxTokens; syncModel() }
  else if (act === 'q-filter') {
    const q = t.value.trim().toLowerCase()
    for (const n of $$('#quick .q-item')) n.hidden = q && !n.textContent.toLowerCase().includes(q)
    for (const g of $$('#quick .q-group')) { let n = g.nextElementSibling, any = false; while (n && !n.classList.contains('q-group')) { if (!n.hidden) any = true; n = n.nextElementSibling } g.hidden = !any }
  } else if (act === 'sess-filter') {
    const q = t.value.trim().toLowerCase(), list = $('#sessList')
    flip(list, () => { for (const c of list.children) c.hidden = q && !c.textContent.toLowerCase().includes(q) })
    $('#sessCount').textContent = list.querySelectorAll('.cl:not([hidden])').length
  } else if (act === 'lib-filter') {
    const q = t.value.trim().toLowerCase(), list = $('#libList')
    flip(list, () => { for (const c of list.children) c.hidden = q && !c.dataset.id.toLowerCase().includes(q) })
  } else if (t.matches('.swatch, [data-hex]')) {
    const b = t.closest('.backdrop'), k = t.dataset.k || t.dataset.hex, v = t.value.trim()
    if (!/^#[0-9a-f]{6}$/i.test(v)) return
    b.querySelector(t.dataset.k ? `[data-hex="${k}"]` : `.swatch[data-k="${k}"]`).value = v
    const id = b._preset; S.ov[id] = { ...S.ov[id], [S.mode]: { ...S.ov[id]?.[S.mode], [k]: v } }
    if (id === S.preset) applyAppearance()
    refreshLook()
  }
})
document.addEventListener('keydown', e => {
  const open = $('.sel.open')
  if (e.key === 'Escape') {
    if (open) { closeSel(open); open.querySelector('.sel-trigger').focus(); return }
    if ($('.app-menu')) { closeAppMenu(); $('.app-trigger')?.focus(); return }
    const b = $$('.backdrop:not(.leaving)').pop(); if (b) closeDialog(b); return
  }
  if (open && /Arrow(Up|Down)/.test(e.key)) {
    e.preventDefault()
    const opts = $$('.sel-opt', open), i = opts.indexOf(document.activeElement), n = opts[(i + (e.key === 'ArrowDown' ? 1 : -1) + opts.length) % opts.length]
    n.focus(); open.querySelector('.sel-menu').style.setProperty('--y', n.offsetTop + 'px'); return
  }
  if (e.key === 'Tab') {
    const b = $$('.backdrop:not(.leaving)').pop(); if (!b) return
    const f = $$('button:not([disabled]), input, textarea, [tabindex]:not([tabindex="-1"])', b).filter(x => x.offsetParent || x.type === 'checkbox')
    if (!f.length) return
    if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f.at(-1).focus() }
    else if (!e.shiftKey && document.activeElement === f.at(-1)) { e.preventDefault(); f[0].focus() }
    else if (!b.contains(document.activeElement)) { e.preventDefault(); f[0].focus() }
  }
})
document.addEventListener('pointerover', e => {
  const el = e.target.closest?.('[data-tip]')
  if (el === tipFor) return
  hideTip(); if (!el || e.pointerType === 'touch') return
  tipFor = el; tipTimer = setTimeout(() => el.isConnected && showTip(el), 420)
})
document.addEventListener('pointerdown', () => hideTip(), true)
document.addEventListener('pointermove', e => {
  const t = e.target.closest?.('.tile'); if (!t) return
  const r = t.getBoundingClientRect(); t.style.setProperty('--mx', e.clientX - r.left + 'px'); t.style.setProperty('--my', e.clientY - r.top + 'px')
})

// ---- drag to reorder API priority (top wins) ----
document.addEventListener('pointerdown', e => {
  const grip = e.target.closest('[data-drag]'); if (!grip) return
  e.preventDefault()
  const row = grip.closest('.api-row'), list = row.parentElement, y0 = e.clientY, top0 = row.offsetTop
  row.classList.add('dragging')
  const move = ev => {
    const dy = ev.clientY - y0, mid = top0 + dy + row.offsetHeight / 2
    const others = [...list.children].filter(n => n !== row)
    let target = others.find(n => mid < n.offsetTop + n.offsetHeight / 2) || null
    if (target !== row.nextElementSibling || (!target && row !== list.lastElementChild)) {
      const before = new Map(others.map(n => [n, n.getBoundingClientRect().top]))
      list.insertBefore(row, target)
      if (!instant()) for (const n of others) { const d = before.get(n) - n.getBoundingClientRect().top; if (d) n.animate([{ translate: `0 ${d}px` }, { translate: '0 0' }], { duration: 260, easing: 'cubic-bezier(.16,1,.3,1)' }) }
    }
    const ty = ev.clientY - y0 - (row.offsetTop - top0), min = -row.offsetTop, max = list.scrollHeight - row.offsetHeight - row.offsetTop
    row.style.translate = `0 ${Math.max(min, Math.min(max, ty))}px`
  }
  const up = () => {
    removeEventListener('pointermove', move); removeEventListener('pointerup', up); removeEventListener('pointercancel', up)
    const from = row.style.translate; row.style.translate = ''
    if (!instant() && from) row.animate([{ translate: from }, { translate: '0 0' }], { duration: 300, easing: 'cubic-bezier(.16,1,.3,1)' })
    row.classList.remove('dragging')
    // order is part of the draft: renumber the index switches, routes may move, 应用 makes it effective
    const order = [...list.children].map(n => n.dataset.id), prev = orderSig()
    S.model.order.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id))
    if (prev === orderSig()) return
    list.dataset.sig = orderSig()
    $$('.pip-n, .conn-index', list).forEach((n, i) => { if (n.textContent !== String(i + 1)) { n.textContent = i + 1; if (!instant()) n.animate([{ opacity: 0, translate: '0 6px' }, { opacity: 1, translate: '0 0' }], { duration: 260, easing: 'cubic-bezier(.16,1,.3,1)' }) } })
    syncModel()
  }
  addEventListener('pointermove', move); addEventListener('pointerup', up); addEventListener('pointercancel', up)
})

// ---- prototype bar ----
$('#pPreset').innerHTML = APPEARANCE_PRESETS.map(p => `<option value="${p.id}">${p.name}</option>`).join('')
$('#pStyle').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b || b.dataset.v === S.style) return
  S.style = b.dataset.v; applyAppearance(); renderView()
})
$('#pPreset').addEventListener('change', e => applyPreset(e.target.value, { target: e.target }))
$('#pMode').addEventListener('click', e => setMode(S.mode === 'dark' ? 'light' : 'dark', e))
$('#pRadius').addEventListener('input', e => { S.radius = +e.target.value; applyAppearance() })
$('#pBorder').addEventListener('input', e => { S.border = +e.target.value; applyAppearance() })
$('#pTrans').addEventListener('input', e => { S.transparency = +e.target.value; applyAppearance() })
$('#pMotion').addEventListener('change', e => { S.motion = e.target.checked ? 'reduce' : 'full'; applyAppearance() })

// ---- live memory sparkline (single cheap timer) ----
setInterval(() => {
  if (document.hidden) return
  mem.shift(); mem.push(Math.max(190, Math.min(250, mem.at(-1) + (Math.random() - .5) * 14)))
  const [line, area] = sparkPaths(), l = $('.spark-line'), a = $('.spark-area'); if (!l) return
  l.style.d = `path('${line}')`; a.style.d = `path('${area}')`
  const v = $('#memV'), from = parseInt(v.textContent); tween(v, from, Math.round(mem.at(-1)), x => Math.round(x) + ' MB', 700)
}, 1800)

// ---- init ----
Object.assign(ACT, FORM_ACT, SWITCH_ACT)
Object.defineProperty(window, '__model', { get: () => JSON.stringify(S.model) })
applyAppearance(); renderSidebar(); renderWinbar(); renderInfo(); renderView()
ACT['toggle-info'](); ACT['toggle-info']()
requestAnimationFrame(() => placeSeg($('#pStyle'), false))
