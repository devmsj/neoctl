// ===== core: state, helpers, motion primitives =====
const $ = (s, r = document) => r.querySelector(s)
const $$ = (s, r = document) => [...r.querySelectorAll(s)]
const root = document.documentElement
const sleep = ms => new Promise(r => setTimeout(r, ms))
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const EXTRA = {
  palette: { d: 'M10 2.5a7.5 7.5 0 1 0 0 15c.9 0 1.4-.6 1.4-1.3 0-.9-.8-1.2-.8-2 0-.8.6-1.4 1.5-1.4h1.7a3.7 3.7 0 0 0 3.7-3.6c0-3.7-3.4-6.7-7.5-6.7ZM6.2 9.6h.01M7.8 6.3h.01M11.6 5.6h.01M14.3 8.2h.01' },
  gear: { vb: 24, d: 'm10 3-.6 2.2-1.8 1L5.4 6l-2 3.5L5 11v2l-1.6 1.5 2 3.5 2.2-.2 1.8 1L10 21h4l.6-2.2 1.8-1 2.2.2 2-3.5L19 13v-2l1.6-1.5-2-3.5-2.2.2-1.8-1L14 3ZM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z' },
  grid: { vb: 24, d: 'M4.7 3.5h3.6a1.2 1.2 0 0 1 1.2 1.2v3.6a1.2 1.2 0 0 1-1.2 1.2H4.7a1.2 1.2 0 0 1-1.2-1.2V4.7a1.2 1.2 0 0 1 1.2-1.2Zm11 0h3.6a1.2 1.2 0 0 1 1.2 1.2v3.6a1.2 1.2 0 0 1-1.2 1.2h-3.6a1.2 1.2 0 0 1-1.2-1.2V4.7a1.2 1.2 0 0 1 1.2-1.2Zm-11 11h3.6a1.2 1.2 0 0 1 1.2 1.2v3.6a1.2 1.2 0 0 1-1.2 1.2H4.7a1.2 1.2 0 0 1-1.2-1.2v-3.6a1.2 1.2 0 0 1 1.2-1.2Zm11 0h3.6a1.2 1.2 0 0 1 1.2 1.2v3.6a1.2 1.2 0 0 1-1.2 1.2h-3.6a1.2 1.2 0 0 1-1.2-1.2v-3.6a1.2 1.2 0 0 1 1.2-1.2Z' },
  list: { vb: 24, d: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01' },
  sun: { vb: 24, d: 'M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5' },
  moon: { vb: 24, d: 'M20 15.5A8.5 8.5 0 0 1 8.5 4a8.5 8.5 0 1 0 11.5 11.5Z' },
  panel: { d: 'M3 4h14v12H3ZM8 4v12' },
  pin: { d: 'M7.5 2.5h5l-.8 4.8 2.8 2.9h-9l2.8-2.9ZM10 10.2V17' },
  minimize: { d: 'M5 10h10' },
  maximize: { d: 'M5 5h10v10H5Z' },
  feedback: { d: 'M3 4h14v9.5H8.5L5 16.5v-3H3ZM7 8.5h6' },
  brain: { d: 'M8 3.5A2.5 2.5 0 0 0 5.5 6a2.6 2.6 0 0 0-2 2.5c0 .9.4 1.6 1 2.1a2.6 2.6 0 0 0 1.2 4.3A2.5 2.5 0 0 0 10 15.5V5a1.5 1.5 0 0 0-2-1.5Zm4 0A2.5 2.5 0 0 1 14.5 6a2.6 2.6 0 0 1 2 2.5c0 .9-.4 1.6-1 2.1a2.6 2.6 0 0 1-1.2 4.3A2.5 2.5 0 0 1 10 15.5' },
  attach: { d: 'm15.5 9.5-5.8 5.8a3.3 3.3 0 0 1-4.7-4.7l6-6a2.2 2.2 0 0 1 3.1 3.1l-5.9 5.9a1.1 1.1 0 0 1-1.6-1.6L12 7.6' },
  send: { d: 'M10 16V4m-5 5 5-5 5 5' },
  ext: { d: 'M8 4h8v8M16 4 5 15' },
  info: { d: 'M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0ZM10 9v4.5M10 6.5h.01' },
}
function icon(name, cls = '') {
  const e = EXTRA[name], vb = e?.vb || 20, d = e?.d || ICONS[name] || ''
  return `<svg class="ic ${cls}" data-i="${name}" viewBox="0 0 ${vb} ${vb}"${vb === 24 ? ' style="stroke-width:1.65"' : ''} aria-hidden="true"><path d="${d}"/></svg>`
}
const CHECK = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m4.5 10.5 3.5 3.5 7.5-8"/></svg>'
const ib = (i, label, act, cls = '', extra = '') => `<button type="button" class="icon-btn ${cls}" data-act="${act}" aria-label="${esc(label)}" data-tip="${esc(label)}" ${extra}>${icon(i)}</button>`
const asyncBtn = (act, ic, idle, done, cls = 'primary') => `<button type="button" class="btn ${cls} async" data-act="${act}" data-state="idle"><span class="ai"><span class="a-idle">${icon(ic)}</span><span class="a-busy"><span class="spin"></span></span><span class="a-done">${CHECK}</span></span><span class="labels"><span class="l-idle">${idle}</span><span class="l-done">${done}</span></span></button>`
const asyncIcon = (act, ic, label) => `<button type="button" class="icon-btn async" data-act="${act}" data-state="idle" aria-label="${label}" data-tip="${label}"><span class="ai"><span class="a-idle">${icon(ic)}</span><span class="a-busy"><span class="spin"></span></span><span class="a-done">${CHECK}</span></span></button>`

const EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh', 'max']
const PAGES = [['appearance', '外观'], ['prompt', '提示词'], ['model', '模型'], ['cpa', 'CPA'], ['tools', '工具'], ['plugins', '插件'], ['feedback', '框架改进建议']]
const TITLE = Object.fromEntries(PAGES)
const sid = n => `2026-11-0${6 - Math.min(5, Math.floor(n / 3))}T0${n % 10}-${String(10 + n * 3).slice(-2)}-05Z-DESKTOP-K949CVC-${(n * 7919).toString(36).slice(-6)}`
const S = {
  style: 'new', preset: 'slate', mode: 'dark', radius: null, border: null, transparency: null, motion: 'full', ov: {},
  view: 'settings', sub: '', follow: '固定夜间', current: 's1', running: 's2', fast: false, quota: 54,
  // draft composition, mirrors ModelSettings draft: API order/enabled + per-capability model + params
  model: {
    order: [{ id: 'a', on: true }, { id: 'd', on: true }],
    model: 'claude-opus-5-5', effort: 'high', maxTokens: '', imgModel: 'gpt-image-2.5-sunburst', searchModel: 'gpt-6.1-sol', exa: true,
    p: { main: { timeout: '', idle: '' }, image: { timeout: '' }, search: { context: '', tokens: '', timeout: '', toolType: '', exaUrl: '', exaTool: '', exaTimeout: '' } },
  },
  applied: '',
  apis: [
    { id: 'a', name: '连接 A', url: 'http://117.89.250.136:8317', proto: ['OpenAI', 'Anthropic'], models: ['claude-haiku-5-5', 'claude-opus-5-5', 'gpt-6-astra', 'gpt-6.1-sol', 'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst'] },
    { id: 'd', name: 'deepseek', url: 'https://api.deepseek.com/anthropic', proto: ['Anthropic'], models: ['deepseek-flash'] },
  ],
  sessions: [
    ['今天', '未命名会话', '14:25'], ['今天', 'Claude 自建客户端隐私与封号风险', '14:02'], ['今天', '微信小程序启动与扫码体验', '11:40'], ['今天', '重启海西数据共享平台并预览效果', '09:12'],
    ['昨天', '将系统时区改为美国时间', '昨天 18:30'], ['昨天', '用HTML画鹈鹕骑单车并在浏览器打开', '昨天 15:02'], ['昨天', '问候与模型身份询问', '昨天 10:45'],
    ['更早', '中文问候与助手介绍', '11-03'], ['更早', '生成三张不同姿态蓝猫图', '11-02'], ['更早', '查询 Grok Bot 对 Opus 5.5 的支持及额度', '11-01'], ['更早', '统计CPA近一天成功对话IP次数及归属地', '10-31'],
    ['更早', '在指定目录搭建 Osmium 三语 WordPress 站点', '10-30'], ['更早', '配置Windows远程控制', '10-29'], ['更早', 'neoctl 会话即时暂停恢复与中断提示', '10-28'],
  ].map(([g, t, time], i) => ({ id: 's' + (i + 1), g, t, time, sid: sid(i + 1) })),
  tools: ['expose_downloads', 'expose_videos', 'file_edit', 'file_list', 'file_read', 'file_search', 'file_write', 'framework_feedback', 'image_create', 'image_inspect', 'plan_update', 'revoke_videos', 'subagent_get', 'subagent_list', 'subagent_message', 'subagent_output', 'subagent_resume', 'subagent_run', 'subagent_stop', 'terminal_control', 'terminal_run', 'web_search']
    .map(name => ({ name, src: name === 'expose_downloads' ? '下载分享' : /videos/.test(name) ? '视频分享' : '内置工具', on: !['subagent_resume', 'subagent_stop'].includes(name) })),
  plugins: [{ id: 'downloads', name: '下载分享', tools: 1, on: true }, { id: 'video-share', name: '视频分享', tools: 2, on: true }, { id: 'xhs-artifact', name: '小红书图文', tools: 2, on: false }],
  feedback: [
    { id: 'f1', t: '工具截断未按显式预算', b: 'file_read 指定 maxResultChars 后仍按默认预算截断。' },
    { id: 'f2', t: 'PowerShell 读写中文文件编码丢失', b: 'Get-Content / Set-Content 往返后 UTF-8 中文出现乱码。' },
    { id: 'f3', t: 'npm 发布后元数据延迟可见', b: '发布成功后约 2 分钟内查询返回 404，容易误判失败。' },
  ],
}
S.applied = JSON.stringify(S.model)
const OPTS = {
  effort: () => EFFORTS,
  follow: () => ['跟随系统', '固定日间', '固定夜间'],
}
// image / search may be switched off ('' in the draft, shown as 关闭 like the source options)
const OFFABLE = /^(imgModel|searchModel)$/
const getVal = k => k === 'follow' ? S.follow : OFFABLE.test(k) ? S.model[k] || '关闭' : S.model[k]
const setVal = (k, v) => { if (k === 'follow') S.follow = v; else S.model[k] = OFFABLE.test(k) && v === '关闭' ? '' : v }
const reduced = () => S.motion === 'reduce' || matchMedia('(prefers-reduced-motion: reduce)').matches
const instant = () => S.style === 'legacy' || reduced()
const dirty = () => JSON.stringify(S.model) !== S.applied
// number of pending edits in the model draft (order slots + each field), drives the change dock badge
function modelDiff() {
  if (!dirty()) return 0
  const a = JSON.parse(S.applied), m = S.model; let n = 0
  const len = Math.max(a.order.length, m.order.length)
  for (let i = 0; i < len; i++) { const x = a.order[i], y = m.order[i]; if (!x || !y || x.id !== y.id || x.on !== y.on) n++ }
  for (const k of ['model', 'effort', 'maxTokens', 'imgModel', 'searchModel', 'exa']) if (a[k] !== m[k]) n++
  for (const g in m.p) for (const k in m.p[g]) if ((a.p?.[g]?.[k] ?? '') !== m.p[g][k]) n++
  return Math.max(n, 1)
}
// change dock: badge count rolls up/down, dock lifts while anything is pending
const pendTag = (txt, n) => `<span class="pending dirty-only"><span class="pend-n mono"><b>${n || ''}</b></span><span class="pend-t">${txt}</span></span>`
function setFoot(f, n) {
  if (!f) return
  f.dataset.dirty = n > 0
  const b = f.querySelector('.pend-n b'); if (!b || !n) return
  const prev = +b.textContent || 0; if (n === prev) return
  b.textContent = n
  if (prev && !instant()) b.animate([{ transform: `translateY(${n > prev ? 80 : -80}%)`, opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 300, easing: 'cubic-bezier(.16,1,.3,1)' })
}

// ===== appearance: the real compiler (appearance-tokens.mjs) drives every colour =====
let appliedKeys = []
function scheme() {
  const p = APPEARANCE_PRESETS.find(x => x.id === S.preset), s = { ...p[S.mode], ...S.ov[p.id]?.[S.mode] }
  if (S.radius != null) s.radius = S.radius
  if (S.border != null) s.borderWidth = S.border
  if (p.material && S.transparency != null) s.windowTransparency = S.transparency
  return { p, s: normalizeScheme(s) }
}
function applyAppearance() {
  const { p, s } = scheme(), vars = appearanceTokens(s, S.mode)
  for (const k of appliedKeys) root.style.removeProperty(k)
  appliedKeys = Object.keys(vars)
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v)
  root.dataset.theme = S.mode
  root.dataset.glass = p.material && (s.windowTransparency ?? 0) > 0 ? 'on' : 'off'
  root.dataset.style = S.style
  root.dataset.motion = S.motion
  syncProto()
}

// ===== motion primitives =====
function vt(update, { type = 'nav', dir = 'fade', from, x, y, force = false } = {}) {
  closeMenus()
  const can = 'startViewTransition' in document && (force || S.style === 'new') && !reduced()
  if (!can) { update(); if (type === 'nav' && S.style === 'new' && !reduced()) { const v = $('#view'); v.classList.remove('entering'); void v.offsetWidth; v.classList.add('entering') } return }
  root.dataset.vt = type; root.dataset.dir = dir
  if (x != null) {
    root.style.setProperty('--rx', x + 'px'); root.style.setProperty('--ry', y + 'px')
    root.style.setProperty('--rr', Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y)) + 'px')
  }
  if (from) from.style.viewTransitionName = 'page-title'
  const t = document.startViewTransition(() => { if (from) from.style.viewTransitionName = ''; update() })
  t.finished.finally(() => { delete root.dataset.vt; delete root.dataset.dir; $$('.tile-title').forEach(n => n.style.viewTransitionName = '') })
}
function flip(container, mutate) {
  const before = new Map([...container.children].map(n => [n, n.getBoundingClientRect()]))
  mutate()
  if (instant()) return
  for (const n of container.children) {
    const a = before.get(n); if (!a) continue
    const b = n.getBoundingClientRect(), dx = a.left - b.left, dy = a.top - b.top
    if (dx || dy) n.animate([{ translate: `${dx}px ${dy}px` }, { translate: '0 0' }], { duration: 380, easing: 'cubic-bezier(.16,1,.3,1)' })
  }
}
function morph(box, html) {
  if (instant()) { box.innerHTML = html; return }
  const h0 = box.getBoundingClientRect().height
  box.innerHTML = html
  const h1 = box.getBoundingClientRect().height
  box.style.overflow = 'hidden'
  box.animate([{ height: h0 + 'px' }, { height: h1 + 'px' }], { duration: 360, easing: 'cubic-bezier(.16,1,.3,1)' }).onfinish = () => { box.style.overflow = '' }
  box.firstElementChild?.animate([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: 320, delay: 60, easing: 'cubic-bezier(.16,1,.3,1)', fill: 'backwards' })
}
function collapse(cl, after) {
  let done = false
  const finish = () => { if (done) return; done = true; cl.remove(); after?.() }
  if (instant()) return finish()
  cl.classList.add('gone')
  cl.addEventListener('transitionend', e => { if (e.propertyName === 'grid-template-rows') finish() })
  setTimeout(finish, 600)
}
function tween(el, from, to, fmt, ms = 800) {
  if (!el) return
  if (instant()) { el.textContent = fmt(to); return }
  const t0 = performance.now()
  const step = now => { const k = Math.min(1, (now - t0) / ms), e = 1 - (1 - k) ** 4; el.textContent = fmt(from + (to - from) * e); if (k < 1) requestAnimationFrame(step) }
  requestAnimationFrame(step)
}
function placeSeg(seg, animate = true) {
  const b = seg.querySelector('[aria-pressed="true"]'), ind = seg.querySelector('.seg-ind')
  if (!b || !ind) return
  if (!animate) ind.style.transition = 'none'
  ind.style.setProperty('--x', b.offsetLeft - 3 + 'px'); ind.style.setProperty('--w', b.offsetWidth + 'px')
  ind.style.left = '3px'
  if (!animate) { void ind.offsetWidth; ind.style.transition = '' }
}
async function runAsync(btn, ms = 900) {
  if (!btn || btn.dataset.state !== 'idle') return false
  btn.dataset.state = 'busy'; await sleep(ms)
  btn.dataset.state = 'done'; setTimeout(() => { btn.dataset.state = 'idle' }, 1600)
  return true
}

