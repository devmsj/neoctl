// ===== new form language: values read like content, edit where they are =====
Object.assign(EXTRA, {
  globe: { d: 'M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0ZM3 10h14M10 3c2 2 2.8 4.4 2.8 7S12 15 10 17c-2-2-2.8-4.4-2.8-7S8 5 10 3Z' },
  key: { d: 'M12.5 3.5a4 4 0 1 1-3.4 6.1L3.5 15.2v1.3h2.2v-1.6h1.6v-1.6h1.6l.9-.9a4 4 0 0 1 2.7-8.9ZM13.6 7.3h.01' },
  eye: { d: 'M2.5 10s2.7-5 7.5-5 7.5 5 7.5 5-2.7 5-7.5 5-7.5-5-7.5-5ZM12.3 10a2.3 2.3 0 1 1-4.6 0 2.3 2.3 0 0 1 4.6 0Z' },
  monitor: { d: 'M3 4h14v9H3ZM7.5 16.5h5M10 13v3.5' },
  out: { d: 'M10 3v9m-3.5-3.5L10 12l3.5-3.5M4 14v2.5h12V14' },
  window: { d: 'M3 4h14v12H3ZM3 7.5h14M10 10.5h4' },
  timer: { d: 'M16 11a6 6 0 1 1-12 0 6 6 0 0 1 12 0ZM10 8v3l2 1.5M8 2.5h4' },
  idle: { d: 'M2.5 10h3l1.5-4 3 8 1.5-4h6' },
  brush: { d: 'M14.5 3 17 5.5l-7.2 7.2-2.5-2.5ZM7.3 10.2c-2 0-3.3 1.4-3.3 3.3 0 1.2-.5 2.2-1.5 3h4.2c2 0 3.3-1.3 3.3-3.3' },
  fill: { d: 'M3.5 3.5h13v13h-13ZM3.5 9.5h13' },
})
const legacy = () => S.style === 'legacy'
const protoOf = m => m.p === 'anthropic' ? 'Anthropic' : 'OpenAI'
const isPh = v => !v || v === '关闭'
const sv = v => `<span class="sv"><span${isPh(v) ? ' class="ph"' : ''}>${esc(v || '未配置')}</span></span>`
function swapText(el, v) {
  const box = el.querySelector('.sv'), old = box.lastElementChild, text = v || '未配置'
  if (old && old.textContent === text && !old.classList.contains('v-out')) return
  const n = document.createElement('span'); n.textContent = text; if (isPh(v)) n.className = 'ph'
  if (instant() || !old) { box.replaceChildren(n); return }
  old.classList.add('v-out'); n.classList.add('v-in')
  old.addEventListener('animationend', () => old.remove(), { once: true })
  box.append(n)
}

// ---- building blocks ----
const chip = (key, ic, tip) => `<button type="button" class="chip" data-act="pal" data-key="${key}" data-tip="${tip}" aria-label="${tip}" aria-haspopup="listbox" aria-expanded="false">${icon(ic)}${sv(getVal(key))}<span class="chip-car">${icon('chevron')}</span></button>`
const hero = key => `<button type="button" class="hero" data-act="pal" data-key="${key}" aria-haspopup="listbox" aria-expanded="false">${sv(getVal(key))}${icon('chevron', 'chev')}</button>`
function lvl() {
  const k = EFFORTS.indexOf(S.model.effort)
  return `<div class="chip lvl" role="slider" tabindex="0" aria-label="推理强度" data-tip="推理强度" aria-valuemin="0" aria-valuemax="5" aria-valuenow="${k}" aria-valuetext="${S.model.effort}" data-k="${k}"><span class="bars">${EFFORTS.slice(1).map((_, i) => `<i style="--h:${i + 1}" class="${i + 1 <= k ? 'on' : ''}"></i>`).join('')}</span>${sv(S.model.effort)}</div>`
}
const scrub = ({ id = '', f = '', value = '', ph = '', ic, tip, steps = 'tokens' }) => `<span class="chip scrub${value ? ' has' : ''}" data-tip="${tip}" data-steps="${steps}">${icon(ic)}<input class="scrub-inp mono" ${id ? `id="${id}"` : ''} ${f ? `data-f="${f}"` : ''} value="${esc(value)}" placeholder="${esc(ph)}" readonly inputmode="numeric" aria-label="${tip}"><button type="button" class="scrub-x" data-act="scrub-clear" tabindex="-1" aria-label="恢复默认">${icon('close')}</button><span class="ruler"></span></span>`
const tchip = (label, ic, on, attrs, type = 'checkbox') => `<label class="tchip"><input type="${type}" ${on ? 'checked' : ''} ${attrs}><span class="tc-box">${CHECK}</span>${ic ? icon(ic) : ''}<span>${label}</span></label>`
const ink = (attrs, cls = '') => `<span class="ink ${cls}"><input ${attrs} spellcheck="false"></span>`
const secret = attrs => `<span class="ink secret"><input type="password" ${attrs}><button type="button" class="icon-btn reveal" tabindex="-1" aria-label="按住显示" data-tip="按住显示">${icon('eye')}</button></span>`
const prow = (ic, label, ctl, cls = '') => `<div class="prow ${cls}">${icon(ic)}${label ? `<span class="prow-l">${label}</span>` : ''}<div class="prow-c">${ctl}</div></div>`
const titleHead = (attrs, extra = '') => `<header class="dlg-head">${ink(attrs, 'title-ink')}${extra}${ib('close', '关闭', 'close')}</header>`

