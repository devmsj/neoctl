import { normalizeScheme } from '../shared/appearance.mjs'

// A data-only catalogue: append a record to add a card. Both day/night schemes
// are complete replacements; old images/fonts/materials never leak into a preset.
export const APPEARANCE_PRESETS = [
  { id: 'default', name: '烟粉', light: {}, dark: {} },
  { id: 'ink', name: '墨青', light: { background: '#eef4f1', accent: '#317c70', codeTheme: 'soft' }, dark: { background: '#111b19', accent: '#80b7a6', codeTheme: 'soft' } },
  { id: 'sand', name: '暖砂', light: { background: '#f5f0e7', accent: '#956c48', codeTheme: 'soft' }, dark: { background: '#211c17', accent: '#c6a67b', codeTheme: 'soft' } },
  { id: 'slate', name: '远山', light: { background: '#edf1f7', accent: '#526e9b', codeTheme: 'contrast' }, dark: { background: '#151c29', accent: '#91acd4', codeTheme: 'contrast' } },
  { id: 'rose', name: '灰玫瑰', light: { background: '#f5eef0', accent: '#966878', codeTheme: 'soft' }, dark: { background: '#231c22', accent: '#c79bab', codeTheme: 'soft' } },
  { id: 'graphite', name: '石墨', light: { background: '#f0f1f1', accent: '#596975', codeTheme: 'contrast', radius: 3 }, dark: { background: '#17191c', accent: '#a6b6c3', codeTheme: 'contrast', radius: 3 } },
  { id: 'glass', name: '雾玻璃', material: true, light: { background: '#eaf0f2', accent: '#557d88', windowTransparency: 68, windowFrost: 2, radius: 8 }, dark: { background: '#171f24', accent: '#8fb7c1', windowTransparency: 55, windowFrost: 2, radius: 8 } },
  { id: 'amber-glass', name: '琥珀雾', material: true, light: { background: '#f4ede2', accent: '#987048', windowTransparency: 58, windowFrost: 2, radius: 8 }, dark: { background: '#241d18', accent: '#cfab7c', windowTransparency: 46, windowFrost: 2, radius: 8 } },
]
const signature = scheme => JSON.stringify(Object.entries(normalizeScheme(scheme)).sort(([a], [b]) => a.localeCompare(b)))
export function matchesAppearancePreset(config, preset) {
  // Invalid in-progress edits must remain recoverable, not break gallery rendering.
  try { return signature(config.light) === signature(preset.light) && signature(config.dark) === signature(preset.dark) }
  catch { return false }
}
export function availableAppearancePresets(saved = [], desktop = false) {
  const builtins = APPEARANCE_PRESETS.filter(p => desktop || !p.material).map(p => {
    const override = saved.find(s => s.builtin === p.id)
    return { ...p, ...(override ? { light: override.light, dark: override.dark } : {}), key: 'builtin:' + p.id, modified: !!override }
  }).sort((a, b) => desktop
    ? Number(!!b.material) - Number(!!a.material)
    : Number(b.id === 'slate') - Number(a.id === 'slate'))
  return [...builtins, ...saved.filter(p => !p.builtin).map(p => ({ ...p, key: 'saved:' + p.name, saved: true, material: !!(p.light.windowFrost || p.dark.windowFrost) }))]
}

// Only genuinely unconfigured clients receive a platform default. Never overwrite
// a saved explicit empty scheme (revision > 0), or an existing user's design.
export function withDefaultAppearance(config, revision, desktop) {
  if (revision !== '0' || Object.keys(config.light).length || Object.keys(config.dark).length || config.presets.length) return config
  const preset = APPEARANCE_PRESETS.find(p => p.id === (desktop ? 'glass' : 'slate'))
  return { ...config, light: { ...preset.light }, dark: { ...preset.dark } }
}
