import { DEFAULT_COLORS, derivePalette, deriveSurfaces, mix, readable, normalizeScheme } from '../shared/appearance.mjs'

// The sole translation from persisted parameters to CSS. No arbitrary CSS/URLs.
export function appearanceTokens(input, mode, assetUrl = id => `/api/appearance/assets/${id}`) {
  const s = normalizeScheme(input), base = DEFAULT_COLORS[mode], out = {}
  const set = (key, value) => { out['--appearance-' + key] = String(value) }
  if (s.windowTransparency !== undefined) set('window-transparency', s.windowTransparency)
  if (s.windowFrost !== undefined) set('window-frost', s.windowFrost)
  const surfaces = deriveSurfaces(s.background || base.background, mode)
  const color = key => surfaces[key] || s[key] || base[key]
  if (s.background) set('bg', s.background)
  set('panel', surfaces.panel)
  set('surface', surfaces.surface)
  if (s.text) { set('text', s.text); set('strong', readable(s.text, color('background'), 7)) }
  if (s.muted) { set('muted', s.muted); set('faint', mix(color('background'), s.muted, .8)) }
  if (s.border) { set('line', s.border); set('line-soft', mix(color('background'), s.border, .6)) }
  if (s.userBackground) set('user-bg', s.userBackground)
  if (s.userText) set('user-text', s.userText)
  if (s.codeBackground) set('code-bg', s.codeBackground)
  if (s.accent || s.background) {
    // One seed; derive roles against the actual relevant surface, not arbitrary HSL offsets.
    const seed = s.accent || base.accent, palette = derivePalette(seed, color('background'))
    for (const [k, v] of Object.entries(palette)) set('accent-' + k, v)
    set('accent', readable(palette.accent, color('surface'), 3))
    // Unspecified message colors belong to the selected palette, not the legacy pink.
    const userBackground = s.userBackground || mix(color('background'), seed, mode === 'dark' ? .1 : .045)
    if (!s.userBackground) set('user-bg', userBackground)
    if (!s.userText) set('user-text', readable(color('text'), userBackground))
  }
  for (const [key, css] of Object.entries({ uiSize: 'ui-size', textSize: 'text-size', codeSize: 'code-size', radius: 'radius', borderWidth: 'border-width', messageGap: 'message-gap', contentWidth: 'content-width', sidebarWidth: 'sidebar-width', informationWidth: 'information-width', letterSpacing: 'letter-spacing', paragraphSpacing: 'paragraph-spacing' })) {
    if (s[key] !== undefined) set(css, s[key] + 'px')
  }
  if (s.uiSize !== undefined) set('ui-scale', s.uiSize / 13)
  if (s.lineHeight !== undefined) set('line-height', s.lineHeight)
  if (s.textWeight !== undefined) set('text-weight', s.textWeight)
  for (const role of ['ui', 'text', 'code']) {
    const fallback = role === 'code' ? 'ui-monospace, Consolas, monospace' : 'system-ui, "Microsoft YaHei", sans-serif'
    if (s[role + 'FontAsset']) set(role + '-font', `"neo-${s[role + 'FontAsset'].split('.')[0]}", ${fallback}`)
    else if (s[role + 'Font']) set(role + '-font', s[role + 'Font'].split(',').map(x => JSON.stringify(x.trim().replace(/^["']|["']$/g, ''))).join(',') + ', ' + fallback)
  }
  if (s.codeTheme || s.accent || s.background || s.codeBackground || s.text) {
    const seed = color('accent'), dark = mode === 'dark'
    const background = s.codeBackground || mix(color('background'), seed, dark ? .09 : .055)
    const foreground = readable(color('text'), background, 7)
    set('code-bg', background); set('code-text', foreground)
    set('table-head-bg', mix(color('background'), seed, dark ? .15 : .10))
    set('table-head-text', readable(seed, mix(color('background'), seed, dark ? .15 : .10), 4.5))
    // Persisted values remain compatible: soft is monochrome, contrast is spectral.
    const spectral = dark ? ['#e5a2ff','#a2df83','#77d3f5','#ffcb70','#ff94ae','#a5b1c3'] : ['#8427b0','#236b21','#075eaa','#9a4a00','#ac2451','#586573']
    const following = ['#9654b4','#238865','#327ab6','#b16c24','#b54d7e',color('muted')]
    const keys = ['keyword', 'string', 'title', 'number', 'property', 'comment']
    for (const [i, key] of keys.entries()) {
      const value = s.codeTheme === 'contrast' ? spectral[i]
        : s.codeTheme === 'soft' ? mix(foreground, seed, i === 5 ? .65 : .28)
        : mix(seed, following[i], i === 5 ? .75 : .35)
      set('syntax-' + key, readable(value, background, 4.5))
    }
  }
  if (s.backgroundAsset) {
    set('background-image', `url(${JSON.stringify(assetUrl(s.backgroundAsset))})`)
    set('background-size', s.backgroundFit === 'repeat' ? 'auto' : s.backgroundFit || 'cover')
    set('background-repeat', s.backgroundFit === 'repeat' ? 'repeat' : 'no-repeat')
    set('background-position', `${s.backgroundX ?? 50}% ${s.backgroundY ?? 50}%`)
    set('background-opacity', (s.backgroundOpacity ?? 25) / 100)
    set('background-filter', `blur(${s.backgroundBlur ?? 0}px) brightness(${(s.backgroundBrightness ?? 100) / 100}) saturate(${(s.backgroundSaturation ?? 100) / 100})`)
  }
  return out
}
