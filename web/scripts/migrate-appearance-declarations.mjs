// One-off declaration migration: keep original fallback values and selector priorities.
// Re-running is idempotent. Semantic status colors, geometry and animation are excluded.
import { readdir, readFile, writeFile } from 'node:fs/promises'
import postcss from 'postcss'
const neutral = new Set(['#ffffff','#f9fafb','#f3f4f6','#1f2937','#253344','#303842','#2f353d','#374151','#3f4751','#25202f'])
const accent = new Set(['#fce7f3','#fbcfe8','#fdf2f8','#e0f2fe','#29485a','#55354a','#38bdf8','#f472b6','#f9a8d4','#db6ba5'])
let changed = 0
async function migrate(file) {
  let text = await readFile(file, 'utf8')
  if (file.endsWith('AuthGate.vue') || file.endsWith('appearance.css')) return
  function css(source) {
    const root = postcss.parse(source)
    root.walkDecls(d => {
      if (d.value.includes('--appearance-')) return
      const selector = d.parent.selector || '', special = /theme-|clock-|loading-ring|spinner|plugin-toggle|checkbox|radio|tool-turn-|execution-signal|image-preview|image-attachment|message-image|attachment-thumbnail/.test(selector)
      const v = d.value
      let next
      if (d.prop === 'border-radius' && /^\d+(?:\.\d+)?px$/.test(v) && parseFloat(v)>0 && parseFloat(v)<=10 && !special) next = `var(--appearance-radius, ${v})`
      else if (/^border(?:-(?:top|right|bottom|left))?$/.test(d.prop) && /^1px solid/.test(v) && !special) next = v.replace('1px','var(--appearance-border-width, 1px)')
      else if (d.prop === 'border-width' && v === '1px' && !special) next = 'var(--appearance-border-width, 1px)'
      else if (d.important && d.prop === 'background' && neutral.has(v)) next = `var(--appearance-surface, ${v})`
      else if (d.important && d.prop === 'background' && accent.has(v) && !special) next = `var(--appearance-accent-soft, ${v})`
      else if (d.important && /^border.*color$/.test(d.prop) && /^#/.test(v) && !special) next = `var(--appearance-line, ${v})`
      else if (d.important && d.prop === 'color' && ['#f3f4f6','#f9fafb','#f8fafc','#e2e8f0','#17151b','#1a1a1a'].includes(v)) next = `var(--appearance-text, ${v})`
      else if (d.important && d.prop === 'color' && v === '#fbcfe8') next = `var(--appearance-accent, ${v})`
      // Component-local fonts must participate as well; code/terminal keeps a separate family.
      else if (file.endsWith('.vue') && d.prop === 'font-family' && !special) next = `var(--appearance-${/mono|Consolas/.test(v)?'code':'ui'}-font, ${v})`
      else if (file.endsWith('.vue') && d.prop === 'font-size' && /^\d+px$/.test(v) && !special) next = `calc(${v} * var(--appearance-ui-scale, 1))`
      if (next && next !== v) { d.value = next; changed++ }
    })
    return root.toString()
  }
  if (file.endsWith('.css')) text = css(text)
  else text = text.replace(/(<style[^>]*>)([\s\S]*?)(<\/style>)/g, (_, a, b, c) => a + css(b) + c)
  await writeFile(file, text)
}
async function walk(dir) { for (const e of await readdir(dir, { withFileTypes: true })) { const p = dir+'/'+e.name; if(e.isDirectory()) await walk(p); else if(/\.(css|vue)$/.test(p)) await migrate(p) } }
await walk('src')
console.log('Migrated declarations:', changed)