// ===== toast / dialogs / tooltip =====
function toast(text, ic = 'check') {
  const st = $('#toasts'), t = document.createElement('div')
  t.className = 'toast'; t.setAttribute('role', 'status')
  t.innerHTML = `${icon(ic)}<span>${esc(text)}</span><i class="life"></i>`
  const dismiss = () => {
    if (t.classList.contains('leaving')) return
    t.classList.add('leaving')
    setTimeout(() => flip(st, () => t.remove()), instant() ? 0 : 200)
  }
  flip(st, () => st.append(t))
  t.querySelector('.life').addEventListener('animationend', dismiss)
  t.addEventListener('click', dismiss)
  if (S.style === 'legacy') setTimeout(dismiss, 3200)
  while (st.children.length > 4) st.firstElementChild.remove()
}
function openDialog(html, { role = 'dialog', cls = '' } = {}) {
  closeMenus()
  const back = document.createElement('div')
  back.className = 'backdrop'
  back._ret = document.activeElement
  back.innerHTML = `<section class="dialog ${cls}" role="${role}" aria-modal="true">${html}</section>`
  back.addEventListener('mousedown', e => { if (e.target === back) closeDialog(back) })
  $('#layer').append(back)
  setTimeout(() => back.querySelector('input:not([type=checkbox]), .btn.primary, .btn.danger')?.focus({ preventScroll: true }), 30)
  return back
}
function closeDialog(back, value = false) {
  if (!back || back.classList.contains('leaving')) return
  back._resolve?.(value)
  back.classList.add('leaving')
  if (back._ret?.isConnected) back._ret.focus({ preventScroll: true })
  setTimeout(() => back.remove(), instant() ? 0 : 160)
}
function confirmDlg(title, text, ok = '删除') {
  return new Promise(res => {
    const back = openDialog(`<div class="cfm"><span class="cfm-ic">${icon('trash')}</span><div><h3>${esc(title)}</h3>${text ? `<p>${esc(text)}</p>` : ''}</div></div><footer class="dlg-foot"><span class="spacer"></span><button type="button" class="btn" data-act="cfm-no">取消</button><button type="button" class="btn danger" data-act="cfm-ok">${icon('trash')}${ok}</button></footer>`, { role: 'alertdialog', cls: 'narrow' })
    back._resolve = res
  })
}
let tipTimer = 0, tipFor = null
function showTip(el) {
  const tip = $('#tip'), r = el.getBoundingClientRect()
  tip.textContent = el.dataset.tip
  const w = tip.offsetWidth, h = tip.offsetHeight
  let x = Math.round(r.left + r.width / 2 - w / 2), y = Math.round(r.top - h - 8)
  if (y < 50) y = Math.round(r.bottom + 8)
  x = Math.max(8, Math.min(innerWidth - w - 8, x))
  tip.style.setProperty('--tx', x + 'px'); tip.style.setProperty('--ty', y + 'px')
  tip.classList.add('show')
}
function hideTip() { clearTimeout(tipTimer); tipFor = null; $('#tip').classList.remove('show') }

