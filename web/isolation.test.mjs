import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { hashPassword, loadIsolationConfig, validUsername } from './isolation-auth.mjs';
import { createIsolationMode, sanitizeIsolatedSnapshot } from './isolation.mjs';

process.env.NEO_CORE_SOURCE = 'local';
process.env.NEO_WEB_PLUGINS = 'none';
process.env.NEO_EXECUTION_BACKEND = 'local';

async function fixture(t, enabled = true, configOverrides = {}, plugins = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'neo-isolation-'));
  const configFile = path.join(root, 'isolation.json');
  const passwordHash = await hashPassword('test-password-only');
  await fs.writeFile(configFile, JSON.stringify({ enabled, users: [{ username: 'Alice', passwordHash }, { username: 'Bob', passwordHash }, { username: 'Admin', passwordHash, role: 'admin' }], ...configOverrides }));
  let mode;
  let cpaConfig = { url: '', password: '' };
  const cpaQuotaMonitor = {
    getPublicState: () => ({ config: { url: cpaConfig.url, hasPassword: !!cpaConfig.password }, quotas: cpaConfig.url && cpaConfig.password ? [{ account: 'shared', remainingPercent: 75 }] : [] }),
    async updateConfig(next) { cpaConfig = { url: next.url || '', password: next.password === undefined ? cpaConfig.password : next.password }; return this.getPublicState(); },
  };
  const start = async () => {
    mode = await createIsolationMode({ dataRoot: root, workspaceRoot: path.join(root, 'work'), pluginDir: plugins ? fileURLToPath(new URL('./plugins', import.meta.url)) : path.join(root, 'no-plugins'), configFile, cpaQuotaMonitor, memoryState: () => ({ current: { rss: 123456, heapUsed: 1234 }, history: [{ rss: 123456, heapUsed: 1234 }] }) });
    return mode;
  };
  await start();
  const server = http.createServer((req, res) => {
    void mode.route(req, res, new URL(req.url, 'http://localhost')).then(handled => { if (!handled) { res.writeHead(204); res.end(); } });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (url, cookie = '', body, extra = {}) => fetch(base + url, {
    method: body === undefined ? 'GET' : 'POST', headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...extra.headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}), ...extra,
  });
  const login = async username => {
    const result = await request('/api/auth/login', '', { username, password: 'test-password-only' });
    assert.equal(result.status, 200);
    assert.match(result.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
    return result.headers.get('set-cookie').split(';')[0];
  };
  t.after(async () => { mode.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(root, { recursive: true, force: true }); });
  return { root, request, login, restart: async () => { mode.close(); await start(); } };
}

test('disabled defaults preserve unauthenticated legacy routes; invalid configs fail closed', async t => {
  const f = await fixture(t, false);
  assert.deepEqual(await (await f.request('/api/auth/status')).json(), { isolation: false, user: null });
  assert.equal((await f.request('/api/state')).status, 204);
  await fs.writeFile(path.join(f.root, 'bad.json'), '{');
  await assert.rejects(loadIsolationConfig(f.root, path.join(f.root, 'bad.json')));
  await assert.rejects(loadIsolationConfig(f.root, path.join(f.root, 'missing.json')));
  assert.deepEqual(await loadIsolationConfig(path.join(f.root, 'missing-default')), { enabled: false });
});

test('username is the only account identifier and is safe as a data directory', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'neo-isolation-config-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const passwordHash = await hashPassword('test-password-only');
  const configFile = path.join(root, 'isolation.json');
  await fs.writeFile(configFile, JSON.stringify({ enabled: true, users: [{ username: '中文 用户', passwordHash }] }));
  const config = await loadIsolationConfig(root, configFile);
  assert.deepEqual(config.users.map(({ username, role }) => ({ username, role })), [{ username: '中文 用户', role: undefined }]);
  assert.equal(config.users[0].id, undefined);
  assert.equal(validUsername('name.'), false);
  assert.equal(validUsername('../name'), false);
  await fs.writeFile(configFile, JSON.stringify({ enabled: true, users: [{ username: 'Alice', passwordHash }, { username: 'alice', passwordHash }] }));
  await assert.rejects(loadIsolationConfig(root, configFile), /重复/);
  await fs.writeFile(configFile, JSON.stringify({ enabled: true, users: [{ id: 'old', username: 'Alice', passwordHash }] }));
  await assert.rejects(loadIsolationConfig(root, configFile), /迁移/);
});

