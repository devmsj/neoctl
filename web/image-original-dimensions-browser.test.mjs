import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const require=createRequire(import.meta.url)
let playwright
for (const location of [process.env.PLAYWRIGHT_CORE_PATH,'../desktop/.cache/ui-test/node_modules/playwright-core',join(tmpdir(),'neoctl-observability-tests/node_modules/playwright-core'),'playwright-core'].filter(Boolean)) {
  try { playwright=require(location); break } catch {}
}
if (!playwright) throw new Error('Installed playwright-core required; no dependency installation performed')
const module=await readFile(new URL('./src/image-original-dimensions.mjs',import.meta.url))
const hits=[]
const server=createServer((req,res)=>{
  hits.push(req.url)
  if(req.url==='/helper.mjs') { res.setHeader('Content-Type','text/javascript');res.end(module) }
  else if(req.url==='/') { res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>OBS10 isolated original decode test</title>') }
  else { res.writeHead(404);res.end('unavailable') }
})
await new Promise(r=>server.listen(0,'127.0.0.1',r))
let browser
try {
  browser=await playwright.chromium.launch({channel:'msedge',headless:true})
  const page=await browser.newPage()
  await page.goto(`http://127.0.0.1:${server.address().port}/`)
  const result=await page.evaluate(async()=>{
    const {createOriginalDimensions,originalDimensionFacts}=await import('/helper.mjs')
    const make=(w,h,mime)=>{const c=document.createElement('canvas');c.width=w;c.height=h;c.getContext('2d').fillRect(0,0,w,h);return c.toDataURL(mime)}
    const cache=createOriginalDimensions()
    cache.setSession('session-A')
    const urls=['image/png','image/jpeg','image/webp'].map((type,i)=>make(31+i,17+i,type))
    const thumb=new Image();thumb.src=make(2,1,'image/png');await thumb.decode();document.body.append(thumb)
    const results=await Promise.all(urls.map(originalUrl=>cache.load({sessionId:'session-A',originalUrl})))
    const broken=await cache.load({sessionId:'session-A',originalUrl:'data:image/png;base64,bm90YW5pbWFnZQ=='})
    const missing=await cache.load({sessionId:'session-A',originalUrl:location.origin+'/missing.png'})
    const unavailable=await cache.load({sessionId:'session-A',originalUrl:location.origin+'/must-not-fetch.png',available:false})
    const invalidated=await cache.load({sessionId:'session-A',originalUrl:urls[0],available:false})
    const pending=cache.load({sessionId:'session-A',originalUrl:make(700,333,'image/png')})
    cache.setSession('session-B')
    const stale=await pending
    const cross=await cache.load({sessionId:'session-B',originalUrl:urls[0]})
    const old=await cache.load({sessionId:'session-A',originalUrl:urls[0]})
    cache.clear()
    return {results,thumb:[thumb.naturalWidth,thumb.naturalHeight],broken,missing,unavailable,invalidated,stale,cross,old,auto:originalDimensionFacts('auto',results[0]),difference:originalDimensionFacts('1024x1024',results[0]),userAgent:navigator.userAgent}
  })
  assert.match(result.userAgent,/Edg\//)
  assert.deepEqual(result.thumb,[2,1])
  assert.deepEqual(result.results.map(x=>[x.state,x.width,x.height]),[['actual',31,17],['actual',32,18],['actual',33,19]])
  for(const key of ['broken','missing']) assert.equal(result[key].state,'unknown')
  for(const key of ['unavailable','invalidated']) assert.equal(result[key].state,'unavailable')
  for(const key of ['stale','old']) assert.equal(result[key].state,'stale')
  assert.equal(result.cross.sessionId,'session-B');assert.equal(result.cross.width,31)
  assert.equal(result.auto.mismatch,false);assert.equal(result.difference.mismatch,true)
  assert.equal(hits.includes('/must-not-fetch.png'),false)
  console.log('OBS10 actual Edge PASS: PNG/JPEG/WebP original vs thumbnail, multi-image, malformed/404/unavailable, cache invalidation, cross-session and late isolation, auto/mismatch')
} finally { await browser?.close();await new Promise(r=>server.close(r)) }
