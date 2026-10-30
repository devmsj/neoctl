'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const registry = require('../../src-tauri/src/registry-sources.cjs');
const semver = require('../../resources/node/node_modules/npm/node_modules/semver');
const manifest = (name, version, integrity = 'sha512-verified') => ({ name, version, dist: { integrity, tarball: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz` } });
function mockFetch({ mirrorVersion = '1.0.0', officialFail = false, mirrorIntegrity } = {}) {
  return async url => {
    if (officialFail && url.startsWith(registry.SOURCES[0].url)) throw Error('offline');
    const mirror = url.startsWith(registry.SOURCES[1].url);
    const value = url.endsWith('/latest') ? { ...manifest('neoctl-web', mirror ? mirrorVersion : '1.0.0', mirror ? mirrorIntegrity : undefined), dependencies: { neoctl: '2.0.0' } } : manifest('neoctl','2.0.0');
    return { ok: true, json: async () => value };
  };
}
test('only auto, official and the single mirror can be selected', () => {
  assert.equal(registry.preference(), 'auto');
  for (const value of ['auto','official','taobao']) assert.equal(registry.preference(value),value);
  for (const value of ['',null,'https://evil.test','cnpm']) assert.throws(()=>registry.preference(value));
  assert.deepEqual(registry.SOURCES.map(s=>s.url),['https://registry.npmjs.org','https://registry.npmmirror.com']);
  assert.equal(registry.SOURCES[1].label,'镜像源');
});
test('archive rewriting keeps scoped identity, SRI requirement and third-party boundary', () => {
  const pkg = {name:'@scope/package',version:'1.2.3',integrity:'sha512-test',resolved:'https://cdn.npmmirror.com/packages/package.tgz'};
  assert.equal(registry.archiveUrl(pkg,registry.SOURCES[0]),'https://registry.npmjs.org/@scope/package/-/package-1.2.3.tgz');
  const external={...pkg,resolved:'https://other.test/file.tgz'};
  assert.equal(registry.archiveUrl(external,registry.SOURCES[1]),external.resolved);
  assert.equal(registry.archiveUrl({...pkg,integrity:null},registry.SOURCES[0]),pkg.resolved);
});
test('probe counts transferred bytes including TTFB, caps payload and releases stream', async () => {
  let clock = 0, body, calls = 0;
  const fetch = async (url, options) => {
    calls++;
    if (!url.endsWith('.tgz')) return {ok:true,json:async()=>manifest('typescript','5.8.3')};
    assert.equal(options.headers.range,'bytes=0-65535');
    body=Readable.from((async function*(){clock=200;yield Buffer.alloc(40000);clock=400;yield Buffer.alloc(40000);yield Buffer.alloc(100000)})());
    return {status:206,body};
  };
  const result=await registry.probe(registry.SOURCES[0],fetch,{maxBytes:65536,now:()=>clock});
  assert.equal(result.bytes,65536);assert.equal(result.bytesPerSecond,163840);assert.equal(calls,2);assert.equal(body.destroyed,true);
});
test('probe does not reward empty or failed responses', async () => {
  const result=await registry.probe(registry.SOURCES[0],async url=>url.endsWith('.tgz')?{status:200,body:Readable.from([Buffer.alloc(2)])}:{ok:true,json:async()=>manifest('typescript','5.8.3')});
  assert.equal(result.bytesPerSecond,0);
  const failed=await registry.probe(registry.SOURCES[1],async()=>{throw Error('network')});assert.equal(failed.bytesPerSecond,0);
});
test('automatic ranking uses throughput; cache has TTL, network key and retry invalidation', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'neo-source-test-')),cacheFile=path.join(dir,'speed.json');
  let calls=0,clock=0;
  const fetch=async url=>{calls++;if(!url.endsWith('.tgz'))return{ok:true,json:async()=>manifest('typescript','5.8.3')};return{status:206,body:Readable.from((async function*(){clock+=100;yield Buffer.alloc(url.includes('npmmirror')?64000:33000)})())}};
  try {
    const opts={cacheFile,key:'network',now:1000,probeOptions:{now:()=>clock}};
    const first=await registry.rank(fetch,opts);assert.equal(first.sources[0].id,'taobao');
    const count=calls;assert.equal((await registry.rank(fetch,opts)).cached,true);assert.equal(calls,count);
    assert.equal((await registry.rank(fetch,{...opts,refresh:true})).cached,false);
    assert.equal((await registry.rank(fetch,{...opts,key:'changed'})).cached,false);
    assert.equal((await registry.rank(fetch,{...opts,now:1000+600001})).cached,false);
    const manual=await registry.rank(()=>{throw Error('must not probe')},{mode:'taobao'});assert.equal(manual.sources[0].id,'taobao');
  } finally {fs.rmSync(dir,{recursive:true,force:true})}
});
test('latest selection rejects stale mirrors and never downgrades', async () => {
  const selected=await registry.latestPair(mockFetch({mirrorVersion:'0.9.0'}),semver);
  assert.equal(selected.web.version,'1.0.0');assert.deepEqual(selected.available.map(x=>x.id),['official']);
  await assert.rejects(registry.latestPair(mockFetch({officialFail:true,mirrorVersion:'0.9.0'}),semver,{minimumWeb:'1.0.0'}),/尚未同步/);
});
test('official unreachable falls back; conflicting mirror SRI is excluded',async()=>{
  const fallback=await registry.latestPair(mockFetch({officialFail:true}),semver);assert.equal(fallback.source.id,'taobao');
  const pair=await registry.latestPair(mockFetch({mirrorIntegrity:'sha512-other'}),semver);assert.deepEqual(pair.available.map(x=>x.id),['official']);
  await assert.rejects(registry.latestPair(async()=>{throw Error('offline')},semver),/官方源.*镜像源/);
});
test('fallback retries the other source and reports total failure',async()=>{
  const attempted=[],changes=[];
  const result=await registry.fallback(registry.SOURCES,async s=>{attempted.push(s.id);if(s.id==='official')throw Error('failed');return 42},s=>changes.push(s.id));
  assert.equal(result.value,42);assert.deepEqual(attempted,['official','taobao']);assert.deepEqual(changes,['official']);
  await assert.rejects(registry.fallback(registry.SOURCES,()=>Promise.reject(Error('failed'))),/官方源.*镜像源/);
});
