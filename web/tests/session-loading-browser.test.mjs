import test from 'node:test'
import assert from 'node:assert/strict'
import { createObservabilityBrowser, observabilitySnapshot } from './observability-browser-fixture.mjs'

test('session open uses the shared pink animated ring and disables duplicate actions', async () => {
  let finish
  const gate = new Promise(resolve => { finish = resolve })
  let delayed = false
  const fixture = await createObservabilityBrowser(observabilitySnapshot(), async route => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/sessions') {
      await route.fulfill({ json: { sessions: [{sessionId:'target',title:'Target'}, {sessionId:'other',title:'Other'}] } }); return true
    }
    if (url.pathname === '/api/state' && url.searchParams.get('sessionId') === 'target') {
      delayed = true; await gate
      await route.fulfill({ json: observabilitySnapshot({session:{sessionId:'target',title:'Target'}}) }); return true
    }
    return false
  })
  try {
    const {page} = fixture
    await page.getByRole('button',{name:'会话管理',exact:true}).first().click()
    await page.getByRole('button',{name:'打开会话',exact:true}).first().click()
    const button = page.getByRole('button',{name:'打开会话',exact:true}).first()
    await button.locator('.loading-ring').waitFor()
    assert.equal(await button.getAttribute('aria-busy'),'true')
    assert.equal(await button.isDisabled(),true)
    assert.equal(await page.locator('.sessions-page .loading-ring').count(),1)
    const style = await button.locator('.loading-ring').evaluate(el=>{
      const probe=document.createElement('span');probe.style.color='var(--pink)';el.parentElement.append(probe)
      const pink=getComputedStyle(probe).color;probe.remove()
      const s=getComputedStyle(el);return {stroke:s.stroke,pink,animation:s.animationName,duration:s.animationDuration}
    })
    assert.equal(style.stroke,style.pink)
    assert.equal(style.animation,'composer-wait-spin');assert.equal(style.duration,'0.75s')
    await page.emulateMedia({reducedMotion:'reduce'})
    const reduced = await button.locator('.loading-ring').evaluate(el=>({duration:parseFloat(getComputedStyle(el).animationDuration),iterations:getComputedStyle(el).animationIterationCount}))
    assert.ok(reduced.duration >= 2 || (reduced.duration <= .01 && reduced.iterations === '1'))
    assert.equal(delayed,true)
    finish()
    await page.locator('.sessions-page').waitFor({state:'detached'})
    assert.deepEqual(fixture.errors,[])
  } finally { finish();await fixture.close() }
})
