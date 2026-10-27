import test from 'node:test'
import assert from 'node:assert/strict'
import { createObservabilityBrowser, observabilitySnapshot } from './observability-browser-fixture.mjs'

test('sessions request exactly one page, search on server, and ignore stale search responses', async () => {
  const requests = []
  let releaseOld
  const oldGate = new Promise(resolve => { releaseOld = resolve })
  const fixture = await createObservabilityBrowser(observabilitySnapshot(), async route => {
    const url = new URL(route.request().url())
    if (url.pathname !== '/api/sessions') return false
    const page = Number(url.searchParams.get('page')), size = Number(url.searchParams.get('pageSize')), q = url.searchParams.get('q') || ''
    requests.push({page, size, q})
    assert.equal(size, 10)
    if (q === 'old') await oldGate
    const total = q ? 1 : 23
    const sessions = q ? [{sessionId:q,title:q}] : Array.from({length:Math.min(size,total-(page-1)*size)}, (_,i)=>({sessionId:`s${(page-1)*size+i}`,title:`Session ${(page-1)*size+i}`}))
    await route.fulfill({json:{sessions,page,pageSize:size,total,totalCount:23}})
    return true
  })
  try {
    const {page} = fixture
    await page.locator('.quick-session').first().waitFor()
    await page.waitForTimeout(100)
    requests.length = 0
    await page.getByRole('button',{name:'会话管理',exact:true}).first().click()
    await page.locator('.session-card').nth(9).waitFor()
    assert.deepEqual(requests,[{page:1,size:10,q:''}])
    assert.equal(await page.locator('.session-card').count(),10)
    await page.getByRole('button',{name:'下一页',exact:true}).click()
    await page.locator('.sessions-page').getByText('Session 10',{exact:true}).waitFor()
    assert.equal(await page.locator('.session-card').count(),10)
    assert.equal(requests.length,2)
    await page.getByRole('button',{name:'下一页',exact:true}).click()
    await page.locator('.sessions-page').getByText('Session 20',{exact:true}).waitFor()
    assert.equal(await page.locator('.session-card').count(),3)
    const input=page.getByPlaceholder('搜索标题或 ID')
    await input.fill('old')
    await page.waitForFunction(()=>!!document.querySelector('.empty-state .loading-ring'))
    await page.waitForTimeout(350)
    await input.fill('new')
    await page.getByText('new',{exact:true}).waitFor()
    releaseOld(); await page.waitForTimeout(100)
    assert.equal(await page.locator('.session-card strong').textContent(),'new')
    assert.ok(requests.filter(r=>r.q).every(r=>r.page===1))
    assert.deepEqual(fixture.errors,[])
  } finally {releaseOld();await fixture.close()}
})
