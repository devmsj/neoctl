import test from 'node:test'
import assert from 'node:assert/strict'
import { appearanceDraftStore } from '../src/appearance-draft.mjs'
import { emptyAppearance } from '../shared/appearance.mjs'
import { authState } from '../src/auth-state.mjs'
test('drafts are separate, validated, scoped and recoverable; quota failure is reported',()=>{
 const map=new Map(),storage={getItem:k=>map.get(k),setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k)}
 const c=emptyAppearance();c.dark.accent='#abcdef'
 try {
  authState.isolation=true;authState.user={username:'one'};const one=appearanceDraftStore(storage)
  assert.equal(one.write(c,'17','dark'),true);assert.deepEqual(one.read(),{config:c,revision:'17',editing:'dark'})
  authState.user={username:'two'};assert.equal(appearanceDraftStore(storage).read(),null)
  one.clear();assert.equal(one.read(),null)
  assert.equal(appearanceDraftStore({setItem(){throw Error('quota')}}).write(c,'1','dark'),false)
  assert.equal(appearanceDraftStore({getItem:()=>'{broken'}).read(),null)
 }finally{authState.isolation=false;authState.user=null}
})
