// Complete !important inventory, including component-local rules. Run explicitly.
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve, relative } from 'node:path'
import postcss from 'postcss'
const root = resolve('src'), rows = []
async function walk(folder) {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const path = resolve(folder, entry.name)
    if (entry.isDirectory()) { await walk(path); continue }
    if (!/\.(css|vue)$/.test(path)) continue
    const text = await readFile(path, 'utf8')
    const sources = path.endsWith('.vue') ? [...text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1]) : [text]
    for (const source of sources) postcss.parse(source, { from: path }).walkDecls(d => {
      if (!d.important) return
      const property = d.prop
      const decision = /^(animation|transition|transform|content|display|position|inset|z-index|overflow|pointer-events|opacity|visibility|width|height|min-|max-|flex|grid|gap|padding|margin|align|justify)/.test(property)
        ? 'retain: behavior, geometry, responsive or accessibility constraint'
        : /var\(--appearance-|var\(--(?:chrome|history|rich|syntax|mono|sans|text|line|purple|panel|surface|bg|muted|faint)/.test(d.value)
          ? 'retain priority; customizable through semantic token/fallback'
          : /none|transparent|inherit|currentColor|^0(?:px)?$/.test(d.value)
            ? 'retain: intentional reset or inherited semantic value'
            : 'review: fixed visual value / semantic status / legacy fallback'
      rows.push({ file: relative(root, path), line: d.source.start.line, selector: d.parent.selector || d.parent.name, property, value: d.value, decision })
    })
  }
}
await walk(root)
const output = process.argv[2] || '../desktop/.cache/appearance-css-audit.json'
await mkdir(resolve(output, '..'), { recursive: true })
await writeFile(output, JSON.stringify({ total: rows.length, fixed: rows.filter(r => r.decision.startsWith('review')).length, declarations: rows }, null, 2))
console.log(JSON.stringify({ total: rows.length, fixed: rows.filter(r => r.decision.startsWith('review')).length, report: output }))
for (const r of rows.filter(r => r.decision.startsWith('review'))) console.log(`${r.file}:${r.line} ${r.selector} | ${r.property}: ${r.value}`)
