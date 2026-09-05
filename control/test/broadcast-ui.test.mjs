import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('../../desktop/.cache/ui-test/node_modules/playwright')); } catch { /* Optional local browser tooling; no installation. */ }
const root = new URL('../public/', import.meta.url);

test('broadcast ACK counts and reporting controls (browser stub)', { skip: !chromium, timeout: 45000 }, async () => {
  const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });
  try {
    const page = await browser.newPage();
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(() => sessionStorage.setItem('neo-control-token', 'stub-secret'));
    let state = { devices: [{ deviceId: 'd/1', name: '<img src=x onerror=alert(1)>', online: true }], profiles: [{ id: 'p1', name: '配置' }], sessions: [], broadcastProfileId: 'p1' };
    const broadcast = (id, status) => ({ id, profileId: 'p1', createdAt: 1700000000000, counts: { total: 1, pending: +(status === 'pending'), succeeded: +(status === 'succeeded'), superseded: +(status === 'superseded') }, clients: [{ deviceId: 'd/1', name: state.devices[0].name, online: false, status, acknowledgedAt: status === 'succeeded' ? 1700000001000 : null }] });
    state.broadcastStatus = broadcast('b1', 'pending');
    let fail = false, releasePatch, holdPatch = false, stateRequests = 0, active = 0, maxActive = 0;
    const payloads = [];
    await page.route('http://ui.test/**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/state') {
        stateRequests++; active++; maxActive = Math.max(maxActive, active);
        const body = JSON.stringify(state); await new Promise(r => setTimeout(r, 30)); active--;
        return route.fulfill({ contentType: 'application/json', body });
      }
      if (url.pathname.startsWith('/api/devices/')) {
        assert.equal(route.request().method(), 'PATCH'); assert.equal(url.pathname, '/api/devices/d%2F1');
        const body = route.request().postDataJSON(); payloads.push(body);
        if (holdPatch) await new Promise(r => { releasePatch = r; });
        if (fail) return route.fulfill({ status: 500, json: { error: 'stub failure' } });
        state.devices[0].reportingBlocked = body.reportingBlocked;
        return route.fulfill({ json: state.devices[0] });
      }
      if (url.pathname === '/api/broadcast') {
        state.broadcastStatus = broadcast('b2', 'pending'); return route.fulfill({ json: {} });
      }
      const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if (!['index.html', 'app.js', 'style.css'].includes(file)) return route.fulfill({ status: 404, body: '' });
      return route.fulfill({ contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html', body: await readFile(new URL(file, root), 'utf8') });
    });
    await page.goto('http://ui.test/');
    const waitText = (selector, value) => page.waitForFunction(([s, v]) => document.querySelector(s)?.textContent.includes(v), [selector, value]);
    const refresh = async () => { const n = stateRequests; await page.locator('#refresh-button').click(); await page.waitForFunction(() => !document.querySelector('#refresh-button').disabled); assert.ok(stateRequests > n); };
    await waitText('#broadcast-summary', '成功 0 · 待确认 1');
    assert.match(await page.locator('#broadcast-clients').innerText(), /离线/);
    assert.equal(await page.locator('#broadcast-clients img').count(), 0);
    assert.equal(await page.locator('#device-rows img').count(), 0);
    const initial = stateRequests;
    state.broadcastStatus = broadcast('b1', 'succeeded');
    await waitText('#broadcast-summary', '成功 1 · 待确认 0');
    assert.ok(stateRequests > initial); assert.match(await page.locator('.broadcast-time').innerText(), /2023/);
    state.broadcastStatus = broadcast('b1', 'superseded'); await refresh();
    await waitText('#broadcast-summary', '成功 0 · 待确认 0 · 被定向覆盖 1');
    state.broadcastStatus = broadcast('b1', 'succeeded'); await refresh();
    page.on('dialog', dialog => dialog.accept());
    await page.locator('#broadcast-profile').selectOption('p1'); await page.locator('#broadcast-button').click();
    await waitText('#broadcast-meta', 'b2'); await waitText('#broadcast-summary', '成功 0 · 待确认 1');
    delete state.broadcastStatus; await refresh();
    assert.equal(await page.locator('#broadcast-details').isVisible(), false);
    assert.equal(await page.locator('#broadcast-clients li').count(), 0);
    await waitText('#broadcast-empty', '无法确认成功数量');
    state.broadcastStatus = null; state.broadcastProfileId = null; await refresh(); await waitText('#broadcast-empty', '暂无当前广播');
    await page.locator('#device-rows input[type=checkbox]').check();
    await page.locator('#profile-name').fill('未保存输入');
    holdPatch = true;
    await page.getByRole('button', { name: '暂停上报', exact: true }).click();
    await page.waitForTimeout(100);
    assert.equal(await page.getByRole('button', { name: '暂停上报', exact: true }).isDisabled(), true);
    await refresh();
    assert.equal(await page.getByRole('button', { name: '暂停上报', exact: true }).isDisabled(), true);
    holdPatch = false; releasePatch();
    await waitText('#device-rows', '会话上报已暂停');
    await page.getByRole('button', { name: '恢复上报', exact: true }).click(); await waitText('#device-rows', '会话上报正常');
    fail = true;
    await page.getByRole('button', { name: '暂停上报', exact: true }).click(); await waitText('#global-error-text', '上报设置失败');
    assert.equal(await page.getByRole('button', { name: '暂停上报', exact: true }).isEnabled(), true);
    assert.match(await page.locator('#device-rows').innerText(), /会话上报正常/);
    assert.deepEqual(payloads, [{ reportingBlocked: true }, { reportingBlocked: false }, { reportingBlocked: true }]);
    assert.equal(await page.locator('#device-rows input[type=checkbox]').isChecked(), true);
    assert.equal(await page.locator('#profile-name').inputValue(), '未保存输入');
    assert.equal(await page.getByRole('button', { name: '备注', exact: true }).count(), 1);
    assert.equal(await page.getByRole('button', { name: '移除', exact: true }).count(), 1);
    assert.equal(maxActive, 1); assert.deepEqual(errors, []);
    assert.equal((await page.locator('body').innerText()).includes('stub-secret'), false);
  } finally { await browser.close(); }
});

test('UI avoids HTML injection sinks and interval polling', async () => {
  const source = await readFile(new URL('app.js', root), 'utf8');
  assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|setInterval/);
  assert.match(source, /document.hidden \? 30000/);
});