test('admin manages regular accounts and reads all owners without an extra write restriction', async t => {
  const f = await fixture(t), admin = await f.login('Admin'), alice = await f.login('Alice'), bob = await f.login('Bob');
  assert.equal((await (await f.request('/api/auth/status', admin)).json()).user.role, 'admin');
  assert.equal((await (await f.request('/api/auth/status', alice)).json()).user.role, 'user');
  for (const route of ['/api/admin/users', '/api/admin/sessions']) assert.equal((await f.request(route, alice)).status, 403);
  assert.equal((await f.request('/api/admin/users', alice, { username: 'Evil', password: 'test-password-only' })).status, 403);
  assert.equal((await f.request('/api/admin/users/delete', alice, { username: 'Bob' })).status, 403);
  const ids = {};
  for (const [username, cookie] of [['Alice', alice], ['Bob', bob]]) {
    const state = await (await f.request('/api/state?tabId=shared', cookie)).json();
    ids[username] = state.session.sessionId;
    await fs.appendFile(path.join(f.root, 'isolated-users', username, 'sessions', ids[username], 'transcript.jsonl'), JSON.stringify({ type: 'title', sessionId: ids[username], agentId: 'main', title: username, createdAt: new Date().toISOString() }) + '\n');
  }
  const listing = await (await f.request('/api/admin/sessions', admin)).json();
  for (const username of ['Alice', 'Bob']) assert.ok(listing.groups.find(group => group.user.username === username).sessions.some(session => session.sessionId === ids[username]));
  const viewed = await (await f.request(`/api/state?ownerUsername=Bob&sessionId=${ids.Bob}`, admin)).json();
  assert.equal(viewed.session.sessionId, ids.Bob);
  assert.equal((await f.request(`/api/fast-mode?ownerUsername=Bob&sessionId=${ids.Bob}`, admin, { enabled: true })).status, 200);
  assert.equal((await f.request(`/api/state?ownerUsername=Bob&sessionId=${ids.Bob}`, alice)).status, 403);
  assert.equal((await f.request(`/api/state?ownerUsername=Alice&sessionId=${ids.Bob}`, admin)).status, 404);
  assert.equal((await f.request('/api/state?ownerUsername=Bob&ownerUsername=Alice', admin)).status, 400);
  assert.equal((await f.request('/api/admin/users', admin, { username: 'New', password: 'test-password-only', role: 'admin' })).status, 400);
  const created = await f.request('/api/admin/users', admin, { username: 'New', password: 'test-password-only' });
  assert.equal(created.status, 201);
  assert.deepEqual((await created.json()).user, { username: 'New', role: 'user' });
  const newCookie = await f.login('New');
  assert.equal((await f.request('/api/admin/users/delete', admin, { username: 'Admin' })).status, 403);
  const duplicate = { username: 'Race', password: 'test-password-only' };
  assert.deepEqual((await Promise.all([f.request('/api/admin/users', admin, duplicate), f.request('/api/admin/users', admin, duplicate)])).map(r => r.status).sort(), [201, 409]);
  assert.equal((await f.request('/api/admin/users/delete', admin, { username: 'New' })).status, 200);
  assert.equal((await f.request('/api/state', newCookie)).status, 401);
  assert.equal((await f.request('/api/admin/users', admin, { username: 'new', password: 'test-password-only' })).status, 409);
  assert.equal((await f.request('/api/admin/users/delete', admin, { username: 'Bob' })).status, 200);
  assert.equal((await f.request(`/api/state?ownerUsername=Bob&sessionId=${ids.Bob}`, admin)).status, 200);
  const disk = await fs.readFile(path.join(f.root, 'isolation.json'), 'utf8');
  assert.ok(!disk.includes('test-password-only'));
  assert.ok(!JSON.stringify(await (await f.request('/api/admin/users', admin)).json()).includes('passwordHash'));
  await f.restart();
  const nextAdmin = await f.login('Admin');
  assert.equal((await f.request(`/api/state?ownerUsername=Bob&sessionId=${ids.Bob}`, nextAdmin)).status, 200);
  assert.equal((await f.request('/api/auth/login', '', { username: 'New', password: 'test-password-only' })).status, 401);
});

