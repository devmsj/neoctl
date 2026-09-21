import assert from 'node:assert/strict'
import test from 'node:test'
import { createTranscriptFollow } from '../src/transcript-follow.mjs'

function fixture(reduce = false) {
  let time = 0, id = 0
  const frames = new Map(), timers = new Map(), listeners = new Map()
  const documentListeners = new Map()
  const doc = {
    addEventListener: (name, fn) => documentListeners.set(name, fn),
    removeEventListener: (name) => documentListeners.delete(name),
  }
  const el = {
    scrollTop: 0, scrollHeight: 1000, clientHeight: 400, clientWidth: 300, clientLeft: 0,
    ownerDocument: doc,
    addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: (name) => listeners.delete(name),
    getBoundingClientRect: () => ({ left: 0 }),
  }
  const controller = createTranscriptFollow({
    getElement: () => el, now: () => time, reducedMotion: () => reduce,
    requestFrame: (fn) => { frames.set(++id, fn); return id },
    cancelFrame: (id) => frames.delete(id),
    setTimer: (fn, ms) => { timers.set(++id, { fn, at: time + ms }); return id },
    clearTimer: (id) => timers.delete(id),
  })
  controller.attach(el)
  function advance(ms = 16) {
    time += ms
    for (const [id, timer] of [...timers]) if (timer.at <= time) { timers.delete(id); timer.fn() }
    const pending = [...frames]; frames.clear()
    for (const [, fn] of pending) fn(time)
  }
  const emit = (name, event = {}) => listeners.get(name)?.(event)
  const scroll = (top) => { el.scrollTop = top; emit('scroll') }
  advance()
  const emitDocument = (name, event = {}) => documentListeners.get(name)?.(event)
  return { controller, el, advance, emit, emitDocument, scroll, frames, timers, listeners }
}

test('single retargetable loop follows growth gradually without overshoot', () => {
  const f = fixture()
  assert.equal(f.el.scrollTop, 600, 'initial history lands at bottom without a long tour')
  f.el.scrollHeight += 240
  for (let i = 0; i < 10; i++) f.controller.schedule()
  assert.equal(f.frames.size, 1)
  f.advance()
  assert(f.el.scrollTop > 600 && f.el.scrollTop < 640)
  let previous = f.el.scrollTop
  for (let i = 0; i < 90; i++) {
    if (i % 10 === 0) { f.el.scrollHeight += 20; f.controller.schedule() }
    f.advance()
    assert(f.el.scrollTop >= previous && f.el.scrollTop <= f.el.scrollHeight - 400)
    previous = f.el.scrollTop
  }
  for (let i = 0; i < 90; i++) f.advance()
  assert(f.el.scrollHeight - 400 - f.el.scrollTop <= 1)
  assert.equal(f.frames.size, 0, 'idle controller does not poll')
})

test('tiny upward wheel cancels queued frame before native scroll and stays detached within old 96px zone', () => {
  const f = fixture()
  f.el.scrollHeight += 20
  f.controller.schedule()
  f.emit('wheel', { deltaY: -4 })
  f.scroll(596)
  assert.equal(f.frames.size, 0)
  for (let i = 0; i < 60; i++) { f.controller.schedule(); f.advance() }
  assert.equal(f.el.scrollTop, 596)
  assert.equal(f.controller.following, false)
})

test('downward return waits for gesture and inertia to settle, then eases final gap', () => {
  const f = fixture()
  f.emit('wheel', { deltaY: -20 }); f.scroll(560)
  f.emit('wheel', { deltaY: 10 }); f.scroll(570)
  f.advance(100); f.scroll(575); f.advance(100)
  assert.equal(f.controller.following, false)
  assert.equal(f.el.scrollTop, 575)
  f.advance(81)
  assert.equal(f.controller.following, true)
  assert(f.el.scrollTop > 575 && f.el.scrollTop < 600)
  f.emit('wheel', { deltaY: -1 }); f.scroll(574)
  f.advance(500)
  assert.equal(f.el.scrollTop, 574)
})

test('touch ownership lasts through held touch; upward momentum never reattaches', () => {
  const f = fixture()
  f.emit('touchstart', { touches: [{ clientY: 100 }] })
  f.emit('touchmove', { touches: [{ clientY: 120 }] }); f.scroll(580)
  f.advance(500)
  assert.equal(f.controller.following, false)
  f.emit('touchend'); f.scroll(575); f.advance(500)
  assert.equal(f.controller.following, false)
  f.emit('touchstart', { touches: [{ clientY: 120 }] })
  f.emit('touchmove', { touches: [{ clientY: 100 }] }); f.scroll(590)
  f.advance(500)
  assert.equal(f.controller.following, false)
  f.emit('touchend'); f.advance(200)
  assert.equal(f.controller.following, true)
})

