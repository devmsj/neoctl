import test from 'node:test'
import assert from 'node:assert/strict'
import { createObservabilityBrowser, observabilitySnapshot } from './observability-browser-fixture.mjs'

test('administrator quick switch uses the selected owner rather than the previously viewed owner', async () => {
  const owners=[]
  const f=await createObservabilityBrowser(observabilitySnapshot(),async route=>{
    const url=new URL(route.request().url())
    if(url.pathname==='/api/auth/status'){await route.fulfill({json:{isolation:true,user:{username:'Admin',role:'admin'}}});return true}
    if(url.pathname==='/api/admin/sessions'){await route.fulfill({json:{sessions:[{sessionId:'a',ownerUsername:'Alice',title:'Alice session'},{sessionId:'b',ownerUsername:'Bob',title:'Bob session'}],page:1,total:2,totalPages:1}});return true}
    if(url.pathname==='/api/state' && url.searchParams.has('ownerUsername')){
      owners.push(url.searchParams.get('ownerUsername'))
      const id=url.searchParams.get('sessionId');await route.fulfill({json:observabilitySnapshot({session:{sessionId:id,title:id==='a'?'Alice session':'Bob session'}})});return true
    }
    return false
  },{viewport:{width:1180,height:760}})
  try{
    await f.page.locator('.quick-session').filter({hasText:'Alice session'}).click()
    await f.page.waitForFunction(()=>document.querySelector('.quick-session[aria-current="true"]')?.textContent.includes('Alice'))
    await f.page.locator('.quick-session').filter({hasText:'Bob session'}).click()
    await f.page.waitForFunction(()=>document.querySelector('.quick-session[aria-current="true"]')?.textContent.includes('Bob'))
    assert.deepEqual(owners,['Alice','Bob']);assert.deepEqual(f.errors,[])
  }finally{await f.close()}
})

