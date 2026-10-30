'use strict';
// Embedded in both native helpers. Only these registries are selectable; no host npm config is read.
const neoRegistrySources = (() => {
  const SOURCES = Object.freeze([
    Object.freeze({ id: 'official', label: '官方源', url: 'https://registry.npmjs.org' }),
    Object.freeze({ id: 'taobao', label: '镜像源', url: 'https://registry.npmmirror.com' }),
  ]);
  const SAMPLE = '/typescript/5.8.3';
  const SAMPLE_BYTES = 768 * 1024, MIN_BYTES = 32 * 1024, CACHE_MS = 10 * 60 * 1000;
  function preference(value = 'auto') {
    if (!['auto', 'official', 'taobao'].includes(value)) throw Error('无效的软件源');
    return value;
  }
  function transport(npm) {
    const path = require('node:path');
    const fetch = require(path.join(path.dirname(npm), '..', 'node_modules', 'make-fetch-happen'));
    const env = Object.fromEntries(Object.entries(process.env).map(([k,v]) => [k.toUpperCase(),v]));
    return (url, opts = {}) => fetch(url, { strictSSL: true, retry: { retries: 0 },
      proxy: env.HTTPS_PROXY || env.HTTP_PROXY || env.ALL_PROXY, noProxy: env.NO_PROXY,
      ...opts });
  }
  async function json(fetch, url, timeout = 5000) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(url, { signal: controller.signal, timeout, cache: 'no-store', headers: { accept: 'application/json' } });
      if (!response.ok) throw Error(`HTTP ${response.status}`);
      return await response.json();
    } finally { clearTimeout(timer); }
  }
  function archiveUrl(pkg, source) {
    const url = new URL(pkg.resolved);
    // Never redirect arbitrary third-party URLs or unverified archives to a mirror.
    if (!['registry.npmjs.org', 'registry.npmmirror.com', 'cdn.npmmirror.com'].includes(url.hostname) || !pkg.integrity) return pkg.resolved;
    if (!/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(pkg.name || '') || !/^[0-9]+\.[0-9]+\.[0-9]+[a-z0-9.+-]*$/i.test(pkg.version || '')) return pkg.resolved;
    const basename = pkg.name.split('/').at(-1);
    return `${source.url}/${pkg.name}/-/${basename}-${pkg.version}.tgz`;
  }
  async function probe(source, fetch, { budgetMs = 4200, transferMs = 1400, maxBytes = SAMPLE_BYTES, minBytes = MIN_BYTES, now = () => performance.now() } = {}) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), budgetMs);
    let bytes = 0, started, transferTimer, body;
    try {
      const metadata = await json(fetch, source.url + SAMPLE, Math.min(1800, budgetMs));
      if (controller.signal.aborted) throw Error('测速超时');
      const resolved = metadata.dist?.tarball;
      const sample = archiveUrl({ name: 'typescript', version: '5.8.3', resolved, integrity: metadata.dist?.integrity }, source);
      if (new URL(sample).origin !== source.url) throw Error('测速地址无效');
      started = now();
      transferTimer = setTimeout(() => controller.abort(), Math.min(transferMs, budgetMs));
      const response = await fetch(sample, { signal: controller.signal, timeout: transferMs, cache: 'no-store',
        headers: { range: `bytes=0-${maxBytes - 1}`, 'accept-encoding': 'identity' } });
      if (![200, 206].includes(response.status)) throw Error(`HTTP ${response.status}`);
      body = response.body;
      for await (const chunk of body) { bytes += Math.min(chunk.length || chunk.byteLength, maxBytes - bytes); if (bytes >= maxBytes) break; }
    } catch (error) { if (started === undefined || bytes < minBytes) return { ...source, bytes, bytesPerSecond: 0, elapsedMs: started !== undefined ? now() - started : budgetMs }; }
    finally { clearTimeout(timer); clearTimeout(transferTimer); controller.abort(); body?.destroy?.(); }
    const elapsedMs = Math.max(1, now() - started);
    return { ...source, bytes, elapsedMs, bytesPerSecond: bytes >= minBytes ? Math.round(bytes * 1000 / elapsedMs) : 0 };
  }
  function networkKey() {
    const { createHash } = require('node:crypto'), os = require('node:os');
    const interfaces = Object.values(os.networkInterfaces()).flat().filter(x => x && !x.internal).map(x => `${x.family}:${x.address}`).sort();
    const proxies = Object.entries(process.env).filter(([k]) => /^(https?_proxy|all_proxy|no_proxy)$/i.test(k)).sort();
    return createHash('sha256').update(JSON.stringify([interfaces, proxies])).digest('hex');
  }
  async function rank(fetch, { mode = 'auto', cacheFile, refresh = false, key = networkKey(), now = Date.now(), probeOptions } = {}) {
    preference(mode);
    if (mode !== 'auto') return { sources: [...SOURCES].sort((a,b) => Number(b.id === mode) - Number(a.id === mode)), measurements: [], cached: false };
    const fs = require('node:fs');
    if (cacheFile && !refresh) {
      try {
        const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        if (c.schema === 1 && c.key === key && now >= c.at && now - c.at < CACHE_MS && c.order?.length === 2 && new Set(c.order).size === 2 && c.order.every(id => SOURCES.some(s => s.id === id))) {
          return { sources: c.order.map(id => SOURCES.find(s => s.id === id)), measurements: [], cached: true };
        }
      } catch { /* absent or stale cache is not an installation error */ }
    }
    const measurements = await Promise.all(SOURCES.map(source => probe(source, fetch, probeOptions)));
    const sources = [...measurements].sort((a,b) => b.bytesPerSecond - a.bytesPerSecond).map(x => SOURCES.find(s => s.id === x.id));
    if (cacheFile && measurements.some(x => x.bytesPerSecond > 0)) {
      try {
        const temp = cacheFile + '.' + process.pid + '.tmp';
        fs.writeFileSync(temp, JSON.stringify({ schema: 1, key, at: now, order: sources.map(s => s.id) }), { mode: 0o600 });
        fs.renameSync(temp, cacheFile);
      } catch { /* speed cache is best-effort and never changes npm config */ }
    }
    return { sources, measurements, cached: false };
  }
  function validManifest(manifest, name, semver) {
    if (manifest?.name !== name || !semver.valid(manifest.version) || !manifest.dist?.integrity || !/^https:\/\//.test(manifest.dist?.tarball || '')) throw Error('软件源返回无效的包信息');
    return manifest;
  }
  async function latestPair(fetch, semver, { sources = SOURCES, timeout = 5000, minimumWeb, minimumCore } = {}) {
    const results = await Promise.all(sources.map(async source => {
      try {
        const web = validManifest(await json(fetch, `${source.url}/neoctl-web/latest`, timeout), 'neoctl-web', semver);
        const requirement = web.dependencies?.neoctl;
        if (!requirement || !semver.validRange(requirement)) throw Error('最新 Web 未声明有效的 Core 版本范围');
        let core;
        if (semver.valid(requirement)) core = await json(fetch, `${source.url}/neoctl/${requirement}`, timeout);
        else {
          const metadata = await json(fetch, `${source.url}/neoctl`, timeout);
          const version = semver.maxSatisfying(Object.keys(metadata.versions || {}), requirement);
          if (!version) throw Error(`没有满足 ${requirement} 的 Core 版本`);
          core = metadata.versions[version];
        }
        validManifest(core, 'neoctl', semver);
        if (!semver.satisfies(core.version, requirement)) throw Error('Core 版本不兼容');
        if (semver.valid(minimumWeb) && semver.lt(web.version, minimumWeb)) throw Error('软件源尚未同步当前 Web 版本');
        if (semver.valid(minimumCore) && semver.lt(core.version, minimumCore)) throw Error('软件源尚未同步当前 Core 版本');
        return { source, web, core };
      } catch (error) { return { source, error: error.message }; }
    }));
    const good = results.filter(x => !x.error).sort((a,b) => semver.rcompare(a.web.version,b.web.version) || semver.rcompare(a.core.version,b.core.version));
    if (!good.length) throw Error(results.map(x => `${x.source.label}：${x.error}`).join('；'));
    const selected = good[0];
    // Official SRI is authoritative whenever both registries advertise the same version.
    const official = good.find(x => x.source.id === 'official' && x.web.version === selected.web.version && x.core.version === selected.core.version);
    return { ...(official || selected), available: good.filter(x => x.web.version === selected.web.version && x.core.version === selected.core.version && (!official || (x.web.dist.integrity === official.web.dist.integrity && x.core.dist.integrity === official.core.dist.integrity))).map(x => x.source) };
  }
  async function fallback(sources, operation, onFallback = () => {}) {
    const errors = [];
    for (const source of sources) {
      try { return { value: await operation(source), source }; }
      catch (error) { errors.push(`${source.label}：${error.message}`); if (sources.indexOf(source) < sources.length - 1) onFallback(source, error); }
    }
    throw Error(errors.join('；'));
  }
  return { SOURCES, preference, transport, json, archiveUrl, probe, rank, latestPair, fallback };
})();
if (typeof module !== 'undefined') module.exports = neoRegistrySources;