test('login, bad password, forged identity, CSRF and logout', async t => {
  const f = await fixture(t);
  for (const route of ['/api/state', '/events', '/api/sessions', '/api/uploads/test', '/api/downloads/test']) assert.equal((await f.request(route)).status, 401);
  assert.equal((await f.request('/api/auth/login', '', { username: 'Alice', password: 'wrong' })).status, 401);
  assert.equal((await f.request('/api/auth/login', '', { username: 'missing', password: 'wrong' })).status, 401);
  assert.equal((await f.request('/api/auth/login', '', { username: 'Alice', password: 'test-password-only' }, { headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await f.request('/api/state', 'neo_isolation=' + 'a'.repeat(64), undefined, { headers: { 'x-user-id': 'alice' } })).status, 401);
  const cookie = await f.login('Alice');
  assert.deepEqual((await (await f.request('/api/auth/status', cookie)).json()).user, { username: 'Alice', role: 'user' });
  assert.equal((await f.request('/api/auth/logout', cookie, {})).status, 200);
  assert.equal((await f.request('/api/state', cookie)).status, 401);
});

test('users cannot list, resume, delete or subscribe to another user session, even using identical tab IDs', async t => {
  const f = await fixture(t), a = await f.login('Alice'), b = await f.login('Bob');
  const stateA = await (await f.request('/api/state?tabId=shared', a)).json();
  const stateB = await (await f.request('/api/state?tabId=shared', b)).json();
  assert.ok(stateA.session?.sessionId, JSON.stringify(stateA));
  assert.ok(stateB.session?.sessionId, JSON.stringify(stateB));
  const idA = stateA.session.sessionId, idB = stateB.session.sessionId;
  assert.notEqual(idA, idB);
  // Empty sessions are intentionally absent from the existing core history list.
  for (const [user, id] of [['Alice', idA], ['Bob', idB]]) {
    await fs.writeFile(path.join(f.root, 'isolated-users', user, 'sessions', id, 'transcript.jsonl'), JSON.stringify({ type: 'title', sessionId: id, agentId: 'main', title: user, createdAt: new Date().toISOString() }) + '\n');
  }
  const listA = await (await f.request('/api/sessions?tabId=shared', a)).json();
  const listB = await (await f.request('/api/sessions?tabId=shared', b)).json();
  assert.deepEqual(listA.sessions.map(s => s.sessionId), [idA]);
  assert.deepEqual(listB.sessions.map(s => s.sessionId), [idB]);
  for (const route of ['/api/state', '/api/runtime-context', '/events', '/api/tool-call-detail', '/api/terminal-output', '/api/agent-content', '/api/images/by-id/anything']) {
    assert.equal((await f.request(`${route}?sessionId=${idA}&tabId=shared`, b)).status, 404, route);
  }
  for (const route of ['/api/sessions/resume', '/api/sessions/delete']) assert.equal((await f.request(route + '?tabId=shared', b, { sessionId: idA })).status, 404);
  assert.equal((await f.request('/api/state?sessionId=latest', b)).status, 404);
  assert.equal((await f.request(`/api/state?sessionId=${idB}&sessionId=${idA}`, b)).status, 400);
  assert.equal((await f.request('/api/state?sessionId=..%2F..%2Fother', b)).status, 400);
  assert.equal(stateA.interactive.login, undefined);
  for (const route of ['/api/prompt-library', '/api/prompt-config', '/api/session-prompt', '/api/app-prompt', '/api/login', '/api/unknown']) assert.equal((await f.request(route, a)).status, 403, route);
  for (const text of ['/secret get key', '/env', '/log /tmp', '/export /tmp/leak', '/model different']) assert.equal((await f.request('/api/submit?tabId=shared', a, { text })).status, 403);
  await f.restart();
  assert.equal((await f.request('/api/state', a)).status, 401);
  const a2 = await f.login('Alice');
  const resumed = await (await f.request(`/api/state?sessionId=${idA}`, a2)).json();
  assert.equal(resumed.session.sessionId, idA);
  assert.equal((await f.request(`/api/state?sessionId=${idB}`, a2)).status, 404);
});

test('memory is authenticated and admin model settings reach existing, new and restored runtimes', async t => {
  const previousEnv = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
    Object.assign(process.env, previousEnv);
  });
  const f = await fixture(t);
  process.env.NEO_ENV_FILE = path.join(f.root, 'model.env');
  await fs.writeFile(process.env.NEO_ENV_FILE, 'MODEL_PROVIDER=openai\nOPENAI_API_KEY=test-key-only\nOPENAI_MODEL=model-before\n');
  const admin = await f.login('Admin'), alice = await f.login('Alice'), bob = await f.login('Bob');
  for (const route of ['/api/memory', '/api/login']) assert.equal((await f.request(route)).status, 401);
  for (const cookie of [alice, admin]) assert.equal((await (await f.request('/api/memory', cookie)).json()).current.rss, 123456);
  assert.equal((await f.request('/api/login', alice)).status, 403);
  assert.equal((await f.request('/api/login', alice, { provider: 'openai', values: {} })).status, 403);
  for (const route of ['/api/prompt-config', '/api/cpa-config', '/api/tools/global', '/api/plugins/global']) assert.equal((await f.request(route, alice, {})).status, 403);
  const before = await (await f.request('/api/state?tabId=existing', alice)).json();
  await f.request('/api/state?tabId=existing', bob);
  const form = await (await f.request('/api/login?ownerUsername=missing&sessionId=missing', admin)).json();
  assert.equal(form.envPath, undefined);
  assert.equal(form.values.model, 'model-before');
  const save = model => f.request('/api/login?ownerUsername=missing', admin, { provider: form.provider, values: { ...form.values, model } });
  assert.equal((await (await save('model-after')).json()).ok, true);
  for (const cookie of [alice, bob]) {
    for (const tab of ['existing', 'new']) {
      const state = await (await f.request('/api/state?tabId=' + tab, cookie)).json();
      assert.equal(state.modelSettings.model, 'model-after');
      assert.ok(!JSON.stringify(state).includes('test-key-only'));
    }
  }
  const concurrent = await Promise.all([save('model-second'), save('model-final'), f.request('/api/state?tabId=racing', bob)]);
  assert.ok(concurrent.every(response => response.status === 200));
  assert.equal((await (await f.request('/api/state?tabId=racing', bob)).json()).modelSettings.model, 'model-final');
  await f.restart();
  const nextAlice = await f.login('Alice');
  assert.equal((await (await f.request(`/api/state?sessionId=${before.session.sessionId}`, nextAlice)).json()).modelSettings.model, 'model-final');
  assert.match(await fs.readFile(process.env.NEO_ENV_FILE, 'utf8'), /OPENAI_MODEL=model-final/);
});

