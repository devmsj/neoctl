// Production App + virtualizer + mocked SSE, no provider calls.
import assert from 'node:assert/strict'
import { createObservabilityBrowser, observabilitySnapshot } from './observability-browser-fixture.mjs'

let snapshot = observabilitySnapshot({ busy: true, status: { phase: 'calling_model' },
  lines: Array.from({ length: 45 }, (_, i) => ({ id: i + 1, kind: i === 44 || i % 2 ? 'assistant' : 'user', text: `History ${i}\n\n${'A paragraph of history. '.repeat(12)}`, live: i === 44 })),
})
const fixture = await createObservabilityBrowser(() => snapshot)
try {
  const { page } = fixture
  await page.addInitScript(() => {
    window.EventSource = class extends EventTarget {
      constructor() { super(); window.scrollEvents = this; queueMicrotask(() => this.dispatchEvent(new Event('open'))) }
      close() {}
    }
  })
  await page.reload()
  await page.waitForFunction(() => window.scrollEvents && document.querySelector('.virtual-message-row'))
  const sync = () => page.evaluate(value => window.scrollEvents.dispatchEvent(new MessageEvent('sync', { data: JSON.stringify(value) })), snapshot)
  const metrics = () => page.locator('.transcript').evaluate(el => ({ top: el.scrollTop, gap: el.scrollHeight - el.clientHeight - el.scrollTop }))
  const atBottom = () => page.waitForFunction(() => {
    const el = document.querySelector('.transcript')
    return el.scrollHeight > el.clientHeight + 500 && el.scrollHeight - el.clientHeight - el.scrollTop <= 2
  }, undefined, { timeout: 8000 })
  const grow = async (count = 8) => {
    snapshot.lines.at(-1).text += '\n\n' + Array.from({ length: count }, (_, i) => `Stream paragraph ${i}`).join('\n\n')
    await sync()
    await page.waitForTimeout(60) // Vue patch + deferred virtual row measurement
  }
  await atBottom()
  await page.waitForTimeout(400)
  const start = await metrics()
  await page.evaluate(() => {
    window.samples = []
    window.sampling = true
    function sample() {
      const el = document.querySelector('.transcript')
      window.samples.push({ top: el.scrollTop, gap: el.scrollHeight - el.clientHeight - el.scrollTop })
      if (window.sampling) requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
  })
  await grow(12)
  await atBottom()
  const samples = await page.evaluate(() => { window.sampling = false; return window.samples })
  assert(samples.some(s => s.top > start.top + 2 && s.gap > 5), 'stream growth has intermediate positions, not an immediate bottom jump')
  const movements = samples.slice(1).map((s, i) => s.top - samples[i].top)
  assert(movements.every(d => d >= -1 && d < 90), `single smooth writer without jumps: ${JSON.stringify(movements)}`)

  // Full TouchEvent lifecycle on the production App (not a controller stub).
  const touch = (type, y = 200) => page.locator('.transcript').evaluate((el, { type, y }) => {
    const point = new Touch({ identifier: 1, target: el, clientX: 400, clientY: y })
    const active = type === 'touchstart' || type === 'touchmove'
    el.dispatchEvent(new TouchEvent(type, { bubbles: true, touches: active ? [point] : [], targetTouches: active ? [point] : [], changedTouches: [point] }))
  }, { type, y })
  await touch('touchstart')
  await touch('touchend')
  const beforeTapGrowth = await metrics()
  await grow(2)
  await page.waitForFunction(top => document.querySelector('.transcript').scrollTop > top + 40, beforeTapGrowth.top, { timeout: 3000 })
  await atBottom()
  assert((await metrics()).top > beforeTapGrowth.top + 40, 'stationary tap must not disable following for subsequent output')

  const beforeHeldGrowth = await metrics()
  await touch('touchstart')
  await grow(4); await page.waitForTimeout(250)
  assert(Math.abs((await metrics()).top - beforeHeldGrowth.top) < 2, 'held touch suspends following')
  assert((await metrics()).gap > 48, 'content grows beyond normal reattach threshold while held')
  await page.locator('.transcript').dispatchEvent('pointerup', { pointerType: 'touch', bubbles: true })
  await touch('touchend')
  await atBottom()
  await grow(2); await atBottom()

  // Real native wheel, very close to bottom. SSE/resize must not take ownership back.
  const box = await page.locator('.transcript').boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.wheel(0, -24)
  await page.waitForTimeout(180)
  const up = await metrics()
  assert(up.gap >= 15 && up.gap < 96)
  await touch('touchstart'); await touch('touchend')
  await grow(4)
  await page.waitForTimeout(500)
  assert(Math.abs((await metrics()).top - up.top) < 2, 'tiny up-scroll is not pulled back by sync or virtual measurements')

  const appendedId = snapshot.lines.at(-1).id + 1
  const appended = { id: appendedId, kind: 'assistant', text: 'A newly appended message', live: true }
  snapshot.lines.push(appended)
  await page.evaluate(line => window.scrollEvents.dispatchEvent(new MessageEvent('delta', { data: JSON.stringify({ operations: [{ type: 'line.append', line }] }) })), appended)
  await page.waitForTimeout(300)
  assert(Math.abs((await metrics()).top - up.top) < 2, 'virtualizer append cannot bypass interrupted follow')

  // Return toward the bottom, then interrupt an in-flight follow.
  await page.mouse.wheel(0, 10000)
  await atBottom()
  await page.waitForTimeout(300)
  await grow(18)
  await page.waitForTimeout(90)
  await page.mouse.wheel(0, -36)
  await page.waitForTimeout(200)
  const interrupted = await metrics()
  await grow(2)
  await page.waitForTimeout(400)
  assert(Math.abs((await metrics()).top - interrupted.top) < 2, 'interrupting animation leaves no stale RAF or follow-on-append jump')

  // Native keyboard and scrollbar-like pointer ownership.
  await page.locator('.transcript').focus()
  await page.keyboard.press('End')
  await atBottom(); await page.waitForTimeout(300)
  await page.keyboard.press('ArrowUp'); await page.waitForTimeout(250)
  const keyboardTop = (await metrics()).top
  await grow(2); await page.waitForTimeout(300)
  assert(Math.abs((await metrics()).top - keyboardTop) < 2, 'keyboard upward scroll retains control')

  // Deferred image/layout height changes use the same smooth controller.
  await page.mouse.wheel(0, 10000); await atBottom(); await page.waitForTimeout(300)
  const beforeResize = (await metrics()).top
  await page.locator('.virtual-message-row').last().evaluate(row => {
    const imagePlaceholder = document.createElement('div')
    imagePlaceholder.style.height = '320px'
    row.append(imagePlaceholder)
  })
  await atBottom()
  assert((await metrics()).top > beforeResize + 250, 'ResizeObserver follows late content sizing without a new SSE event')

  await page.emulateMedia({ reducedMotion: 'reduce' })
  await grow(4); await atBottom()
  await page.mouse.wheel(0, -20); await page.waitForTimeout(200)
  const reducedTop = (await metrics()).top
  await grow(4); await page.waitForTimeout(300)
  assert(Math.abs((await metrics()).top - reducedTop) < 2)
  assert.equal(fixture.errors.length, 0, JSON.stringify(fixture.errors))
  console.log('Transcript follow browser regression passed (smooth stream, wheel interruption, return, keyboard, delayed layout, reduced motion).')
} catch (error) {
  console.error(await fixture.page.evaluate(() => ({ samples: window.samples?.slice(-20), el: (() => { const e = document.querySelector('.transcript'); return { top: e.scrollTop, height: e.scrollHeight, client: e.clientHeight } })() })))
  throw error
} finally {
  await fixture.close()
}