// ---- pages ----
function modelView() {
  if (legacy()) return modelViewOld()
  const m = meta(S.model.model)
  const off = !S.model.imgModel, noImgRoute = !slotRoute(slotOf('image'))
  return head('模型', `<button type="button" class="btn" data-act="library">${icon('library')}模型库</button>${ib('refresh', '刷新', 'refresh')}`) + `
  <div class="caps stagger">
  ${apiCard(0)}
  <section class="card capcard main" style="--i:1"><div class="card-head">${icon('model')}<strong>主模型</strong><span class="spacer"></span>${ib('sliders', '参数', 'params', '', 'data-v="main"')}${ib('diagnose', '检测', 'test-one', '', 'data-v="main"')}</div>
    <div class="cap-body"><div class="hero-line">${hero('model')}<span id="capSlot" class="hero-caps">${m?.img ? `<span class="cap" data-tip="图片输入">${icon('image', 'cap-ok')}</span>` : ''}</span><span class="spacer"></span>${routeHint('main')}</div>
    <div class="chip-row">${lvl()}${scrub({ id: 'maxTok', value: S.model.maxTokens, ph: m ? m.out : '', ic: 'out', tip: '最大输出 Token' })}</div>${issueLine('main')}</div></section>
  <section class="card capcard" style="--i:2"><div class="card-head">${icon('imageGenerate')}<strong>图片生成</strong><span class="spacer"></span>${ib('sliders', '参数', 'params', '', `data-v="image"${off ? ' disabled' : ''}`)}${ib('diagnose', '检测', 'test-one', '', `data-v="image"${noImgRoute ? ' disabled' : ''}`)}</div>
    <div class="cap-body"><div class="hero-line">${hero('imgModel')}<span class="spacer"></span>${routeHint('image')}</div>${issueLine('image')}</div></section>
  <section class="card capcard" style="--i:3"><div class="card-head">${icon('search')}<strong>搜索</strong><span class="spacer"></span>${ib('sliders', '参数', 'params', '', 'data-v="search"')}${ib('diagnose', '检测', 'test-one', '', 'data-v="search"')}</div>
    <div class="cap-body"><div class="hero-line">${hero('searchModel')}<span class="spacer"></span>${routeHint('search')}</div><div class="chip-row">${tchip(`Exa <span class="exa-tag">${S.model.searchModel ? '备用' : '直接搜索'}</span>`, '', S.model.exa, 'id="exaChk"')}</div>${issueLine('search')}</div></section>
  </div>
  <div class="page-foot" id="modelFoot" data-dirty="${dirty()}">${pendTag('项未应用', modelDiff())}<span class="spacer"></span><button type="button" class="btn dirty-only" data-act="revert">${icon('undo')}撤销</button><button type="button" class="btn" data-act="test">${icon('diagnose')}检测</button>${asyncBtn('apply', 'apply', '应用', '已生效').replace('data-state', `${applyIssue() ? 'disabled ' : ''}data-state`)}</div>`
}
function promptView() {
  if (legacy()) return subView('promptOld')
  return head('提示词') + `<div class="card paper"><textarea class="prompt-area" id="promptText" spellcheck="false" aria-label="提示词">${esc(S.prompt)}</textarea><span class="paper-n mono" id="promptN">${S.prompt.length}</span></div><div class="page-foot"><span class="spacer"></span>${asyncBtn('save-prompt', 'save', '保存', '已保存')}</div>`
}
function cpaView() {
  if (legacy()) return subView('cpaOld')
  return head('CPA') + `<div class="card sheet">
    ${prow('globe', '管理地址', ink(`class="mono" id="cpaUrl" value="${esc(S.cpa.url)}" placeholder="http://"`))}
    ${prow('key', '管理密码', secret('value="cpa-management-key" placeholder="请输入管理密码" aria-label="管理密码"'))}</div>
    <div class="page-foot"><span class="spacer"></span>${asyncBtn('save-cpa', 'save', '保存', '已保存')}</div>`
}
const FOLLOW = [['跟随系统', 'monitor'], ['固定日间', 'sun'], ['固定夜间', 'moon']]
function followCtl() {
  if (legacy()) return sel('follow')
  return `<div class="seg iseg" role="group" aria-label="显示模式"><span class="seg-ind"></span>${FOLLOW.map(([v, i]) => `<button type="button" data-act="follow" data-v="${v}" aria-pressed="${S.follow === v}" aria-label="${v}" data-tip="${v}">${icon(i)}</button>`).join('')}</div>`
}

