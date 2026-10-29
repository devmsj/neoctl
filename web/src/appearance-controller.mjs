import { reactive } from 'vue'
import { appFetch, appUrl } from './app-url.mjs'
import { authStorageSuffix } from './auth-state.mjs'
import { emptyAppearance, normalizeAppearance, assetReferences } from '../shared/appearance.mjs'
import { withDefaultAppearance } from './appearance-presets.mjs'
import { isDesktop } from './local-resources.mjs'
import { appearanceTokens } from './appearance-tokens.mjs'

const clone = value => JSON.parse(JSON.stringify(value))
export function createAppearanceController({ onTheme, onLayout, notify = () => {} }) {
  const key = 'neoctl-web.appearance.v1' + authStorageSuffix()
  const state = reactive({ config: withDefaultAppearance(emptyAppearance(), '0', isDesktop()), revision: '0', loaded: false, loading: false, error: '', previewing: false })
  let disposed = false, requestId = 0, preview, previewMode, frame = 0, layoutTimer = 0, keys = [], loadPromise, savePromise
  let fontEpoch = 0, lastFonts = '', lastLayout = ''
  const fontFaces = new Map(), media = matchMedia('(prefers-color-scheme: dark)')
  const modeOf = config => config.mode === 'system' ? (document.documentElement.dataset.neoSystemTheme || (media.matches ? 'dark' : 'light')) : config.mode
  const assetUrl = id => appUrl('/api/appearance/assets/' + id)
  function cache() { try { localStorage.setItem(key, JSON.stringify({ config: state.config, revision: state.revision })) } catch {} }
  function layout() { clearTimeout(layoutTimer); layoutTimer = setTimeout(() => { if (!disposed) onLayout?.() }, 100) }
  async function fonts(scheme) {
    const ids = [...new Set(['ui', 'text', 'code'].map(role => scheme[role + 'FontAsset']).filter(Boolean))]
    const signature = ids.join(',')
    if (signature === lastFonts) return
    lastFonts = signature; const epoch = ++fontEpoch
    for (const [id, face] of fontFaces) if (!ids.includes(id)) { document.fonts.delete(face); fontFaces.delete(id) }
    await Promise.all(ids.map(async id => {
      if (fontFaces.has(id)) return
      try {
        const face = new FontFace('neo-' + id.split('.')[0], `url(${JSON.stringify(assetUrl(id))})`, { display: 'swap' })
        await face.load()
        if (disposed || epoch !== fontEpoch) return
        document.fonts.add(face); fontFaces.set(id, face)
      } catch { if (!disposed && epoch === fontEpoch) notify('字体无法加载，已使用备用字体') }
    }))
    if (!disposed && epoch === fontEpoch) layout()
  }
  function paint() {
    frame = 0
    if (disposed) return
    const config = preview || state.config, mode = previewMode || modeOf(config), scheme = config[mode]
    onTheme(mode)
    const root = document.documentElement, tokens = appearanceTokens(scheme, mode, assetUrl)
    if (scheme.sidebarWidth) tokens['--appearance-navigation-track'] = `clamp(168px, ${scheme.sidebarWidth}px, 27vw)`
    if (scheme.informationWidth) tokens['--appearance-information-track'] = `clamp(176px, ${scheme.informationWidth}px, 29vw)`
    for (const k of keys) if (!(k in tokens)) root.style.removeProperty(k)
    for (const [k, v] of Object.entries(tokens)) if (root.style.getPropertyValue(k) !== v) root.style.setProperty(k, v)
    keys = Object.keys(tokens)
    if (scheme.backgroundAsset) root.dataset.appearanceBackground = scheme.backgroundScope || 'workspace'
    else delete root.dataset.appearanceBackground
    root.dataset.appearance = 'ready'
    root.dataset.appearanceMode = state.config.mode
    void fonts(scheme)
    const signature = JSON.stringify(Object.fromEntries(Object.entries(tokens).filter(([k]) => /font|size|width|gap|spacing|height|scale|weight/.test(k))))
    if (signature !== lastLayout) { lastLayout = signature; layout() }
  }
  const schedule = () => { if (!frame && !disposed) frame = requestAnimationFrame(paint) }
  function restoreCache() {
    try {
      const saved = JSON.parse(localStorage.getItem(key))
      if (saved?.config) { state.config = withDefaultAppearance(normalizeAppearance(saved.config), saved.revision, isDesktop()); state.revision = typeof saved.revision === 'string' ? saved.revision : '0' }
      else if (!authStorageSuffix()) { const old = localStorage.getItem('neoctl-web.theme'); if (['light', 'dark'].includes(old)) state.config.mode = old }
    } catch {}
    paint()
  }
  async function load(force = false) {
    if (savePromise) { try { await savePromise } catch {} }
    if (disposed) return false
    if (loadPromise && !force) return loadPromise
    const request = ++requestId
    state.loading = true; state.error = ''
    const work = (async () => {
      try {
        const res = await appFetch('/api/appearance'), body = await res.json()
        if (!res.ok) throw new Error(body.error || '外观加载失败')
        // Old servers/fixtures may not expose the appearance endpoint yet.
        if (!body.config || typeof body.revision !== 'string') throw new Error('当前服务尚不支持外观配置')
        const config = withDefaultAppearance(normalizeAppearance(body.config), body.revision, isDesktop())
        if (disposed || request !== requestId) return false
        // One-time migration of the previous local light/dark choice. Save with CAS.
        if (body.revision === '0' && config.mode === 'system' && !authStorageSuffix() && state.config.mode !== 'system') config.mode = state.config.mode
        state.config = config; state.revision = body.revision; state.loaded = true; cache(); schedule(); return true
      } catch (e) { if (!disposed && request === requestId) state.error = e.message; return false }
      finally { if (request === requestId) { state.loading = false; loadPromise = undefined } }
    })()
    loadPromise = work
    return work
  }
  async function save(value) {
    if (savePromise) throw new Error('外观正在保存')
    if (!state.loaded) throw new Error('请先重新载入外观配置')
    const config = normalizeAppearance(value), revision = state.revision
    // Invalidate reads started before this write. Reads started during the write
    // wait for it, so a late GET cannot replace a successfully saved revision.
    ++requestId; loadPromise = undefined; state.loading = false
    const work = (async () => {
      const res = await appFetch('/api/appearance', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ config, revision }) })
      const body = await res.json()
      if (!res.ok) throw Object.assign(new Error(body.error || '外观保存失败'), { status: res.status })
      if (disposed) return
      state.config = normalizeAppearance(body.config); state.revision = body.revision; state.error = ''
      preview = undefined; previewMode = undefined; state.previewing = false; cache(); schedule()
    })()
    savePromise = work
    try { return await work } finally { if (savePromise === work) savePromise = undefined }
  }
  async function setMode(mode) {
    if (!['light', 'dark', 'system'].includes(mode)) return
    if (state.previewing) { notify('请先完成或退出外观设计'); return }
    if (state.config.mode === mode) return
    const config = clone(state.config); config.mode = mode
    if (!state.loaded) { state.config = config; cache(); paint(); return }
    try { await save(config) } catch (e) { notify(e.message) }
  }
  function storage(event) {
    if (event.key !== key || state.previewing) return
    void load(true)
  }
  restoreCache()
  window.addEventListener('neo:system-theme', schedule); media.addEventListener('change', schedule); window.addEventListener('storage', storage)
  return {
    state, load, save, assetUrl, setMode, quickToggle: () => setMode({ light: 'dark', dark: 'system', system: 'light' }[state.config.mode]), currentMode: () => modeOf(state.config),
    preview(value, mode) { preview = normalizeAppearance(value); previewMode = mode; state.previewing = true; schedule() },
    cancel() { preview = undefined; previewMode = undefined; state.previewing = false; schedule() },
    async upload(file, kind) {
      // Decode on the browser before accepting into the UI; server independently verifies bytes.
      if (kind === 'background') {
        const url = URL.createObjectURL(file)
        try { const image = new Image(); image.src = url; await image.decode() } catch { throw new Error('图片无法解码') } finally { URL.revokeObjectURL(url) }
      } else {
        const face = new FontFace('neo-validate', await file.arrayBuffer()); try { await face.load() } catch { throw new Error('字体文件无法读取') }
      }
      const res = await appFetch('/api/appearance/assets?kind=' + kind, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file })
      const body = await res.json(); if (!res.ok) throw new Error(body.error || '上传失败'); return body
    },
    async exportBundle(value) {
      const config = normalizeAppearance(value), assets = []
      for (const id of assetReferences(config)) {
        const res = await appFetch('/api/appearance/assets/' + id)
        if (!res.ok) throw new Error('主题资源读取失败')
        const data = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = reject; res.blob().then(blob => reader.readAsDataURL(blob), reject) })
        assets.push({ id, data })
      }
      return new Blob([JSON.stringify({ format: 'neo-appearance', version: 1, config, assets })], { type: 'application/json' })
    },
    async importBundle(file) {
      const bundle = JSON.parse(await file.text())
      if (bundle.format !== 'neo-appearance' || bundle.version !== 1 || !Array.isArray(bundle.assets)) throw new Error('主题文件无效')
      const config = normalizeAppearance(bundle.config), refs = assetReferences(config), map = new Map()
      // Check the whole manifest before uploading anything; missing/duplicate
      // resources must not produce a partially accepted theme.
      for (const a of bundle.assets) {
        if (!a || !refs.includes(a.id) || map.has(a.id) || typeof a.data !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(a.data)) throw new Error('主题资源无效')
        map.set(a.id, a.data)
      }
      if (refs.some(id => !map.has(id))) throw new Error('主题缺少资源')
      for (const [id, data] of map) {
        const bytes = Uint8Array.from(atob(data), x => x.charCodeAt(0)), kind = /\.(png|jpg|webp|gif)$/.test(id) ? 'background' : 'font'
        const result = await this.upload(new Blob([bytes]), kind)
        if (result.id !== id) throw new Error('主题资源校验不一致')
      }
      return config
    },
    dispose() {
      if (disposed) return
      disposed = true; ++requestId; ++fontEpoch; cancelAnimationFrame(frame); clearTimeout(layoutTimer)
      window.removeEventListener('neo:system-theme', schedule); media.removeEventListener('change', schedule); window.removeEventListener('storage', storage)
      for (const face of fontFaces.values()) document.fonts.delete(face)
      for (const k of keys) document.documentElement.style.removeProperty(k)
      delete document.documentElement.dataset.appearanceMode
      delete document.documentElement.dataset.appearanceBackground; delete document.documentElement.dataset.appearance
    },
  }
}
