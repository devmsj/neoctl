// Assemble a single-file prototype. Appearance compiler, presets, contract helpers,
// chrome fallbacks and icon paths are read from the real source tree, not copied by hand.
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const web = fileURLToPath(new URL('../../web', import.meta.url))
const read = p => readFileSync(`${web}/${p}`, 'utf8')
const local = p => readFileSync(new URL(p, import.meta.url), 'utf8')
const strip = s => s.replace(/^import .*$/mg, '').replace(/^export /mg, '')
const source = [
  strip(read('shared/appearance.mjs')),
  strip(read('src/appearance-tokens.mjs')),
  strip(read('src/appearance-presets.mjs')),
  'const ICONS = ' + read('src/components/ChromeIcon.vue').match(/const paths = (\{[\s\S]*?\n\})/)[1],
].join('\n')
const chromeVars = read('src/chrome-theme.css').match(/:root \{[\s\S]*?\n\}\n:root\[data-theme='dark'\] \{[\s\S]*?\n\}/)[0]
const css = ['tokens.css', 'shell.css', 'controls.css', 'pages.css', 'extra.css', 'forms.css', 'switch.css', 'legacy.css'].map(local).join('\n')
const js = ['app-core.js', 'app-render.js', 'app-forms.js', 'app-switch.js', 'app-events.js'].map(local).join('\n')
const html = local('template.html')
  .replace('/*@@CSS@@*/', () => chromeVars + '\n' + css)
  .replace('/*@@SOURCE@@*/', () => source + '\n' + js)
writeFileSync(new URL('index.html', import.meta.url), html)
console.log('index.html', html.length)