// ---- dialogs ----
function apiForm(a) {
  if (legacy()) return apiFormOld(a)
  const b = openDialog(titleHead(`data-f="name" value="${esc(a?.name || '')}" placeholder="API 名称" aria-label="名称"`) + `<div class="dlg-body sheet">
    <div class="chips">${tchip('OpenAI 兼容', '', a ? a.proto.includes('OpenAI') : true, 'data-f="OpenAI"')}${tchip('Anthropic 兼容', '', a?.proto.includes('Anthropic'), 'data-f="Anthropic"')}</div>
    ${prow('globe', '', ink(`class="mono" data-f="url" value="${esc(a?.url || '')}" placeholder="Base URL" aria-label="Base URL"`), 'bare')}
    ${prow('key', '', secret(`data-f="key" value="" placeholder="${a ? '留空保留原密钥' : 'API Key'}" aria-label="API Key"`), 'bare')}
    ${mdlChooser(a)}</div>
    <footer class="dlg-foot">${a ? ib('trash', '删除 API', 'del-api', 'danger-ic') : ''}<span class="spacer"></span><button type="button" class="btn" data-act="close">取消</button>${asyncBtn('save-api', 'save', '保存', '已保存')}</footer>`, { cls: 'mid' })
  b._api = a; mdlSync(b)
}
function modelForm(m) {
  if (legacy()) return modelFormOld(m)
  const p = m?.p || 'openai'
  const b = openDialog(titleHead(`class="mono" data-f="id" value="${esc(m?.id || '')}" placeholder="模型 ID" aria-label="模型 ID"`) + `<div class="dlg-body sheet">
    <div class="chips"><input type="hidden" data-f="p" value="${esc(p)}">${tchip('openai', '', p === 'openai', 'name="prov" value="openai"', 'radio')}${tchip('anthropic', '', p === 'anthropic', 'name="prov" value="anthropic"', 'radio')}<span class="spacer"></span>${tchip('图片输入', 'image', m ? m.img : true, 'data-f="img"')}</div>
    ${prow('context', '上下文', scrub({ f: 'ctx', value: m?.ctx || 256000, ic: 'context', tip: '上下文 Token' }))}
    ${prow('out', '最大输出', scrub({ f: 'out', value: m?.out || 128000, ic: 'out', tip: '最大输出 Token' }))}</div>
    <footer class="dlg-foot"><span class="spacer"></span><button type="button" class="btn" data-act="close">取消</button>${asyncBtn('save-model', 'save', '保存', '已保存')}</footer>`, { cls: 'narrow' })
  b._model = m
}
function presetDialog(id) {
  if (legacy()) return presetDialogOld(id)
  const p = P(id), s = { ...p[S.mode], ...S.ov[id]?.[S.mode] }, D = DEFAULT_COLORS[S.mode]
  const row = (k, l, ic) => { const v = s[k] || D[k]; return prow(ic, l, `<span class="orb" style="--c:${v}"><input type="color" class="swatch" data-k="${k}" value="${v}" aria-label="${l}"></span>${ink(`class="mono hex" data-hex="${k}" value="${v}" maxlength="7" aria-label="${l}"`)}`) }
  const b = openDialog(dlgHead(p.name, `<span class="tag">${S.mode === 'dark' ? '夜间' : '日间'}</span>`) + `<div class="dlg-body sheet">${row('accent', '重点色', 'brush')}${row('background', '背景', 'fill')}</div>
    <footer class="dlg-foot"><span class="spacer"></span><button type="button" class="btn" data-act="close">取消</button>${asyncBtn('save-preset', 'save', '保存', '已保存')}</footer>`, { cls: 'narrow' })
  b._preset = id; b._prev = structuredClone(S.ov)
  b._resolve = saved => { if (!saved) { S.ov = b._prev; applyAppearance(); refreshLook() } }
}

