import assert from 'node:assert/strict'
import test from 'node:test'
import { createObservabilityBrowser, observabilitySnapshot } from './observability-browser-fixture.mjs'
import { retrySecondsRemaining } from '../src/retry-countdown.mjs'

test('countdown rounds up, caps at 60, and hides expired/disconnected/paused/idle states', () => {
  assert.equal(retrySecondsRemaining(10001, 1), 10)
  assert.equal(retrySecondsRemaining(10001, 2), 10)
  assert.equal(retrySecondsRemaining(10001, 10001), undefined)
  assert.equal(retrySecondsRemaining(100000, 0), 60)
  for (const flags of [{connected:false}, {paused:true}, {busy:false}]) assert.equal(retrySecondsRemaining(10000, 0, flags), undefined)
})

test('retry icon countdown is stable, accent-colored and returns to the resume triangle on pause', async () => {
  const current = observabilitySnapshot({session:{sessionId:'retry-preview'}, busy:true, runControl:{state:'running',canPause:true,canResume:false}, status:{phase:'calling_model',retryCooldownUntil:Date.now()+11000}})
  const actions = []
  const f = await createObservabilityBrowser(() => current, async route => {
    if (route.request().method() !== 'POST') return false
    const path = new URL(route.request().url()).pathname
    actions.push(path)
    if (path === '/api/run/pause') {
      current.busy = false
      current.runControl = {state:'paused',canResume:true,canPause:false}
      current.status.retryCooldownUntil = undefined
    }
    await route.fulfill({json:{ok:true}})
    return true
  })
  try {
    await f.page.addInitScript(() => {
      window.__sources=[]
      window.EventSource=class extends EventTarget {constructor(){super();window.__sources.push(this);queueMicrotask(()=>this.dispatchEvent(new Event('open')))}close(){this.closed=true}}
    })
    await f.page.reload()
    const icon=f.page.locator('.execution-retry')
    await icon.waitFor()
    const first=await icon.boundingBox()
    assert.equal(first.width,28);assert.equal(first.height,28)
    assert.equal(await icon.locator('svg').count(),1)
    const initial=Number(await icon.locator('.execution-retry-count').textContent())
    assert(initial>=1 && initial<=11)
    await f.page.waitForTimeout(1150)
    assert(Number(await icon.locator('.execution-retry-count').textContent())<initial)
    const second=await icon.boundingBox()
    assert.equal(first.width,second.width);assert.equal(first.x,second.x)
    for(const theme of ['dark','light']) {
      await f.page.evaluate(theme=>{document.documentElement.dataset.theme=theme;document.documentElement.style.setProperty('--chrome-accent','#a3bbc4')},theme)
      await f.page.waitForTimeout(350)
      assert.equal(await icon.locator('.execution-retry-count').evaluate(el=>getComputedStyle(el).color),'rgb(163, 187, 196)')
      assert.equal(await icon.locator('svg').evaluate(el=>getComputedStyle(el).stroke),'rgb(163, 187, 196)')
    }
    await icon.click()
    await f.page.waitForTimeout(80)
    assert.deepEqual(actions, ['/api/run/pause'])
    await f.page.evaluate(value=>window.__sources.filter(s=>!s.closed).at(-1).dispatchEvent(new MessageEvent('sync',{data:JSON.stringify(value)})),current)
    await icon.waitFor({state:'hidden'})
    await f.page.locator('.execution-resume').waitFor()
    assert.deepEqual(f.errors,[])
  } finally {await f.close()}
})
