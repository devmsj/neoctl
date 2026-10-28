import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { emptyAppearance, normalizeAppearance, derivePalette, contrast, assetReferences } from '../shared/appearance.mjs'
import { appearanceTokens } from '../src/appearance-tokens.mjs'
import { createAppearanceStore, createAppearanceRoute, fontExtension } from '../appearance-store.mjs'
import { validateImageBytes } from '../../engine/dist/core/image-input.js'
import { deflateSync } from 'node:zlib'
import { createHash } from 'node:crypto'
function crc32(b) { let n = 0xffffffff; for (const x of b) { n ^= x; for (let i=0;i<8;i++) n=(n>>>1)^((n&1)?0xedb88320:0) } return (n^0xffffffff)>>>0 }
function chunk(type, data) { const t=Buffer.from(type), n=Buffer.alloc(4), crc=Buffer.alloc(4); n.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([t,data]))); return Buffer.concat([n,t,data,crc]) }
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1,0);ihdr.writeUInt32BE(1,4);ihdr[8]=8;ihdr[9]=6
export const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(Buffer.from([0,240,100,160,255]))),chunk('IEND',Buffer.alloc(0))])

test('schema is versioned, strict and keeps independent day/night seeds', () => {
 const c=emptyAppearance();c.light.accent='#336699';c.dark.accent='#ffaa88'
 assert.deepEqual(normalizeAppearance(c),c)
 for(const bad of [{...c,version:2},{...c,light:{accent:'red'}},{...c,light:{uiFont:'x;url(https://x)'}},{...c,dark:{textSize:NaN}},{...c,dark:{css:'body{}'}},{...c,dark:{backgroundAsset:'../../x'}}]) assert.throws(()=>normalizeAppearance(bad))
 assert.deepEqual(appearanceTokens({},'dark'),{})
 const token=appearanceTokens({accent:'#222222',background:'#111111'},'dark')
 assert.ok(contrast(token['--appearance-accent'],'#111111')>=3)
 assert.equal(c.light.accent,'#336699')
})
test('message tint follows the accent unless explicitly customized', () => {
 for (const mode of ['light', 'dark']) {
  const tokens = appearanceTokens({ accent: '#247f78' }, mode)
  assert.ok(tokens['--appearance-user-bg'])
  assert.ok(contrast(tokens['--appearance-user-text'], tokens['--appearance-user-bg']) >= 4.5)
  const custom = appearanceTokens({ accent: '#247f78', userBackground: '#123456', userText: '#ffffff' }, mode)
  assert.equal(custom['--appearance-user-bg'], '#123456'); assert.equal(custom['--appearance-user-text'], '#ffffff')
 }
 assert.deepEqual(appearanceTokens({}, 'light'), {})
})
test('one seed derives contrasting semantic interaction colors', () => {
 for(const bg of ['#ffffff','#111418','#777777']) for(const seed of ['#000000','#ffffff','#ff00ff','#0000ff','#ffff00']) {
  const p=derivePalette(seed,bg)
  assert.ok(contrast(p.accent,bg)>=4.5)
  assert.ok(contrast(p.focus,bg)>=3)
  assert.ok(contrast(p.onSoft,p.soft)>=4.5)
 }
})
test('atomic persistence, reload, revision conflict and corrupt file preservation', async t => {
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'neo-appearance-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}))
 const store=createAppearanceStore(dir,{validateImage:validateImageBytes}), c=emptyAppearance()
 assert.equal((await store.read()).revision,'0');c.dark.accent='#ff77aa'
 const [one,two]=await Promise.allSettled([store.save(c,'0'),store.save(c,'0')])
 assert.equal(one.status,'fulfilled');assert.equal(two.reason.status,409)
 assert.deepEqual((await createAppearanceStore(dir).read()).config,c)
 assert.equal((await fs.readdir(dir)).filter(x=>x.endsWith('.tmp')).length,0)
 await fs.writeFile(path.join(dir,'settings.json'),'broken')
 await assert.rejects(store.read(),e=>e.status===500)
 await assert.rejects(store.save(c,one.value.revision),e=>e.status===500)
 assert.equal(await fs.readFile(path.join(dir,'settings.json'),'utf8'),'broken')
})
test('assets inspect real bytes, deduplicate, protect references and never cross users', async t => {
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'neo-assets-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}))
 const a=createAppearanceStore(path.join(dir,'a'),{validateImage:validateImageBytes}),b=createAppearanceStore(path.join(dir,'b'),{validateImage:validateImageBytes})
 const image=await a.upload(png,'background')
 assert.equal(image.id,createHash('sha256').update(png).digest('hex')+'.png')
 assert.equal((await a.upload(png,'background')).id,image.id)
 await assert.rejects(a.upload(Buffer.from('<html>fake png</html>'),'background'),e=>e.status===400)
 await assert.rejects(a.upload(Buffer.from('not font'),'font'),e=>e.status===400)
 await assert.rejects(b.asset(image.id),e=>e.status===404)
 await assert.rejects(a.asset('../settings.json'),e=>e.status===404)
 const c=emptyAppearance();c.dark.backgroundAsset=image.id
 assert.deepEqual(assetReferences(c),[image.id]);await a.save(c,'0')
 await assert.rejects(a.remove(image.id),e=>e.status===409)
 await assert.rejects(b.save(c,'0'),e=>e.status===404)
 const saved=await a.read();await a.save(emptyAppearance(),saved.revision);await a.remove(image.id)
 await assert.rejects(a.asset(image.id),e=>e.status===404)
})
test('font directory validation rejects truncated and out-of-range tables', () => {
 for(const s of ['wOFF','wOF2','OTTO']) { const b=Buffer.alloc(48);b.write(s); assert.throws(()=>fontExtension(b)) }
 const b=Buffer.alloc(32);b.writeUInt32BE(0x00010000);b.writeUInt16BE(1,4);b.writeUInt32BE(28,20);b.writeUInt32BE(4,24)
 assert.equal(fontExtension(b),'ttf');b.writeUInt32BE(999,20);assert.throws(()=>fontExtension(b))
})
test('HTTP enforces methods, revisions, content types and cross-site mutation boundary', async t => {
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'neo-appearance-http-'))
 const route=createAppearanceRoute(createAppearanceStore(dir,{validateImage:validateImageBytes}))
 const server=http.createServer((req,res)=>void route(req,res,new URL(req.url,'http://localhost')))
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{await new Promise(r=>server.close(r));await fs.rm(dir,{recursive:true,force:true})})
 const url='http://127.0.0.1:'+server.address().port+'/api/appearance'
 assert.equal((await fetch(url)).status,200)
 const put=origin=>fetch(url,{method:'PUT',headers:{'Content-Type':'application/json',...(origin?{Origin:origin}:{})},body:JSON.stringify({revision:'0',config:emptyAppearance()})})
 assert.equal((await put('https://attacker.invalid')).status,403)
 assert.equal((await put()).status,200);assert.equal((await put()).status,409)
 assert.equal((await fetch(url,{method:'POST'})).status,405)
 const res=await fetch(url+'/assets?kind=background',{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:png})
 assert.equal(res.status,201);const {id}=await res.json()
 const image=await fetch(url+'/assets/'+id)
 assert.equal(image.headers.get('Content-Type'),'image/png');assert.equal(image.headers.get('X-Content-Type-Options'),'nosniff')
 assert.deepEqual(Buffer.from(await image.arrayBuffer()),png)
})