// ---- palette: grows out of the value you clicked ----
let pal = null
function palItems(key) {
  // options come from enabled APIs only (source pool()); a value no API serves stays visible but disabled
  const withCur = (items, v) => v && !items.some(o => o.v === v) ? [...items, { v, label: v, mono: true, off: true, sub: '无已启用的 API 提供' }] : items
  if (key === 'model') {
    const both = bothProtos()
    const items = pool(id => !isImg(id)).map(id => { const m = meta(id), r = route(id); return { v: id, label: id, group: both ? r.p : '', img: m?.img, mono: true, sub: [m && `${Math.round(m.ctx / 1000)}k · ${Math.round(m.out / 1000)}k`, r.a.name].filter(Boolean).join(' · ') } })
    if (both) items.sort((x, y) => x.group.localeCompare(y.group))
    return withCur(items, S.model.model)
  }
  if (key === 'imgModel' || key === 'searchModel') {
    const ids = key === 'imgModel' ? pool(isImg, 'OpenAI') : pool(id => !isImg(id), 'OpenAI')
    return [{ v: '关闭', label: '关闭' }, ...withCur(ids.map(id => ({ v: id, label: id, mono: true, sub: route(id, 'OpenAI').a.name })), S.model[key])]
  }
  return OPTS[key]().map(v => ({ v, label: v, mono: true }))
}
function clipFor(t, el) {
  const a = t.getBoundingClientRect(), b = el.getBoundingClientRect(), r = getComputedStyle(t).borderRadius
  return `inset(${a.top - b.top}px ${b.right - a.right}px ${b.bottom - a.bottom}px ${a.left - b.left}px round ${r})`
}
function openPal(t) {
  if (pal?._t === t) return closePal()
  closePal(true); closeMenus(); hideTip()
  const key = t.dataset.key, items = palItems(key), cur = getVal(key), el = document.createElement('div')
  el.className = 'pal'; el._t = t; el._key = key
  let g = '', html = ''
  items.forEach((o, i) => {
    if (o.group && o.group !== g) { g = o.group; html += `<div class="pal-group">${esc(g)}</div>` }
    html += `<button type="button" class="pal-opt${o.off ? ' off' : ''}" role="option" data-v="${esc(o.v)}" aria-selected="${o.v === cur}" ${o.off ? 'aria-disabled="true"' : ''} style="--i:${i}"><span class="po-main"><span class="po-l${o.mono ? ' mono' : ''}">${esc(o.label)}</span>${o.sub ? `<span class="po-s mono">${esc(o.sub)}</span>` : ''}</span><span class="po-r">${(o.tags || []).map(x => `<i>${x}</i>`).join('')}${o.img ? icon('image') : ''}<span class="po-ck">${o.v === cur ? CHECK : ''}</span></span></button>`
  })
  el.innerHTML = (items.length > 4 ? `<div class="pal-search">${icon('search')}<input placeholder="搜索" aria-label="搜索"></div>` : '') + `<div class="pal-list" role="listbox"><span class="pal-hl"></span>${html || '<div class="pal-empty">—</div>'}</div>`
  document.body.append(el); pal = el
  const r = t.getBoundingClientRect(), w = Math.max(r.width, 300)
  el.style.width = w + 'px'; el.style.left = Math.max(12, Math.min(r.left, innerWidth - w - 12)) + 'px'
  const h = el.offsetHeight; let top = r.bottom + 6
  if (top + h > innerHeight - 12 && r.top - 6 - h > 50) top = r.top - 6 - h
  el.style.top = top + 'px'
  t.classList.add('active'); t.setAttribute('aria-expanded', 'true')
  if (!instant()) el.animate([{ clipPath: clipFor(t, el), opacity: .4 }, { clipPath: `inset(0 round ${getComputedStyle(el).borderRadius})`, opacity: 1 }], { duration: 420, easing: 'cubic-bezier(.16,1,.3,1)' })
  const first = el.querySelector('.pal-opt[aria-selected="true"]') || el.querySelector('.pal-opt:not(.off)')
  hl(first, false)
  const inp = el.querySelector('.pal-search input'); (inp || first)?.focus({ preventScroll: true })
  el.addEventListener('pointerover', e => { const o = e.target.closest('.pal-opt:not(.off)'); if (o) hl(o) })
  el.addEventListener('click', e => { const o = e.target.closest('.pal-opt'); if (o && !o.classList.contains('off')) pick(o.dataset.v) })
  inp?.addEventListener('input', () => {
    const q = inp.value.trim().toLowerCase()
    for (const o of $$('.pal-opt', el)) o.hidden = q && !o.dataset.v.toLowerCase().includes(q)
    for (const gr of $$('.pal-group', el)) { let n = gr.nextElementSibling, any = false; while (n && n.classList.contains('pal-opt')) { if (!n.hidden) any = true; n = n.nextElementSibling } gr.hidden = !any }
    hl(el.querySelector('.pal-opt:not(.off):not([hidden])'))
  })
  el.addEventListener('keydown', e => {
    const opts = $$('.pal-opt:not(.off):not([hidden])', el), i = opts.indexOf(el._a)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const n = opts[(i + (e.key === 'ArrowDown' ? 1 : -1) + opts.length) % opts.length]; hl(n); if (!inp) n?.focus() }
    else if (e.key === 'Enter') { e.preventDefault(); if (el._a) pick(el._a.dataset.v) }
    else if (e.key === 'Escape') { e.stopPropagation(); closePal(); t.focus() }
    else if (e.key === 'Tab') { e.preventDefault() }
  })
}
function hl(o, anim = true) {
  const el = pal; if (!el) return
  const bar = el.querySelector('.pal-hl'); el._a = o
  if (!o) { bar.style.opacity = 0; return }
  if (!anim) bar.style.transition = 'none'
  bar.style.opacity = 1; bar.style.setProperty('--y', o.offsetTop + 'px'); bar.style.setProperty('--h', o.offsetHeight + 'px')
  if (!anim) { void bar.offsetWidth; bar.style.transition = '' }
  o.scrollIntoView({ block: 'nearest' })
}
function pick(v) {
  const t = pal._t, key = pal._key
  closePal(); t.focus({ preventScroll: true })
  if (getVal(key) === v) return
  setVal(key, v)
  refreshControls(); syncModel()
}
function closePal(now = false) {
  const el = pal; if (!el) return
  pal = null; el.style.pointerEvents = 'none'
  el._t.classList.remove('active'); el._t.setAttribute('aria-expanded', 'false')
  if (now || instant() || !el._t.isConnected) return el.remove()
  el.animate([{ clipPath: `inset(0 round ${getComputedStyle(el).borderRadius})`, opacity: 1 }, { clipPath: clipFor(el._t, el), opacity: 0 }], { duration: 200, easing: 'cubic-bezier(.5,0,.75,0)' }).onfinish = () => el.remove()
}
addEventListener('pointerdown', e => { if (pal && !e.target.closest('.pal, [data-act="pal"]')) closePal() }, true)
addEventListener('scroll', e => { if (pal && !e.target.closest?.('.pal')) closePal(true) }, true)
addEventListener('resize', () => closePal(true))

