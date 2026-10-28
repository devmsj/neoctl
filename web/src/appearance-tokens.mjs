import { DEFAULT_COLORS, derivePalette, mix, readable, normalizeScheme } from '../shared/appearance.mjs'

// The sole translation from persisted parameters to CSS. No arbitrary CSS/URLs.
export function appearanceTokens(input, mode, assetUrl = id => `/api/appearance/assets/${id}`) {
  const s = normalizeScheme(input), base = DEFAULT_COLORS[mode], out = {}
  const set = (key, value) => { out['--appearance-' + key] = String(value) }
  const color = key => s[key] || base[key]
  const alpha = (hex, opacity) => hex + Math.round(opacity * 2.55).toString(16).padStart(2, '0')
  if (s.background) set('bg', s.background)
  if (s.panel || s.panelOpacity !== undefined) set('panel', alpha(color('panel'), s.panelOpacity ?? 100))
  if (s.surface || s.surfaceOpacity !== undefined) set('surface', alpha(color('surface'), s.surfaceOpacity ?? 100))
  if (s.text) { set('text', s.text); set('strong', readable(s.text, color('background'), 7)) }
  if (s.muted) { set('muted', s.muted); set('faint', mix(color('background'), s.muted, .8)) }
  if (s.border) { set('line', s.border); set('line-soft', mix(color('background'), s.border, .6)) }
  if (s.userBackground) set('user-bg', s.userBackground)
  if (s.userText) set('user-text', s.userText)
  if (s.codeBackground) set('code-bg', s.codeBackground)
  if (s.accent || s.background || s.panel || s.surface) {
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
  if (s.codeTheme && s.codeTheme !== 'default') {
    const dark = mode === 'dark', weight = s.codeTheme === 'soft' ? .25 : 0
    const colors = dark ? ['#d2a8ff', '#a5d6ff', '#7ee787', '#ffa657', '#ff7b72', '#9da7b3'] : ['#6639ba', '#0a3069', '#116329', '#953800', '#a40e26', '#59636e']
    for (const [i, key] of ['keyword', 'string', 'title', 'number', 'property', 'comment'].entries()) set('syntax-' + key, readable(mix(colors[i], color('codeBackground'), weight), color('codeBackground')))
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