test('stationary tap restores follow even when content grows beyond the reattach threshold', () => {
  for (const reduced of [false, true]) {
    const f = fixture(reduced)
    f.emit('touchstart', { touches: [{ clientX: 50, clientY: 100 }] })
    f.el.scrollHeight += 200
    f.controller.schedule(); f.advance(300)
    assert.equal(f.el.scrollTop, 600, 'held touch suspends following')
    f.emit('touchend', { type: 'touchend', touches: [] })
    assert.equal(f.controller.following, true)
    f.advance()
    assert(f.el.scrollTop > 600)
    for (let i = 0; i < 100; i++) f.advance()
    assert(f.el.scrollHeight - f.el.clientHeight - f.el.scrollTop <= 1)
    f.el.scrollHeight += 82; f.controller.schedule(); f.advance()
    assert(f.el.scrollTop > 799, 'subsequent replies still follow')
  }
})

test('tap while browsing does not enable following, including a pending downward settle', () => {
  const f = fixture()
  f.emit('wheel', { deltaY: 1 }); f.scroll(590)
  assert.equal(f.controller.following, false)
  f.emit('touchstart', { touches: [{ clientY: 100 }] })
  f.emit('touchend', { touches: [] })
  f.el.scrollHeight += 82; f.controller.schedule(); f.advance(1000)
  assert.equal(f.controller.following, false)
  assert.equal(f.el.scrollTop, 590)
})

test('pointer lifecycle cannot release a held touch or erase its tap restoration', () => {
  const f = fixture()
  f.emit('touchstart', { touches: [{ clientY: 100 }] })
  f.emitDocument('pointerup', { pointerType: 'touch' })
  f.advance(500)
  assert.equal(f.controller.interacting, true)
  assert.equal(f.controller.following, false)
  f.emit('touchend', { touches: [] })
  f.emitDocument('pointerup', { pointerType: 'touch' })
  assert.equal(f.controller.following, true)
})

test('cancelled, moved, multitouch or explicitly paused touches never restore stale follow', () => {
  for (const action of ['cancel', 'horizontal', 'vertical-return', 'multitouch', 'pause']) {
    const f = fixture()
    f.emit('touchstart', { touches: [{ clientX: 50, clientY: 100 }] })
    if (action === 'horizontal') f.emit('touchmove', { touches: [{ clientX: 70, clientY: 100 }] })
    if (action === 'vertical-return') {
      f.emit('touchmove', { touches: [{ clientX: 50, clientY: 120 }] })
      f.emit('touchmove', { touches: [{ clientX: 50, clientY: 100 }] })
    }
    if (action === 'multitouch') {
      f.emit('touchstart', { touches: [{ clientX: 50, clientY: 100 }, { clientX: 70, clientY: 100 }] })
      f.emit('touchend', { touches: [{ clientX: 50, clientY: 100 }] })
      assert.equal(f.controller.interacting, true)
    }
    if (action === 'pause') f.controller.pause()
    f.el.scrollHeight += 200
    f.emit(action === 'cancel' ? 'touchcancel' : 'touchend', { type: action === 'cancel' ? 'touchcancel' : 'touchend', touches: [] })
    f.controller.schedule(); f.advance(500)
    assert.equal(f.controller.following, false, action)
    assert.equal(f.el.scrollTop, 600, action)
  }
})

test('manual expansion pauses, new session resets, disposal cancels all work', () => {
  const f = fixture()
  f.controller.pause(); f.el.scrollHeight += 500; f.controller.schedule(); f.advance()
  assert.equal(f.el.scrollTop, 600)
  f.controller.reset(); f.advance()
  assert.equal(f.el.scrollTop, 1100)
  f.emit('wheel', { deltaY: 1 })
  assert(f.timers.size)
  f.controller.dispose(); f.controller.schedule(); f.advance(1000)
  assert.equal(f.frames.size, 0)
  assert.equal(f.timers.size, 0)
  assert.equal(f.listeners.size, 0)
})

test('reduced motion follows immediately but still yields to user input', () => {
  const f = fixture(true)
  f.el.scrollHeight += 300; f.controller.schedule(); f.advance()
  assert.equal(f.el.scrollTop, 900)
  f.emit('wheel', { deltaY: -5 }); f.scroll(895)
  f.el.scrollHeight += 30; f.controller.schedule(); f.advance()
  assert.equal(f.el.scrollTop, 895)
})

test('layout shrink is not mistaken for upward intent; paused layout changes cannot resume following', () => {
  const f = fixture()
  f.scroll(550)
  assert.equal(f.controller.following, true)
  f.controller.schedule(); f.advance()
  assert(f.el.scrollTop > 550)
  f.controller.pause(); f.scroll(590); f.advance(500)
  assert.equal(f.controller.following, false)
})

test('scrollbar drag pauses before scroll and does not resume while held', () => {
  const f = fixture()
  f.emit('pointerdown', { target: f.el, button: 0, clientX: 305 })
  f.scroll(580); f.scroll(595); f.advance(1000)
  assert.equal(f.el.scrollTop, 595)
  assert.equal(f.controller.following, false)
  assert.equal(f.controller.interacting, true)
})

test('keyboard scrolling cancels queued follow; form controls do not', () => {
  const f = fixture()
  f.el.scrollHeight += 20; f.controller.schedule()
  f.emit('keydown', { key: 'ArrowUp', target: { closest: () => ({}) } })
  assert.equal(f.controller.following, true)
  f.emit('keydown', { key: 'ArrowUp', target: { closest: () => null } })
  assert.equal(f.controller.following, false)
  assert.equal(f.frames.size, 0)
})