// ---- effort level: press or drag across the bars ----
function setLvl(el, k, user = true) {
  const old = +el.dataset.k; if (k === old && user) return
  el.dataset.k = k
  el.querySelectorAll('.bars i').forEach((b, i) => b.classList.toggle('on', i + 1 <= k))
  el.setAttribute('aria-valuenow', k); el.setAttribute('aria-valuetext', EFFORTS[k])
  swapText(el, EFFORTS[k])
  if (!user) return
  const b = el.querySelectorAll('.bars i')[Math.max(0, k - 1)]
  if (b && !instant()) b.animate([{ scale: '1 1.5' }, { scale: '1 1' }], { duration: 420, easing: 'cubic-bezier(.16,1,.3,1)' })
  setVal('effort', EFFORTS[k]); syncModel()
}
function lvlAt(el, x) {
  const bars = [...el.querySelectorAll('.bars i')], f = bars[0].getBoundingClientRect()
  if (x < f.left - 4) return 0
  let k = 1, best = Infinity
  bars.forEach((b, i) => { const r = b.getBoundingClientRect(), d = Math.abs(x - (r.left + r.width / 2)); if (d < best) { best = d; k = i + 1 } })
  return k
}
addEventListener('pointerdown', e => {
  const el = e.target.closest('.lvl'); if (!el) return
  e.preventDefault(); el.focus({ preventScroll: true }); el.setPointerCapture(e.pointerId); el.classList.add('pressing')
  setLvl(el, lvlAt(el, e.clientX))
  const move = ev => setLvl(el, lvlAt(el, ev.clientX))
  const up = () => { el.classList.remove('pressing'); el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up) }
  el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up)
})
addEventListener('pointermove', e => {
  const el = e.target.closest?.('.lvl'); if (!el || el.classList.contains('pressing')) return
  const k = lvlAt(el, e.clientX); el.querySelectorAll('.bars i').forEach((b, i) => b.classList.toggle('pre', i + 1 <= k))
})
addEventListener('pointerout', e => { const el = e.target.closest?.('.lvl'); if (el && !el.contains(e.relatedTarget)) el.querySelectorAll('.bars i').forEach(b => b.classList.remove('pre')) })

