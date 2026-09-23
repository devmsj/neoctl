import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createLocalResourceHeaders } from '../local-resources.mjs';
import { createWebPluginHost } from '../plugins.mjs';
import { isDesktop, resourceActionTitle, revealResource } from '../src/local-resources.mjs';

const origin = 'http://127.0.0.1:45123';
function desktop() {
  const calls = [];
  return { calls, scope: { location: { origin }, __TAURI__: { core: { invoke: async (...args) => { calls.push(args); } } } } };
}
const headersFor = (overrides = {}) => ({ method: 'HEAD', headers: { 'x-neo-resource-action': 'reveal', host: '127.0.0.1:45123' }, socket: { remoteAddress: '127.0.0.1' }, ...overrides });

test('host disclosure is opt-in, HEAD-only, loopback-only and origin checked', () => {
  const path = 'C:\\用户\\报告 [1].txt';
  const enabled = createLocalResourceHeaders({ enabled: true });
  assert.deepEqual(createLocalResourceHeaders()(headersFor(), path), {});
  assert.equal(decodeURIComponent(enabled(headersFor(), path)['X-Neo-Resource-Path']), path);
  for (const req of [
    headersFor({ method: 'GET' }), headersFor({ headers: {} }),
    headersFor({ socket: { remoteAddress: '10.0.0.1' } }),
    headersFor({ headers: { ...headersFor().headers, 'sec-fetch-site': 'cross-site' } }),
    headersFor({ headers: { ...headersFor().headers, origin: 'http://evil.test' } }),
    headersFor({ headers: { ...headersFor().headers, origin: 'invalid' } }),
  ]) assert.deepEqual(enabled(req, path), {});
});

test('generic helper follows optional plugin routing; absent or disabled plugin has no native action', async () => {
  const req = headersFor(), url = new URL('/unrelated-plugin/item', origin);
  let routed = 0;
  const helper = createLocalResourceHeaders({ enabled: true });
  const plugin = { id: 'unrelated', name: 'Unrelated', version: '1', route(_req, _res, _url, helpers) {
    routed++;
    assert.equal(helpers.localResourceHeaders, helper);
    return true;
  } };
  for (const host of [createWebPluginHost(), createWebPluginHost({ plugins: [plugin], enabled: 'none' })]) {
    assert.equal(await host.route(req, {}, url, { localResourceHeaders: helper }), false);
  }
  assert.equal(routed, 0);
  assert.equal(await createWebPluginHost({ plugins: [plugin] }).route(req, {}, url, { localResourceHeaders: helper }), true);
  assert.equal(routed, 1);
});

test('browser mode preserves download behavior without probing native capabilities', async () => {
  const scope = { location: { origin } };
  assert.equal(isDesktop(scope), false);
  assert.equal(resourceActionTitle('报告', scope), '下载 报告');
  assert.equal(await revealResource('/anything', { scope, fetch: () => assert.fail('no probe in browser') }), false);
});

test('desktop negotiates an arbitrary plugin URL with HEAD and reveals original path without GET/blob', async () => {
  const { scope, calls } = desktop();
  const file = 'C:\\用户\\原文件 [a],b.txt';
  assert.equal(resourceActionTitle('报告', scope), '在所在文件夹中显示 报告');
  assert.equal(await revealResource('/custom-plugin/resources/any-id?token=abc', { scope, fetch: async (url, init) => {
    assert.equal(url, origin + '/custom-plugin/resources/any-id?token=abc');
    assert.equal(init.method, 'HEAD');
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers['X-Neo-Resource-Action'], 'reveal');
    return new Response(null, { headers: { 'X-Neo-Resource-Path': encodeURIComponent(file) } });
  } }), true);
  assert.deepEqual(calls, [['plugin:local-resources|reveal_file', { path: file }]]);
});

test('missing plugin, deleted file, unsupported resource and malformed path never fall back to downloading', async () => {
  for (const response of [new Response(null, { status: 404 }), new Response(null, { status: 410 }), new Response(null, { status: 500 }), new Response(null), new Response(null, { headers: { 'X-Neo-Resource-Path': '%' } }), new Response(null, { headers: { 'X-Neo-Resource-Path': '%00' } })]) {
    const { scope, calls } = desktop();
    let requests = 0;
    await assert.rejects(revealResource('/optional-resource', { scope, fetch: async (_url, init) => { requests++; assert.equal(init.method, 'HEAD'); return response; } }));
    assert.equal(requests, 1); assert.deepEqual(calls, []);
  }
});

test('other origins and redirects cannot supply a native file path', async () => {
  const { scope, calls } = desktop();
  for (const url of ['https://example.com/file', 'http://127.0.0.1:45124/file', 'http://user@127.0.0.1:45123/file']) {
    await assert.rejects(revealResource(url, { scope, fetch: () => assert.fail('cross-origin fetch') }));
  }
  await assert.rejects(revealResource('/redirect', { scope, fetch: async (_url, init) => { assert.equal(init.redirect, 'error'); throw new TypeError('redirect'); } }));
  assert.deepEqual(calls, []);
});

test('native failures propagate without a second network request or download fallback', async () => {
  const { scope } = desktop();
  scope.__TAURI__.core.invoke = async () => { throw new Error('native error'); };
  let requests = 0;
  await assert.rejects(revealResource('/resource', { scope, fetch: async () => { requests++; return new Response(null, { headers: { 'X-Neo-Resource-Path': 'C%3A%5Cfile' } }); } }), /native error/);
  assert.equal(requests, 1);
});

test('static, streaming and tool-result links share desktop titles; click branches before download', () => {
  const app = readFileSync(new URL('../src/App.vue', import.meta.url), 'utf8');
  const streaming = readFileSync(new URL('../src/components/StreamingMarkdown.vue', import.meta.url), 'utf8');
  assert.match(streaming, /resourceActionTitle\(resource.label \|\| resource.downloadName\)/);
  assert.match(app, /title="\$\{escapeHtml\(resourceActionTitle/);
  const handler = app.slice(app.indexOf('async function handleDocumentResourceClick'), app.indexOf('function openImagePreview'));
  assert.ok(handler.indexOf('await revealResource') < handler.indexOf('await appFetch(anchor.href)'));
  assert.match(handler, /return \/\/ Never silently download/);
});