// ===== menus =====
function closeMenus(except) {
  for (const sel of $$('.sel.open')) if (sel !== except) closeSel(sel)
  const m = $('.app-menu'); if (m) closeAppMenu()
  closePal()
}
function closeSel(sel) {
  sel.classList.remove('open')
  sel.querySelector('.sel-trigger')?.setAttribute('aria-expanded', 'false')
  const m = sel.querySelector('.sel-menu'); if (!m) return
  m.classList.add('leaving'); setTimeout(() => m.remove(), instant() ? 0 : 130)
}
function openSel(sel) {
  if (sel.classList.contains('open')) return closeSel(sel)
  closeMenus(sel)
  const key = sel.dataset.key, val = getVal(key), m = document.createElement('div')
  m.className = 'sel-menu'; m.setAttribute('role', 'listbox')
  m.innerHTML = '<span class="sel-hl"></span>' + OPTS[key]().map(o => `<button type="button" class="sel-opt" role="option" data-act="opt" data-v="${esc(o)}" aria-selected="${o === val}"><span>${esc(o)}</span>${o === val ? icon('check') : ''}</button>`).join('')
  sel.append(m); sel.classList.add('open')
  sel.querySelector('.sel-trigger').setAttribute('aria-expanded', 'true')
  const cur = m.querySelector('[aria-selected="true"]') || m.querySelector('.sel-opt')
  const hl = m.querySelector('.sel-hl'); hl.style.transition = 'none'; m.style.setProperty('--y', cur.offsetTop + 'px'); void hl.offsetWidth; hl.style.transition = ''
  m.addEventListener('pointerover', e => { const o = e.target.closest('.sel-opt'); if (o) m.style.setProperty('--y', o.offsetTop + 'px') })
}
function swapValue(sel, v) {
  const box = sel.querySelector('.sel-value'), old = box.firstElementChild, n = document.createElement('span')
  n.textContent = v
  if (instant() || !old) { box.replaceChildren(n); return }
  old.className = 'v-out'; n.className = 'v-in'
  old.addEventListener('animationend', () => old.remove(), { once: true })
  box.append(n)
}
function closeAppMenu() {
  const m = $('.app-menu'); if (!m) return
  $('.app-trigger')?.setAttribute('aria-expanded', 'false')
  m.classList.add('leaving'); setTimeout(() => m.remove(), instant() ? 0 : 130)
}