// ---- scrub numbers: drag sideways, click to type, × back to default ----
const STEPS = { tokens: [1024, 2048, 4096, 8192, 16000, 32000, 64000, 128000, 256000, 512000, 1000000], ms: [15000, 30000, 60000, 120000, 180000, 300000, 360000, 600000, 900000, 1800000] }
const fire = inp => inp.dispatchEvent(new Event('input', { bubbles: true }))
const scrubSync = inp => inp.closest('.scrub').classList.toggle('has', !!inp.value)
addEventListener('pointerdown', e => {
  const inp = e.target.closest('.scrub-inp'); if (!inp || !inp.readOnly) return
  e.preventDefault()
  const box = inp.closest('.scrub'), steps = STEPS[box.dataset.steps], x0 = e.clientX
  const base = +(inp.value || inp.placeholder) || steps[0]
  const i0 = steps.reduce((bi, v, i) => Math.abs(v - base) < Math.abs(steps[bi] - base) ? i : bi, 0)
  let moved = false, idx = i0
  inp.setPointerCapture(e.pointerId)
  const move = ev => {
    const dx = ev.clientX - x0
    if (Math.abs(dx) > 3 && !moved) { moved = true; box.classList.add('scrubbing'); hideTip() }
    if (!moved) return
    box.style.setProperty('--off', dx + 'px')
    const n = Math.max(0, Math.min(steps.length - 1, i0 + Math.round(dx / 18)))
    if (n !== idx) { idx = n; inp.value = steps[n]; fire(inp); scrubSync(inp); if (!instant()) inp.animate([{ translate: `0 ${n > i0 ? -3 : 3}px` }, { translate: '0 0' }], { duration: 180 }) }
  }
  const up = () => {
    inp.removeEventListener('pointermove', move); inp.removeEventListener('pointerup', up); inp.removeEventListener('pointercancel', up)
    box.classList.remove('scrubbing')
    if (!moved) { inp.readOnly = false; box.classList.add('typing'); inp.focus(); inp.select(); inp._was = inp.value }
  }
  inp.addEventListener('pointermove', move); inp.addEventListener('pointerup', up); inp.addEventListener('pointercancel', up)
})
addEventListener('focusout', e => {
  const inp = e.target.closest?.('.scrub-inp'); if (!inp || inp.readOnly) return
  inp.readOnly = true; inp.closest('.scrub').classList.remove('typing')
  inp.value = inp.value.replace(/\D/g, ''); fire(inp); scrubSync(inp)
})
addEventListener('keydown', e => {
  const inp = e.target.closest?.('.scrub-inp'); if (!inp) return
  if (!inp.readOnly) {
    if (e.key === 'Enter') { e.preventDefault(); inp.blur() }
    if (e.key === 'Escape') { e.stopPropagation(); inp.value = inp._was || ''; inp.blur() }
    return
  }
  if (e.key === 'Enter') { e.preventDefault(); inp.readOnly = false; inp.closest('.scrub').classList.add('typing'); inp._was = inp.value; inp.select() }
  if (/^Arrow(Left|Right|Up|Down)$/.test(e.key)) {
    e.preventDefault()
    const steps = STEPS[inp.closest('.scrub').dataset.steps], base = +(inp.value || inp.placeholder) || steps[0], up = /Right|Up/.test(e.key)
    const n = up ? steps.find(v => v > base) : [...steps].reverse().find(v => v < base)
    if (n) { inp.value = n; fire(inp); scrubSync(inp) }
  }
}, true)

