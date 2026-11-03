import test from 'node:test'
import assert from 'node:assert/strict'
import { mergeSessionActivity, sessionDateGroup, sessionTimestamp } from '../src/session-recency.mjs'
const now = new Date(2026,9,30,12).getTime()
const yesterday = new Date(2026,9,29,12).toISOString()
const today = new Date(now).toISOString()
test('continued conversation moves yesterday row to today and top without fetching',()=>{
 const rows=[{sessionId:'a',updatedAt:new Date(now-1000).toISOString()},{sessionId:'b',title:'Old',updatedAt:yesterday}]
 assert.equal(sessionDateGroup(rows[1],now),'昨天')
 const next=mergeSessionActivity(rows,{sessionId:'b',title:'Old',updatedAt:today})
 assert.equal(next[0].sessionId,'b');assert.equal(sessionDateGroup(next[0],now),'今天')
 assert.equal(rows[1].updatedAt,yesterday)
 assert.equal(mergeSessionActivity(next,{sessionId:'a'}),next,'opening a conversation is not activity')
 assert.equal(sessionDateGroup(next[0],now+86400000),'昨天','midnight reclassifies correctly')
})
test('stale snapshot cannot regress recent activity; owner scope stays isolated',()=>{
 const rows=[{sessionId:'same',ownerUsername:'Alice',updatedAt:today},{sessionId:'same',ownerUsername:'Bob',updatedAt:yesterday}]
 assert.equal(mergeSessionActivity(rows,{sessionId:'same',ownerUsername:'Alice',updatedAt:yesterday}),rows)
 const next=mergeSessionActivity(rows,{sessionId:'same',ownerUsername:'Bob',updatedAt:today})
 assert.equal(next.find(x=>x.ownerUsername==='Alice').updatedAt,today)
 assert.equal(next.find(x=>x.ownerUsername==='Bob').updatedAt,today)
 assert.equal(mergeSessionActivity(next,{sessionId:'unloaded',updatedAt:today}),next)
})
test('timestamp handles numeric values, invalid dates and createdAt fallback',()=>{
 assert.equal(sessionTimestamp({updatedAt:'bad',createdAt:today}),now)
 assert.equal(sessionTimestamp({updatedAt:now}),now)
 assert.equal(sessionDateGroup({},now),'更早')
})

test('new persisted rows are retained, deduplicated and sorted across later pages',()=>{
 const recent={sessionId:'new',title:'Generated title',updatedAt:today}
 let rows=mergeSessionActivity([{sessionId:'old',updatedAt:yesterday}],recent,{insert:true})
 assert.deepEqual(rows.map(r=>r.sessionId),['new','old'])
 rows=mergeSessionActivity(rows,{...recent,title:'Refined title'},{insert:true})
 assert.equal(rows.length,2);assert.equal(rows[0].title,'Refined title')
 rows=mergeSessionActivity([...rows,{sessionId:'other',updatedAt:today}],{sessionId:'old'})
 assert.deepEqual(rows.map(r=>r.sessionId),['new','other','old'])
 assert.equal(new Set(rows.map(r=>sessionDateGroup(r,now))).size,2)
})
