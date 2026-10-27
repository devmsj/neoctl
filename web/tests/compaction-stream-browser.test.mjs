import test from 'node:test'
import assert from 'node:assert/strict'
import { createObservabilityBrowser, observabilitySnapshot } from './observability-browser-fixture.mjs'

test('compaction replaces old tool icons and streams summary in the observation window', async () => {
  const snapshot = observabilitySnapshot({busy:true, status:{phase:'compacting',compactionText:'',queryTiming:{version:1,id:'q',kind:'query',status:'running',elapsedMs:5000}},lines:[{id:1,kind:'tool',toolName:'file_read',text:'Old tool output',titleStatus:'success'}]})
  const fixture = await createObservabilityBrowser(()=>snapshot)
  try {
    const {page}=fixture
    await page.addInitScript(()=>{
      window.EventSource=class extends EventTarget {
        constructor(){super();window.compactionEvents=this;queueMicrotask(()=>this.dispatchEvent(new Event('open')))}
        close(){}
      }
    })
    await page.reload()
    await page.locator('.execution-signal[data-mode="compacting"] .signal-compacting').waitFor()
    assert.match(await page.locator('.signal-compacting').evaluate(el=>getComputedStyle(el).animationName),/signal-breathe/)
    assert.equal(await page.locator('.main-observation-presence').count(),0)
    const emit=async()=>page.evaluate(value=>window.compactionEvents.dispatchEvent(new MessageEvent('sync',{data:JSON.stringify(value)})),snapshot)
    snapshot.status.compactionText='Summary first line'
    await emit()
    await page.locator('.compaction-observation').getByText('Summary first line',{exact:true}).waitFor()
    snapshot.status.compactionText+='\nSecond line <script>safe text</script>'
    await emit()
    await page.waitForFunction(()=>document.querySelector('.compaction-observation pre')?.textContent.includes('Second line'))
    assert.equal(await page.locator('.compaction-observation pre').textContent(),snapshot.status.compactionText)
    assert.equal(await page.locator('.compaction-observation script').count(),0)
    await page.locator('.compaction-observation .tool-observation-viewport').waitFor({state:'hidden',timeout:8000})
    snapshot.status.compactionText+='\nNew chunk'
    await emit()
    await page.locator('.compaction-observation .tool-observation-viewport').waitFor()
    snapshot.status.phase='calling_model';snapshot.status.compactionText=undefined
    await emit()
    await page.locator('.execution-signal[data-mode="waiting"]').waitFor()
    assert.equal(await page.locator('.compaction-observation').count(),0)
    assert.deepEqual(fixture.errors,[])
  } finally {await fixture.close()}
})
