import assert from 'node:assert/strict'
import { createOriginalDimensions, originalDimensionFacts } from './src/image-original-dimensions.mjs'
const images = []
const cache = createOriginalDimensions({ maxEntries: 2, timeoutMs: 30, createImage() {
  let resolve, reject
  const promise = new Promise((a,b) => { resolve=a; reject=b })
  const image = { src:'', naturalWidth:7, naturalHeight:3, decode:()=>promise, resolve, reject }
  images.push(image); return image
} })
const load = url => cache.load({sessionId:'a',originalUrl:url})
cache.setSession('a')
const first=load('original'); assert.equal(load('original'),first); assert.equal(images.length,1)
images[0].resolve(); const actual=await first
assert.equal(actual.width,7)
assert.equal(originalDimensionFacts('auto',actual).mismatch,false)
assert.equal(originalDimensionFacts('1024x1024',actual).mismatch,true)
assert.equal(originalDimensionFacts('7x3',actual).mismatch,false)
assert.equal(originalDimensionFacts('auto',actual).requested,'auto（自动策略）')
assert.equal((await cache.load({sessionId:'a',originalUrl:'original',available:false})).state,'unavailable')
assert.equal(cache.size,0)
const old=load('slow'); cache.setSession('b'); assert.equal((await old).state,'stale')
images[1].resolve(); assert.equal((await load('late-old-session')).state,'stale')
cache.setSession('a')
const evicted=load('one'); const two=load('two'); const three=load('three')
assert.equal(cache.size,2); assert.equal((await evicted).state,'stale')
images[3].reject(new Error('bad')); assert.equal((await two).state,'unknown')
images[4].naturalWidth=0; images[4].resolve(); assert.equal((await three).state,'unknown')
cache.clear()
assert.equal((await load('timeout')).state,'unknown')
cache.invalidate('timeout'); assert.equal(cache.size,0)
assert.deepEqual(originalDimensionFacts('1024x1024',{state:'unknown'}),{requested:'1024x1024',actual:'未知',mismatch:false})
cache.clear()
console.log('OBS10 helper unit PASS: dedupe, LRU cap, late isolation, unavailable, invalid pixels, timeout, auto/mismatch')