test('admin full settings are global; regular users only read shared quota', async t => {
  const previousEnv = { ...process.env };
  t.after(() => { for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key]; Object.assign(process.env, previousEnv); });
  delete process.env.NEO_WEB_PLUGINS;
  const f = await fixture(t, true, {}, true);
  process.env.NEO_SYSTEM_PROMPT_PATH = path.join(f.root, 'system.md');
  const admin = await f.login('Admin'), alice = await f.login('Alice'), bob = await f.login('Bob');
  const globalQuery = '?ownerUsername=missing&sessionId=missing';
  assert.equal((await f.request('/api/cpa-quota')).status, 401);
  assert.deepEqual((await (await f.request('/api/cpa-quota', alice)).json()).quotas, []);
  assert.equal((await (await f.request('/api/cpa-config' + globalQuery, admin, { url: 'http://cpa.test', password: 'test-cpa-secret' })).json()).ok, true);
  await f.request('/api/cpa-config', admin, { url: 'http://cpa.test', preservePassword: true });
  for (const cookie of [alice, bob, admin]) {
    const quota = await (await f.request('/api/cpa-quota' + (cookie === admin ? globalQuery : ''), cookie)).json();
    assert.equal(quota.quotas[0].remainingPercent, 75);
    assert.ok(!JSON.stringify(quota).includes('test-cpa-secret'));
    if (cookie !== admin) assert.equal(quota.config, undefined);
  }
  const prompt = await (await f.request('/api/prompt-config' + globalQuery, admin)).json();
  assert.equal((await (await f.request('/api/prompt-config', admin, { content: 'shared test prompt', revision: prompt.revision })).json()).ok, true);
  assert.equal((await (await f.request('/api/prompt-config', admin)).json()).content, 'shared test prompt');
  await f.request('/api/state?tabId=existing', alice);
  await f.request('/api/state?tabId=existing', bob);
  const tools = await (await f.request('/api/tools' + globalQuery, admin)).json();
  const tool = tools.items.find(item => item.source === 'builtin').name;
  assert.equal((await (await f.request('/api/tools/global' + globalQuery, admin, { overrides: { [tool]: false } })).json()).ok, true);
  for (const cookie of [alice, bob]) for (const tab of ['existing', 'new']) {
    const state = await (await f.request('/api/session-tools?tabId=' + tab, cookie)).json();
    assert.equal(state.items.find(item => item.name === tool).globallyEnabled, false);
  }
  const plugins = await (await f.request('/api/plugins' + globalQuery, admin)).json();
  assert.equal(plugins.locked, false);
  assert.ok(plugins.items.length > 0);
  assert.equal((await (await f.request('/api/plugins/global' + globalQuery, admin, { enabledIds: [] })).json()).restartRequired, true);
  await f.restart();
  const nextAdmin = await f.login('Admin'), nextAlice = await f.login('Alice');
  assert.ok((await (await f.request('/api/plugins', nextAdmin)).json()).items.every(item => !item.enabled));
  const restoredTools = await (await f.request('/api/session-tools', nextAlice)).json();
  assert.equal(restoredTools.items.find(item => item.name === tool).globallyEnabled, false);
});

