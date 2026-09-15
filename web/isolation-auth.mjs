import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const HASH = /^scrypt\$([a-f0-9]{32})\$([a-f0-9]{128})$/;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?$/i;
export const isolationCookie = 'neo_isolation';
export const publicUser = user => ({ username: user.username, role: user.role || 'user' });
export const usernameKey = username => String(username).normalize('NFKC').toLowerCase();
export const validUsername = username => typeof username === 'string'
  && username.length >= 1 && username.length <= 100 && Buffer.byteLength(username, 'utf8') <= 240
  && username === username.trim() && !username.endsWith('.')
  && username !== '.' && username !== '..' && !WINDOWS_RESERVED.test(username)
  && !/[\u0000-\u001f<>:"/\\|?*]/.test(username);
export const jsonReply = (res, value, status = 200) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
};
export const httpError = (status, message) => Object.assign(new Error(message), { status });

export async function readBoundedJson(req, maxBytes = 1024 * 1024) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw httpError(413, '请求过大');
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw httpError(400, 'JSON 无效'); }
}

export async function hashPassword(password) {
  if (typeof password !== 'string' || !password.length || /[^A-Za-z0-9]/.test(password)) throw new Error('密码至少 1 位，仅允许字母和数字');
  const salt = randomBytes(16).toString('hex');
  return `scrypt$${salt}$${Buffer.from(await scrypt(password, salt, 64)).toString('hex')}`;
}