test('sidebar paginates independently, preserves manager navigation and switches only after loading', async () => {
  const requests = [], errors = []
  let release, delay = false
  const gate = new Promise(resolve => { release = resolve })
  const snapshot = id => observabilitySnapshot({session:{sessionId:id,title:id==='obs-session'?'Current':'Session '+id},lines:[{id:1,kind:'user',text:'Content '+id}],runningSessionIds:['s2']})
  const f = await createObservabilityBrowser(snapshot('obs-session'), async route => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/sessions') {
      const page = Number(url.searchParams.get('page')), size = Number(url.searchParams.get('pageSize')), q = url.searchParams.get('q') || ''
      requests.push({page,size,q})
      const all=Array.from({length:25},(_,i)=>({sessionId:i?'s'+i:'obs-session',title:i?'Session s'+i:'Current',updatedAt:new Date().toISOString()}))
      const matches=all.filter(item=>!q||item.title.includes(q))
      await route.fulfill({json:{sessions:matches.slice((page-1)*size,page*size),total:matches.length,totalCount:25,totalPages:Math.max(1,Math.ceil(matches.length/size)),page}});return true
    }
    if (url.pathname === '/api/state' && url.searchParams.get('sessionId') === 's1') {
      delay = true;await gate;await route.fulfill({json:snapshot('s1')});return true
    }
    if (url.pathname === '/api/state' && /^s\d+$/.test(url.searchParams.get('sessionId') || '')) {
      if(url.searchParams.get('sessionId')==='s4') await route.fulfill({status:500,json:{error:'test failure'}})
      else await route.fulfill({json:snapshot(url.searchParams.get('sessionId'))});return true
    }
    return false
  }, {viewport:{width:1180,height:760}})
  try {
    const {page}=f
    await page.setViewportSize({width:1180,height:760})
    await page.locator('.quick-session').nth(9).waitFor()
    assert.deepEqual(requests,[{page:1,size:10,q:''}])
    assert.equal(await page.locator('.quick-session').count(),10)
    assert.equal(await page.locator('.quick-check').count(),0)
    const frame = page.locator('.quick-session[aria-current="true"] .quick-selection-frame')
    assert.equal(await frame.locator('span').count(),2)
    const animation = await frame.evaluate(el => [...el.children].map(edge => {
      const a = edge.getAnimations()[0]; a.pause(); a.currentTime = 250
      return { duration:a.effect.getTiming().duration, clip:getComputedStyle(edge).clipPath }
    }))
    assert.ok(animation.every(a => a.duration === 500 && a.clip !== 'inset(0px)'))
    await frame.evaluate(el => [...el.children].forEach(edge => { edge.getAnimations()[0].currentTime = 500 }))
    const borders = await frame.evaluate(el => [...el.children].map(edge => {
      const s=getComputedStyle(edge);return [s.borderTopWidth,s.borderRightWidth,s.borderBottomWidth,s.borderLeftWidth,s.clipPath]
    }))
    assert.deepEqual(borders.map(edge=>edge.slice(0,4)),[['1px','1px','0px','0px'],['0px','0px','1px','1px']])
    assert.ok(borders.every(edge=>edge[4].match(/-?\d+(?:\.\d+)?/g).every(value=>Number(value)===0)))
    assert.equal(await page.locator('.quick-scroll').evaluate(el=>getComputedStyle(el).scrollbarWidth),'none')
    await page.locator('.quick-scroll').evaluate(el=>el.scrollTop=el.scrollHeight)
    await page.locator('.quick-session').nth(19).waitFor()
    assert.deepEqual(requests.map(r=>r.page),[1,2])
    await page.locator('.quick-session').filter({hasText:'Session s12'}).scrollIntoViewIfNeeded()
    const position=await page.locator('.quick-scroll').evaluate(el=>el.scrollTop)
    await page.locator('.quick-session').filter({hasText:'Session s12'}).click()
    await page.waitForFunction(()=>document.querySelector('.quick-session[aria-current="true"]')?.textContent.includes('s12'))
    assert.ok(Math.abs(await page.locator('.quick-scroll').evaluate(el=>el.scrollTop)-position)<3)
    await page.locator('.quick-scroll').evaluate(el=>el.scrollTop=0)
    await page.locator('.quick-session').filter({hasText:/^Session s1$/}).click()
    await page.locator('.quick-session[aria-busy="true"] .loading-ring').waitFor()
    assert.ok(delay)
    assert.ok((await page.locator('.virtual-message-list').textContent()).includes('Content s12'))
    // New selection cancels the slow fetch; stale data must never replace it.
    await page.locator('.quick-session').filter({hasText:/^Session s3$/}).click()
    await page.waitForFunction(()=>document.querySelector('.quick-session[aria-current="true"]')?.textContent.includes('s3'))
    release();await page.waitForTimeout(100)
    assert.equal(await page.locator('.quick-session[aria-busy="true"]').count(),0)
    await page.locator('.quick-session').filter({hasText:/^Session s4$/}).click()
    await page.waitForFunction(()=>!document.querySelector('.quick-session[aria-busy="true"]'))
    assert.ok((await page.locator('.quick-session[aria-current="true"]').textContent()).includes('s3'))
    await page.getByRole('button',{name:'会话管理',exact:true}).first().click()
    await page.locator('.sessions-page .session-card').nth(9).waitFor()
    assert.equal(await page.locator('.session-card').count(),10)
    assert.equal(await page.locator('.quick-session').count(),20)
    await page.getByRole('button',{name:'搜索最近会话',exact:true}).click()
    await page.getByRole('searchbox',{name:'搜索最近会话标题'}).fill('s24')
    await page.waitForFunction(()=>document.querySelectorAll('.quick-session').length===1)
    assert.ok((await page.locator('.quick-session').textContent()).includes('s24'))
    assert.deepEqual(requests.at(-1),{page:1,size:10,q:'s24'})
    assert.equal(await page.locator('.sessions-page').count(),1)
    await page.screenshot({path:new URL('../../desktop/.cache/quick-list-implemented.png',import.meta.url).pathname.replace(/^\/(\w:)/,'$1')})
    for (const theme of ['dark','light']) {
      await page.evaluate(value=>document.documentElement.dataset.theme=value,theme)
      const style=await page.locator('.quick-session').evaluate(el=>{const s=getComputedStyle(el);return {border:s.borderTopWidth,height:el.getBoundingClientRect().height,overflow:el.scrollWidth>el.clientWidth}})
      assert.equal(style.border,'0px');assert.equal(style.height,42);assert.equal(style.overflow,false)
    }
    assert.deepEqual(f.errors,errors)
  } finally {release();await f.close()}
})