test('uploads and unfinished chunks are private to their user', async t => {
  const f = await fixture(t), a = await f.login('Alice'), b = await f.login('Bob');
  const uploaded = await (await f.request('/api/uploads?tabId=upload', a, { name: 'private.txt', data: Buffer.from('private file').toString('base64') })).json();
  assert.ok(uploaded.file, JSON.stringify(uploaded));
  assert.equal(await (await f.request(uploaded.file.url, a)).text(), 'private file');
  assert.equal((await f.request(uploaded.file.url, b)).status, 404);
  const chunk = await (await f.request('/api/uploads/chunks', a, { name: 'empty.txt', size: 0 })).json();
  assert.equal((await f.request('/api/uploads/chunks/' + chunk.uploadId, b)).status, 404);
  const completed = await (await f.request('/api/uploads/chunks/' + chunk.uploadId + '/complete', a, {})).json();
  assert.ok(completed.file);
  assert.equal((await f.request('/api/submit?tabId=upload', b, { text: 'test', attachments: [{ kind: 'file', absolutePath: uploaded.file.absolutePath }] })).status, 403);
  assert.equal((await f.request('/api/cwd?path=' + encodeURIComponent(f.root), a)).status, 403);
});

test('SSE is authenticated and closes on logout', async t => {
  const f = await fixture(t), a = await f.login('Alice');
  const response = await f.request('/events?tabId=events', a);
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.match(Buffer.from(first.value).toString(), /event: sync/);
  await f.request('/api/auth/logout', a, {});
  let ended = false;
  for (let i = 0; i < 10; i++) { const next = await reader.read(); if (next.done) { ended = true; break; } }
  assert.equal(ended, true);
});

test('login attempts are rate limited; secure subpath cookies are configurable', async t => {
  const f = await fixture(t, true, { secureCookie: true, cookiePath: '/neo/' });
  const success = await f.request('/api/auth/login', '', { username: 'Alice', password: 'test-password-only' });
  assert.match(success.headers.get('set-cookie'), /Path=\/neo\//);
  assert.match(success.headers.get('set-cookie'), /; Secure/);
  for (let i = 0; i < 10; i++) assert.equal((await f.request('/api/auth/login', '', { username: 'missing-' + i, password: 'wrong' })).status, 401);
  assert.equal((await f.request('/api/auth/login', '', { username: 'Alice', password: 'test-password-only' })).status, 429);
});

test('built-in download mappings use user-owned storage, not globally configured paths', async t => {
  process.env.NEO_WEB_PLUGINS = 'all';
  t.after(() => { process.env.NEO_WEB_PLUGINS = 'none'; delete process.env.NEO_DOWNLOADS_DIR; });
  const f = await fixture(t, true, {}, true);
  process.env.NEO_DOWNLOADS_DIR = path.join(f.root, 'forbidden-shared-downloads');
  const a = await f.login('Alice'), b = await f.login('Bob');
  const source = path.join(f.root, 'download.txt');
  await fs.writeFile(source, 'private download');
  const { DownloadRegistry } = await import('./plugins/downloads/downloads.mjs');
  const registry = new DownloadRegistry({ storageDir: path.join(f.root, 'isolated-users', 'Alice', 'downloads') });
  const entry = await registry.add({ absolutePath: source });
  const download = await f.request('/api/downloads/' + entry.id, a);
  assert.match(download.headers.get('cache-control'), /no-store/);
  assert.equal(download.headers.get('vary'), 'Cookie');
  assert.equal(await download.text(), 'private download');
  assert.equal((await f.request('/api/downloads/' + entry.id, b)).status, 404);
});

test('snapshot filtering never mutates original normal-mode data', () => {
  const original = { interactive: { login: { values: { secret: 'private' } } }, catalog: { envPath: '/secret', commands: [{ name: '/env' }, { name: '/new' }] } };
  const result = sanitizeIsolatedSnapshot(original);
  assert.equal(result.interactive.login, undefined);
  assert.deepEqual(result.catalog.commands, [{ name: '/new' }]);
  assert.equal(original.interactive.login.values.secret, 'private');
});
