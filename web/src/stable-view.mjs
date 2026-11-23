import { computed } from 'vue'

// Columns render independently: a state sync replaces arrays/objects even when
// nothing a column shows has changed. A stable computed keeps returning the same
// object while its (JSON-serialisable) content is unchanged, so Vue neither
// re-triggers dependents nor re-renders the child component receiving it.
export function stableComputed(getter) {
  let signature
  return computed((previous) => {
    const next = getter()
    const nextSignature = JSON.stringify(next)
    if (previous !== undefined && nextSignature === signature) return previous
    signature = nextSignature
    return next
  })
}
