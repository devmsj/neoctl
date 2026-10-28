import test from 'node:test'
import assert from 'node:assert/strict'
import { createObservabilityBrowser, observabilitySnapshot } from './observability-browser-fixture.mjs'

test('only successful completion lights clock rings and duration green in both themes', async () => {
  const snapshot = observabilitySnapshot({ status: { phase: 'ready', queryTiming: {
    version: 1, id: 'clock-query', kind: 'query', status: 'finished', outcome: 'completed', durationMs: 450000,
  } } })
  const ui = await createObservabilityBrowser(() => snapshot)
  try {
    const clock = ui.page.locator('.elapsed-clock')
    await clock.waitFor()
    assert.equal(await clock.locator('.elapsed-clock-value').innerText(), '7m 30s')
    for (const [theme, green] of [['light', 'rgb(32, 183, 106)'], ['dark', 'rgb(77, 221, 139)']]) {
      await ui.page.evaluate(value => document.documentElement.dataset.theme = value, theme)
      const colors = await clock.evaluate(el => ({
        rim: getComputedStyle(el.querySelector('.clock-rim')).stroke,
        well: getComputedStyle(el.querySelector('.clock-well')).stroke,
        value: getComputedStyle(el.querySelector('.elapsed-clock-value')).color,
        hand: getComputedStyle(el.querySelector('.clock-hand line')).stroke,
        tick: getComputedStyle(el.querySelector('.clock-ticks line:not(.major)')).stroke,
        major: getComputedStyle(el.querySelector('.clock-ticks .major')).stroke,
        pin: getComputedStyle(el.querySelector('.clock-pin')).fill,
      }))
      assert.deepEqual({rim:colors.rim,well:colors.well,value:colors.value,tick:colors.tick,major:colors.major}, {rim:green,well:green,value:green,tick:green,major:green})
      assert.notEqual(colors.hand,green);assert.equal(colors.hand,colors.pin)
    }
    snapshot.status.queryTiming.outcome = 'model_error'
    await ui.page.reload()
    await clock.waitFor()
    assert.equal(await clock.evaluate(el => el.classList.contains('is-completed')), false)
    snapshot.status.queryTiming.status = 'running'
    snapshot.status.queryTiming.elapsedMs = 1200
    snapshot.busy = true
    snapshot.status.phase = 'calling_model'
    await ui.page.reload()
    await clock.waitFor()
    assert.equal(await clock.evaluate(el => el.classList.contains('is-completed')), false)
  } finally { await ui.close() }
})

test('running clock accents only the hand and keeps the face and duration neutral', async () => {
 const ui=await createObservabilityBrowser(observabilitySnapshot({busy:true,status:{phase:'calling_model',queryTiming:{version:1,id:'q',kind:'query',status:'running',elapsedMs:7000}}}))
 try {
  const clock=ui.page.locator('.elapsed-clock');await clock.waitFor()
  for(const theme of ['light','dark'])for(const accent of ['#247f78','#bd6845']){
   await ui.page.evaluate(({theme,accent})=>{document.documentElement.dataset.theme=theme;document.documentElement.style.setProperty('--appearance-accent',accent)},{theme,accent})
   const colors=await clock.evaluate(el=>{
    const probe=document.createElement('span');probe.style.color='var(--appearance-accent)';el.append(probe);const expected=getComputedStyle(probe).color;probe.style.color='var(--chrome-muted)';const neutral=getComputedStyle(probe).color;probe.remove()
    return {expected,neutral,value:getComputedStyle(el.querySelector('.elapsed-clock-value')).color,strokes:['.clock-ticks line','.clock-ticks .major','.clock-hand line'].map(s=>getComputedStyle(el.querySelector(s)).stroke),pin:getComputedStyle(el.querySelector('.clock-pin')).fill,rim:getComputedStyle(el).getPropertyValue('--clock-rim-edge'),well:getComputedStyle(el).getPropertyValue('--clock-well-edge')}
   })
   assert.equal(colors.value,colors.neutral);assert.equal(colors.pin,colors.expected);assert.deepEqual(colors.strokes,[colors.neutral,colors.neutral,colors.expected]);assert.ok(!colors.rim.includes(accent));assert.ok(!colors.well.includes(accent))
  }
 }finally{await ui.close()}
})
