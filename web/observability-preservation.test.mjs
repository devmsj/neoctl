import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const baseline = execFileSync('git', ['show', 'd40cb8b67525b8646587480c43bce3854c153dca:web/src/App.vue'], { cwd: root, encoding: 'utf8' }).replace(/\r\n/g, '\n')
const current = readFileSync(new URL('./src/App.vue', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
function section(text, start, end) {
  const from = text.indexOf(start)
  assert.ok(from >= 0, `missing start ${start}`)
  const to = text.indexOf(end, from + start.length)
  assert.ok(to > from, `missing end ${end}`)
  return text.slice(from, to)
}
test('OBS-02 remains withdrawn: tool group labels and ordered duplicate purposes are unchanged', () => {
  for (const name of ['toolGroupLabels', 'toolGroupPurposes']) {
    const pattern = new RegExp(`function ${name}\\([^]*?\\n\\}`)
    assert.equal(current.match(pattern)?.[0], baseline.match(pattern)?.[0])
  }
})
test('ordinary tool grouping remains independent of terminal session identity', () => {
  assert.equal(section(current, 'function groupVisibleToolLines(', 'function toolGroupExpanded('), section(baseline, 'function groupVisibleToolLines(', 'function toolGroupExpanded('))
})
