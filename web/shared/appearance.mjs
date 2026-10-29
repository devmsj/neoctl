// Browser/server contract. Appearance never enters a model request or transcript.
export const APPEARANCE_VERSION = 1
export const PALETTE_VERSION = 2
export const BUILTIN_PRESET_NAMES = Object.freeze({ default: '烟粉', ink: '墨青', sand: '暖砂', slate: '远山', rose: '灰玫瑰', graphite: '石墨', glass: '雾玻璃', 'amber-glass': '琥珀雾' })
export const ASSET_ID = /^[a-f0-9]{64}\.(png|jpg|webp|gif|woff2?|ttf|otf)$/
export const COLOR_KEYS = ['accent', 'background', 'text', 'muted', 'border', 'userBackground', 'userText', 'codeBackground']
export const NUMBERS = {
  uiSize: [11, 20], textSize: [12, 28], codeSize: [10, 24], textWeight: [300, 700], lineHeight: [1.3, 2.4], letterSpacing: [-.5, 2],
  paragraphSpacing: [0, 24], radius: [0, 20], borderWidth: [0, 2], messageGap: [0, 32],
  contentWidth: [380, 1600], sidebarWidth: [168, 360], informationWidth: [176, 380],
  windowTransparency: [0, 100], windowFrost: [0, 2],
  backgroundOpacity: [0, 100],
  backgroundBlur: [0, 24], backgroundBrightness: [20, 160], backgroundSaturation: [0, 160], backgroundX: [0, 100], backgroundY: [0, 100],
}
export const FONTS = ['uiFont', 'textFont', 'codeFont']
export const DEFAULT_COLORS = {
  light: { accent: '#8c456e', background: '#ffffff', panel: '#ffffff', surface: '#ffffff', text: '#20252d', muted: '#424c59', border: '#d5dae2', userBackground: '#f8f5f8', userText: '#202a36', codeBackground: '#f6f7fa' },
  dark: { accent: '#bb8ea6', background: '#111418', panel: '#15191f', surface: '#191e25', text: '#d7dce3', muted: '#9aa4b2', border: '#2b323d', userBackground: '#191e25', userText: '#e1e5eb', codeBackground: '#1c222b' },
}
export function emptyAppearance() { return { version: APPEARANCE_VERSION, mode: 'system', light: {}, dark: {}, presets: [] } }
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v))
function fail(message) { throw new Error(message) }
export function normalizeScheme(value) {
  if (!plain(value)) fail('外观方案格式无效')
  const result = {}
  for (const [key, v] of Object.entries(value)) {
    // Retired v1 overrides remain readable/importable, but can no longer affect surfaces.
    if (key === 'windowBlur') {
      // Import drafts from the short-lived CSS implementation; explicit native choice wins.
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 40) fail('磨砂数值无效')
      if (value.windowFrost === undefined) result.windowFrost = v === 0 ? 0 : 2
      continue
    } else if (key === 'panel' || key === 'surface') {
      if (typeof v !== 'string' || !/^#[\da-f]{6}$/i.test(v)) fail('颜色格式无效')
      continue
    } else if (key === 'panelOpacity' || key === 'surfaceOpacity') {
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 20 || v > 100) fail('外观数值超出范围：' + key)
      continue
    } else if (COLOR_KEYS.includes(key)) {
      if (typeof v !== 'string' || !/^#[\da-f]{6}$/i.test(v)) fail('颜色格式无效')
      result[key] = v.toLowerCase()
    } else if (NUMBERS[key]) {
      const [min, max] = NUMBERS[key]
      if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) fail('外观数值超出范围：' + key)
      if (key === 'windowFrost' && !Number.isInteger(v)) fail('磨砂档位无效')
      result[key] = key === 'windowFrost' && v > 0 ? 2 : Math.round(v * 100) / 100
    } else if (FONTS.includes(key)) {
      if (typeof v !== 'string' || v.length > 160 || /[\x00-\x1f;{}<>\\]/.test(v)) fail('字体名称无效')
      result[key] = v.trim()
    } else if (key === 'backgroundAsset' || /^(ui|text|code)FontAsset$/.test(key)) {
      if (typeof v !== 'string' || (v && !ASSET_ID.test(v))) fail('外观资源引用无效')
      if (v && (key === 'backgroundAsset' ? !/\.(png|jpg|webp|gif)$/.test(v) : !/\.(woff2?|ttf|otf)$/.test(v))) fail('外观资源类型不匹配')
      result[key] = v
    } else if (key === 'backgroundFit') {
      if (!['cover', 'contain', 'repeat'].includes(v)) fail('背景布局无效')
      result[key] = v
    } else if (key === 'backgroundScope') {
      if (!['workspace', 'chat'].includes(v)) fail('背景范围无效')
      result[key] = v
    } else if (key === 'codeTheme') {
      if (!['default', 'soft', 'contrast'].includes(v)) fail('代码主题无效')
      result[key] = v
    } else fail('未知外观字段：' + key)
  }
  return result
}
export function normalizeAppearance(value) {
  if (!plain(value)) fail('外观配置格式无效')
  // Never silently downgrade a future schema, or overwrite fields it introduced.
  if (value.version !== APPEARANCE_VERSION) fail('不支持此外观配置版本')
  if (Object.keys(value).some(k => !['version', 'mode', 'light', 'dark', 'presets'].includes(k))) fail('未知外观配置字段')
  if (!['system', 'light', 'dark'].includes(value.mode)) fail('主题模式无效')
  if (!Array.isArray(value.presets) || value.presets.length > 100) fail('主题方案列表无效')
  const names = new Set(), builtins = new Set()
  const presets = value.presets.map(p => {
    if (!plain(p) || Object.keys(p).some(k => !['name', 'light', 'dark', 'builtin'].includes(k)) || typeof p.name !== 'string' || !p.name.trim() || p.name.length > 60 || names.has(p.name.trim())) fail('主题方案名称无效或重复')
    if (p.builtin !== undefined) {
      if (typeof p.builtin !== 'string' || !Object.hasOwn(BUILTIN_PRESET_NAMES, p.builtin) || builtins.has(p.builtin) || p.name !== BUILTIN_PRESET_NAMES[p.builtin]) fail('系统外观不可改名或重复')
      builtins.add(p.builtin)
    }
    names.add(p.name.trim())
    return { name: p.name.trim(), light: normalizeScheme(p.light), dark: normalizeScheme(p.dark), ...(p.builtin ? { builtin: p.builtin } : {}) }
  })
  return { version: APPEARANCE_VERSION, mode: value.mode, light: normalizeScheme(value.light), dark: normalizeScheme(value.dark), presets }
}
export function assetReferences(config) {
  const result = new Set()
  for (const s of [config.light, config.dark, ...config.presets.flatMap(p => [p.light, p.dark])]) {
    for (const [k, v] of Object.entries(s)) if (k.endsWith('Asset') && v) result.add(v)
  }
  return [...result]
}
export function mix(a, b, weight) {
  const rgb = s => [1, 3, 5].map(i => parseInt(s.slice(i, i + 2), 16))
  const x = rgb(a), y = rgb(b)
  return '#' + x.map((v, i) => Math.round(v * (1 - weight) + y[i] * weight).toString(16).padStart(2, '0')).join('')
}
export function luminance(hex) {
  return [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0)
}
export function contrast(a, b) { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05) }
export function readable(color, background, ratio = 4.5) {
  if (contrast(color, background) >= ratio) return color
  const target = contrast('#ffffff', background) > contrast('#000000', background) ? '#ffffff' : '#000000'
  for (let i = 1; i <= 100; i++) { const next = mix(color, target, i / 100); if (contrast(next, background) >= ratio) return next }
  return target
}
export function derivePalette(accent, background) {
  const foreground = readable(accent, background)
  const soft = mix(background, accent, .14)
  return { accent: foreground, soft, hover: mix(background, accent, .2), pressed: mix(background, accent, .3), focus: readable(accent, background, 3), onSoft: readable(accent, soft), faint: mix(background, foreground, .65) }
}

// Opaque, restrained elevation steps share one background seed in each day/night scheme.
export function deriveSurfaces(background, mode) {
  return {
    panel: mix(background, '#ffffff', mode === 'dark' ? .025 : .32),
    surface: mix(background, '#ffffff', mode === 'dark' ? .055 : .48),
  }
}
