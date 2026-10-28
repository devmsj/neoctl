import test from 'node:test'
import assert from 'node:assert/strict'
import { createAppearanceController } from '../src/appearance-controller.mjs'
import { emptyAppearance } from '../shared/appearance.mjs'

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const reply = (config, revision) => ({ ok: true, status: 200, json: async () => ({ config, revision }) })
test('late reads cannot roll back saved appearance; reads during save wait; dispose ignores pending responses', async t => {
  const original = new Map()
  const install = (key, value) => { original.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value }) }
  const styles = new Map(), storage = new Map()
  install('document', { documentElement: { dataset: {}, style: { getPropertyValue: k => styles.get(k) || '', setProperty: (k,v) => styles.set(k,v), removeProperty: k => styles.delete(k) } }, fonts: { add() {}, delete() {} } })
  install('window', { addEventListener() {}, removeEventListener() {} })
  install('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }))
  install('localStorage', { getItem: k => storage.get(k) || null, setItem: (k,v) => storage.set(k,v) })
  install('requestAnimationFrame', callback => setTimeout(callback, 0))
  install('cancelAnimationFrame', clearTimeout)
  const requests = []
  install('fetch', (url, init) => { const d = deferred(); requests.push({ url, init, ...d }); return d.promise })
  t.after(() => { for (const [key, descriptor] of original) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key] } })
  const c = createAppearanceController({ onTheme() {} }); t.after(() => c.dispose())
  const config = emptyAppearance(); config.mode = 'dark'
  const initial = c.load(); requests[0].resolve(reply(config, '1')); await initial
  const late = c.load(true)
  const next = structuredClone(config); next.dark.accent = '#4488aa'
  const save = c.save(next)
  const during = c.load(true)
  assert.equal(requests.length, 3, 'GET waits for pending PUT')
  await assert.rejects(c.save(config), /保存/)
  requests[2].resolve(reply(next, '2')); await save
  requests[1].resolve(reply(config, '1')); await late
  assert.equal(c.state.revision, '2')
  await new Promise(r => setTimeout(r, 0))
  assert.equal(requests.length, 4)
  requests[3].resolve(reply(next, '2')); await during
  assert.equal(c.state.config.dark.accent, '#4488aa')
  const last = c.load(true); c.dispose(); requests[4].resolve(reply(config, '0')); await last
  assert.equal(c.state.revision, '2'); assert.equal(styles.size, 0)
})
