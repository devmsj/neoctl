import { normalizeAppearance, BUILTIN_PRESET_NAMES } from '../shared/appearance.mjs'
import { authStorageSuffix } from './auth-state.mjs'

// Separate from the applied theme/cache. Refresh or native close must not lose
// edits, and must never silently apply an unfinished preview.
export function appearanceDraftStore(storage = localStorage) {
  const key = 'neoctl-web.appearance-draft.v1' + authStorageSuffix()
  return {
    read() {
      try {
        const value = JSON.parse(storage.getItem(key))
        if (!value || typeof value.revision !== 'string' || !['light', 'dark'].includes(value.editing)) return null
        const result = { config: normalizeAppearance(value.config), revision: value.revision, editing: value.editing }
        if (value.design && typeof value.design.name === 'string' && value.design.name.length <= 60 && typeof value.design.originalName === 'string' && value.design.originalName.length <= 60 && typeof value.design.baseline === 'string') {
          const baseline = value.design.baseline ? JSON.parse(value.design.baseline) : null
          if (baseline && (typeof baseline.name !== 'string' || !baseline.light || !baseline.dark)) return null
          if (value.design.builtinId && !Object.hasOwn(BUILTIN_PRESET_NAMES, value.design.builtinId)) return null
          result.design = { ...(value.design.builtinId ? { builtinId: value.design.builtinId } : {}), name: value.design.name, originalName: value.design.originalName, baseline: value.design.baseline }
        }
        return result
      } catch { return null }
    },
    write(config, revision, editing, design) {
      try { storage.setItem(key, JSON.stringify({ config: normalizeAppearance(config), revision, editing, ...(design ? { design } : {}) })); return true } catch { return false }
    },
    clear() { try { storage.removeItem(key) } catch {} },
  }
}