// ---- lvl keyboard, ink underline origin, hold-to-reveal ----
addEventListener('keydown', e => {
  const el = e.target.closest?.('.lvl'); if (!el || !/^Arrow(Left|Right|Up|Down)$/.test(e.key)) return
  e.preventDefault(); setLvl(el, Math.max(0, Math.min(5, +el.dataset.k + (/Right|Up/.test(e.key) ? 1 : -1))))
})
addEventListener('pointerdown', e => {
  const k = e.target.closest('.ink'); if (k) { const r = k.getBoundingClientRect(); k.style.setProperty('--ox', ((e.clientX - r.left) / r.width * 100).toFixed(1) + '%') }
  const rv = e.target.closest('.reveal'); if (!rv) return
  e.preventDefault(); const inp = rv.parentElement.querySelector('input'); inp.type = 'text'; rv.classList.add('on')
  const hide = () => { inp.type = 'password'; rv.classList.remove('on'); removeEventListener('pointerup', hide); removeEventListener('pointercancel', hide) }
  addEventListener('pointerup', hide); addEventListener('pointercancel', hide)
})
addEventListener('change', e => {
  const r = e.target; if (r.name !== 'prov') return
  r.closest('.chips').querySelector('[data-f="p"]').value = r.value
})
addEventListener('input', e => {
  if (e.target.id === 'promptText') { const n = $('#promptN'); if (n) n.textContent = e.target.value.length }
  if (e.target.matches('.swatch, [data-hex]')) { const row = e.target.closest('.prow'); const v = e.target.value; if (row && /^#[0-9a-f]{6}$/i.test(v)) row.querySelector('.orb').style.setProperty('--c', v) }
})

// ---- keep every control in sync with S (used by undo / delete / rename) ----
function refreshControls() {
  for (const el of $$('#view [data-act="pal"]')) swapText(el, getVal(el.dataset.key))
  for (const s of $$('#view .sel')) swapValue(s, getVal(s.dataset.key) || '未配置')
  const l = $('#view .lvl'); if (l) setLvl(l, EFFORTS.indexOf(S.model.effort), false)
  const mt = $('#maxTok'); if (mt) { mt.value = S.model.maxTokens; if (mt.closest('.scrub')) scrubSync(mt) }
  const ex = $('#exaChk'); if (ex) ex.checked = S.model.exa
  const list = $('#apiList'); if (list && list.dataset.sig !== orderSig()) renderConnList()
}
const FORM_ACT = {
  pal: a => openPal(a),
  follow(a) {
    if (S.follow === a.dataset.v) return
    S.follow = a.dataset.v
    for (const b of a.parentElement.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b === a))
    placeSeg(a.parentElement); toast('已生效')
  },
  'scrub-clear'(a) { const inp = a.parentElement.querySelector('input'); inp.value = ''; fire(inp); scrubSync(inp) },
}