export async function loadIsolationConfig(dataRoot, configFile = process.env.NEO_ISOLATION_CONFIG) {
  const filename = path.resolve(configFile || path.join(dataRoot, 'isolation.json'));
  let config;
  try { config = JSON.parse(await fs.readFile(filename, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT' && !configFile) return { enabled: false };
    throw new Error(`无法读取隔离配置: ${filename}`, { cause: error });
  }
  if (!config || typeof config.enabled !== 'boolean') throw new Error('isolation.enabled 必须为布尔值');
  if (!config.enabled) return { enabled: false };
  if (!Array.isArray(config.users) || !config.users.length || config.users.length > 1000) throw new Error('隔离模式须配置 1–1000 个用户');
  const users = config.users.map(user => {
    if (user?.id !== undefined && user.id !== user.username) throw new Error('旧用户 ID 与用户名不同，请先迁移数据目录');
    const { id: _oldId, ...account } = user || {};
    return account;
  });
  const names = new Set();
  for (const user of users) {
    const key = usernameKey(user?.username);
    if (!user || !validUsername(user.username) || (user.passwordHash !== undefined && !HASH.test(user.passwordHash))
      || (user.role !== undefined && !['user', 'admin'].includes(user.role)) || names.has(key)) {
      throw new Error('用户名、角色或密码哈希无效或重复');
    }
    names.add(key);
  }
  const cookiePath = config.cookiePath || '/';
  if (!/^\/(?:[a-zA-Z0-9_/-]*)$/.test(cookiePath)) throw new Error('cookiePath 无效');
  if (config.secureCookie !== undefined && typeof config.secureCookie !== 'boolean') throw new Error('secureCookie 必须为布尔值');
  const sessionHours = config.sessionHours ?? 12;
  if (!Number.isFinite(sessionHours) || sessionHours < 0.01 || sessionHours > 168) throw new Error('sessionHours 无效');
  if (config.retiredUserIds !== undefined && config.retiredUsernames === undefined && config.retiredUserIds.length) {
    throw new Error('旧 retiredUserIds 非空，请先迁移为 retiredUsernames');
  }
  const retiredUsernames = config.retiredUsernames ?? config.retiredUserIds ?? [];
  const retiredKeys = new Set();
  if (!Array.isArray(retiredUsernames) || retiredUsernames.some(username => {
    const key = usernameKey(username);
    if (!validUsername(username) || names.has(key) || retiredKeys.has(key)) return true;
    retiredKeys.add(key); return false;
  })) throw new Error('retiredUsernames 无效');
  const { retiredUserIds: _oldRetiredUserIds, ...current } = config;
  return { ...current, enabled: true, filename, users, retiredUsernames, cookiePath, secureCookie: config.secureCookie === true, sessionHours };
}

export function createIsolationAccounts(config, { dataRoot, onDelete = () => {} }) {
  let mutation = Promise.resolve();
  const serial = operation => {
    const pending = mutation.then(operation);
    mutation = pending.catch(() => {});
    return pending;
  };
  async function persist(users, retiredUsernames) {
    const { filename, retiredUserIds: _oldRetiredUserIds, ...stored } = config;
    const temporary = `${filename}.tmp-${randomBytes(8).toString('hex')}`;
    try {
      await fs.writeFile(temporary, JSON.stringify({ ...stored, users, retiredUsernames }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      await fs.rename(temporary, filename);
    } finally { await fs.rm(temporary, { force: true }); }
    config.users = users;
    config.retiredUsernames = retiredUsernames;
  }
  return {
    list: () => config.users.map(publicUser),
    create: body => serial(async () => {
      const { username, role } = body || {};
      if (body && (Object.hasOwn(body, 'password') || Object.hasOwn(body, 'passwordHash'))) throw httpError(400, '创建用户只需用户名，不可设置密码');
      if (!validUsername(username) || (role !== undefined && role !== 'user')) throw httpError(400, '账号信息无效，只能创建普通用户');
      if (config.users.length >= 1000) throw httpError(400, '用户数量已达上限');
      const key = usernameKey(username);
      if (config.users.some(user => usernameKey(user.username) === key) || config.retiredUsernames.some(value => usernameKey(value) === key)) throw httpError(409, '用户名已使用');
      try { await fs.lstat(path.join(dataRoot, 'isolated-users', username)); throw httpError(409, '该用户名已有历史数据'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const user = { username, role: 'user' };
      await persist([...config.users, user], config.retiredUsernames);
      return publicUser(user);
    }),
    claim: (user, password) => serial(async () => {
      const current = config.users.find(value => value.username === user.username);
      if (!current) return;
      if (current.passwordHash !== undefined) return current;
      let passwordHash;
      try { passwordHash = await hashPassword(password); } catch (error) { throw httpError(400, error.message); }
      const claimed = { ...current, passwordHash };
      await persist(config.users.map(value => value === current ? claimed : value), config.retiredUsernames);
      return claimed;
    }),
    remove: username => serial(async () => {
      if (!validUsername(username)) throw httpError(400, '用户名无效');
      const key = usernameKey(username);
      const user = config.users.find(value => usernameKey(value.username) === key);
      if (!user) throw httpError(404, '用户不存在');
      if (user.role === 'admin') throw httpError(403, '不能删除超管');
      await persist(config.users.filter(value => value !== user), [...config.retiredUsernames, user.username]);
      onDelete(user.username);
    }),
  };
}

export function createIsolationAuth(config, accounts) {
  const sessions = new Map(), attempts = new Map();
  let activeLogins = 0;
  const digest = value => createHash('sha256').update(value).digest('hex');
  const cookie = (token, maxAge) => `${isolationCookie}=${token}; Path=${config.cookiePath}; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${config.secureCookie ? '; Secure' : ''}`;
  const tokenFrom = req => {
    const tokens = String(req.headers.cookie || '').split(';').map(x => x.trim()).filter(x => x.startsWith(isolationCookie + '='));
    return tokens.length === 1 ? tokens[0].slice(isolationCookie.length + 1) : '';
  };
  function revoke(key) {
    const session = sessions.get(key);
    if (session) for (const res of session.streams) res.end();
    sessions.delete(key);
  }
  function authenticate(req) {
    const token = tokenFrom(req);
    if (!/^[a-f0-9]{64}$/.test(token)) return;
    const key = digest(token), session = sessions.get(key);
    if (session && session.expires > Date.now() && config.users.includes(session.user)) return { ...session, key };
    revoke(key);
  }
  function sameOrigin(req) {
    if (req.headers['sec-fetch-site'] === 'cross-site') return false;
    if (!req.headers.origin) return true;
    try { return new URL(req.headers.origin).host === req.headers.host; } catch { return false; }
  }
  const timer = setInterval(() => {
    for (const [key, session] of sessions) if (session.expires <= Date.now()) revoke(key);
    for (const [key, attempt] of attempts) if (attempt.until <= Date.now()) attempts.delete(key);
  }, 1000);
  timer.unref();

  return {
    authenticate, sameOrigin,
    revokeUser(username) { for (const [key, session] of sessions) if (session.user.username === username) revoke(key); },
    close() { clearInterval(timer); for (const key of sessions.keys()) revoke(key); },
    track(session, res) {
      if (!sessions.has(session.key) || session.expires <= Date.now()) { res.end(); return false; }
      session.streams.add(res); res.once('close', () => session.streams.delete(res)); return true;
    },
    async route(req, res, url) {
      const current = authenticate(req);
      if (!sameOrigin(req)) { jsonReply(res, { error: '跨站请求被拒绝' }, 403); return true; }
      if (url.pathname === '/api/auth/status' && req.method === 'GET') {
        jsonReply(res, { isolation: true, user: current ? publicUser(current.user) : null });
        return true;
      }
      if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
        if (current) revoke(current.key);
        res.setHeader('Set-Cookie', cookie('', 0));
        jsonReply(res, { ok: true });
        return true;
      }
      if (url.pathname === '/api/auth/login' && req.method === 'POST') {
        const body = await readBoundedJson(req);
        const username = typeof body?.username === 'string' ? body.username : '';
        const password = typeof body?.password === 'string' ? body.password : '';
        const rateKey = `${req.socket.remoteAddress}`;
        let attempt = attempts.get(rateKey);
        if (!attempt || attempt.until <= Date.now()) attempt = { count: 0, until: Date.now() + 60_000 };
        if (attempt.count >= 10 || activeLogins >= 4 || attempts.size >= 10000 || sessions.size >= 10000) {
          res.setHeader('Retry-After', '60'); jsonReply(res, { error: '尝试过多，请稍后重试' }, 429); return true;
        }
        attempt.count++; attempts.set(rateKey, attempt);
        let user = config.users.find(value => value.username === username);
        activeLogins++;
        let valid = false;
        try {
          if (user && user.passwordHash === undefined) user = await accounts.claim(user, password);
          const parts = HASH.exec(user?.passwordHash || '') || ['', '0'.repeat(32), '0'.repeat(128)];
          const derived = await scrypt(password, parts[1], 64);
          valid = !!user && config.users.includes(user) && timingSafeEqual(derived, Buffer.from(parts[2], 'hex'));
        } finally { activeLogins--; }
        if (!valid) { jsonReply(res, { error: '用户名或密码错误' }, 401); return true; }
        attempts.delete(rateKey);
        if (current) revoke(current.key);
        const token = randomBytes(32).toString('hex');
        const maxAge = Math.round(config.sessionHours * 3600);
        sessions.set(digest(token), { user, expires: Date.now() + maxAge * 1000, streams: new Set() });
        res.setHeader('Set-Cookie', cookie(token, maxAge));
        jsonReply(res, { ok: true, user: publicUser(user) });
        return true;
      }
      return false;
    },
  };
}
