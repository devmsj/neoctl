import fs from 'node:fs/promises';
import path from 'node:path';
import { hashPassword, usernameKey, validUsername } from '../isolation-auth.mjs';

const [filename, username, role] = process.argv.slice(2);
if (!filename || !validUsername(username) || (role !== undefined && !['user', 'admin'].includes(role))) {
  console.error('用法: node scripts/isolation-user.mjs <配置文件> <用户名> [user|admin]');
  process.exit(1);
}

async function readPassword() {
  if (!process.stdin.isTTY) {
    let text = '';
    for await (const chunk of process.stdin) { text += chunk; if (text.length > 4096) throw new Error('输入过长'); }
    return text.replace(/\r?\n$/, '');
  }
  process.stderr.write('密码: ');
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let value = '';
    const done = () => { process.stdin.off('data', onData); process.stdin.setRawMode(false); process.stdin.pause(); process.stderr.write('\n'); };
    function onData(chunk) {
      for (const c of chunk) {
        if (c === '\u0003') { done(); reject(new Error('已取消')); return; }
        if (c === '\r' || c === '\n') { done(); resolve(value); return; }
        if (c === '\u007f' || c === '\b') value = value.slice(0, -1);
        else if (value.length < 1024) value += c;
      }
    }
    process.stdin.on('data', onData);
  });
}

const file = path.resolve(filename);
let config;
try { config = JSON.parse(await fs.readFile(file, 'utf8')); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  config = { enabled: false, secureCookie: false, cookiePath: '/', sessionHours: 12, retiredUsernames: [], users: [] };
}
config.users ||= [];
config.retiredUsernames ||= [];
const key = usernameKey(username);
if (config.users.some(user => user.id !== undefined && user.id !== user.username)) throw new Error('旧用户 ID 与用户名不同，请先迁移');
if (config.retiredUserIds?.length) throw new Error('请先将 retiredUserIds 迁移为 retiredUsernames');
if (config.retiredUsernames.some(value => usernameKey(value) === key)) throw new Error('已删除的用户名不可复用');
const existing = config.users.find(user => usernameKey(user.username) === key);
const nextRole = role || existing?.role || 'user';
const next = { username, role: nextRole };
if (nextRole === 'admin') next.passwordHash = await hashPassword(await readPassword());
else if (existing?.passwordHash) next.passwordHash = existing.passwordHash;
const users = config.users.map(user => {
  const { id: _oldId, ...account } = user;
  return account;
});
const index = users.findIndex(user => usernameKey(user.username) === key);
if (index >= 0) users[index] = next; else users.push(next);
const { retiredUserIds: _oldRetiredUserIds, ...stored } = config;
stored.users = users;
await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
const pending = file + `.tmp-${process.pid}`;
try {
  await fs.writeFile(pending, JSON.stringify(stored, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await fs.rename(pending, file);
} finally { await fs.rm(pending, { force: true }); }
console.log(`用户已保存: ${username}。修改 enabled 后重启 Web 生效。`);
