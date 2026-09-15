// Optional: uses the repository's existing Playwright cache and local Edge.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { hashPassword } from './isolation-auth.mjs';
import { createIsolationMode } from './isolation.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.NEO_PLAYWRIGHT_MODULE || '../desktop/.cache/ui-test/node_modules/playwright-core');
process.env.NEO_CORE_SOURCE = 'local';
process.env.NEO_WEB_PLUGINS = 'none';
process.env.NEO_EXECUTION_BACKEND = 'local';
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'neo-auth-browser-'));
const passwordHash = await hashPassword('browser-test-only');
await fs.writeFile(path.join(root, 'isolation.json'), JSON.stringify({ enabled: true, users: [{ username: 'Alice', passwordHash }, { username: 'Bob', passwordHash }, { username: 'Admin', passwordHash, role: 'admin' }] }));
process.env.NEO_ENV_FILE = path.join(root, 'model.env');
await fs.writeFile(process.env.NEO_ENV_FILE, 'MODEL_PROVIDER=openai\nOPENAI_API_KEY=browser-test-only\nOPENAI_MODEL=browser-model\n');
const sessionId = 'browser-admin-session';
const sessionRoot = path.join(root, 'isolated-users', 'Alice', 'sessions', sessionId);
await fs.mkdir(sessionRoot, { recursive: true });
await fs.writeFile(path.join(sessionRoot, 'transcript.jsonl'), JSON.stringify({ type: 'title', sessionId, agentId: 'main', title: 'Alice 历史会话', createdAt: new Date().toISOString() }) + '\n');
process.env.NEO_SYSTEM_PROMPT_PATH = path.join(root, 'system.md');
const quotaState = { config: { url: 'http://cpa.test', hasPassword: true }, quotas: [{ account: 'shared', remainingPercent: 75, usedPercent: 25, resetAt: new Date().toISOString() }] };
const cpaQuotaMonitor = { getPublicState: () => quotaState, updateConfig: async () => quotaState };
const mode = await createIsolationMode({ dataRoot: root, workspaceRoot: path.join(root, 'work'), pluginDir: path.join(root, 'plugins'), cpaQuotaMonitor,
  memoryState: () => ({ current: { rss: 104857600, heapUsed: 10485760, external: 1024, at: new Date().toISOString() }, history: [] }),
});
const dist = path.resolve('web/dist');
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (await mode.route(req, res, url)) return;
    const filename = path.join(dist, url.pathname === '/' ? 'index.html' : url.pathname);
    res.setHeader('Content-Type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[path.extname(filename)] || 'application/octet-stream');
    res.end(await fs.readFile(filename));
  } catch { res.writeHead(404); res.end(); }
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base);
  await page.getByRole('form', { name: '用户登录' }).waitFor();
  assert.equal(await page.getByText('Neo', { exact: true }).count(), 0);
  assert.ok(await page.locator('.flow').count() >= 2);
  assert.equal(await page.locator('.portal, .ready-dot').count(), 0);
  assert.equal((await page.locator('.auth-card').innerText()).trim(), '');
  assert.equal(await page.locator('.auth-card [title], .auth-card [placeholder]').count(), 0);
  const appearance = async theme => {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await page.waitForTimeout(300);
    return page.evaluate(() => {
      const style = selector => getComputedStyle(document.querySelector(selector));
      return {
        scheme: style('.auth-screen').colorScheme,
        backdrop: style('.auth-screen').backgroundImage,
        card: style('.auth-card').backgroundImage,
        input: style('#auth-username').color,
        inputBackground: style('#auth-username').backgroundColor,
        button: style('.submit-button').backgroundImage,
        flow: style('.flow').backgroundImage,
      };
    });
  };
  const light = await appearance('light');
  assert.deepEqual(await appearance('dark'), light, 'login must not follow the app theme');
  assert.equal(light.scheme, 'dark');
  assert.equal(light.input, 'rgb(247, 247, 251)');
  assert.equal(light.inputBackground, 'rgb(16, 20, 32)');
  for (const key of ['backdrop', 'card', 'button', 'flow']) assert.notEqual(light[key], 'none', key);
  if (process.env.NEO_LOGIN_SCREENSHOT_DIR) {
    await fs.mkdir(process.env.NEO_LOGIN_SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({ path: path.join(process.env.NEO_LOGIN_SCREENSHOT_DIR, 'login-desktop.png') });
  }
  const desktopCard = await page.locator('.auth-card').boundingBox();
  assert.ok(desktopCard.width <= 430 && desktopCard.x > 400, JSON.stringify(desktopCard));
  await page.setViewportSize({ width: 390, height: 844 });
  if (process.env.NEO_LOGIN_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.NEO_LOGIN_SCREENSHOT_DIR, 'login-mobile.png') });
  const mobileCard = await page.locator('.auth-card').boundingBox();
  assert.ok(mobileCard.x >= 17 && mobileCard.width <= 354 && mobileCard.y >= 17, JSON.stringify(mobileCard));
  assert.equal(await page.getByLabel('用户名', { exact: true }).count(), 1);
  assert.equal(await page.getByLabel('密码', { exact: true }).count(), 1);
  await page.setViewportSize({ width: 320, height: 400 });
  await page.getByRole('button', { name: '登录', exact: true }).scrollIntoViewIfNeeded();
  const smallButton = await page.getByRole('button', { name: '登录', exact: true }).boundingBox();
  assert.ok(smallButton.y >= 0 && smallButton.y + smallButton.height <= 400);
  assert.equal(await page.locator('.auth-screen').evaluate(el => el.scrollWidth <= el.clientWidth), true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  assert.equal(await page.locator('.sidebar').count(), 0);
  await page.getByLabel('用户名', { exact: true }).fill('Alice');
  await page.getByLabel('密码', { exact: true }).fill('wrong');
  await page.getByRole('button', { name: '显示密码', exact: true }).click();
  assert.equal(await page.getByLabel('密码', { exact: true }).getAttribute('type'), 'text');
  await page.getByRole('button', { name: '隐藏密码', exact: true }).click();
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('alert').waitFor();
  assert.equal(await page.locator('.auth-error .sr-only').evaluate(el => getComputedStyle(el).clipPath), 'inset(50%)');
  assert.equal(await page.locator('.auth-error svg').count(), 1);
  await page.getByLabel('密码', { exact: true }).fill('browser-test-only');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  const logout = page.getByRole('button', { name: '退出登录', exact: true });
  await logout.waitFor();
  assert.equal((await logout.textContent()).trim(), '');
  const logoutBox = await logout.boundingBox();
  assert.ok(logoutBox.x < 40 && logoutBox.y > 900, JSON.stringify(logoutBox));
  assert.equal(await page.getByRole('button', { name: '提示词管理', exact: true }).count(), 0);
  assert.equal(await page.locator('.prompt-stack').count(), 0);
  await page.locator('[data-card="quota"]').waitFor();
  await page.locator('.memory-card').waitFor();
  assert.equal(await page.getByRole('button', { name: '模型配置', exact: true }).count(), 0);
  await page.getByRole('button', { name: '会话管理', exact: true }).first().click();
  await page.getByRole('button', { name: '新建会话', exact: true }).first().click();
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await page.getByRole('form', { name: '用户登录' }).waitFor();
  await page.getByLabel('用户名', { exact: true }).fill('Bob');
  await page.getByLabel('密码', { exact: true }).fill('browser-test-only');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('button', { name: '退出登录', exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.locator('.prompt-stack').count(), 0);
  await page.locator('[data-card="quota"]').waitFor({ state: 'attached' });
  await page.locator('.memory-card').waitFor({ state: 'attached' });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await page.getByRole('form', { name: '用户登录' }).waitFor();
  await page.getByLabel('用户名', { exact: true }).fill('Admin');
  await page.getByLabel('密码', { exact: true }).fill('browser-test-only');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('button', { name: '退出登录', exact: true }).waitFor();
  await page.setViewportSize({ width: 1440, height: 1000 });
  assert.equal(await page.getByRole('button', { name: '新建会话', exact: true }).count(), 0);
  await page.getByRole('button', { name: '用户管理', exact: true }).click();
  await page.getByRole('heading', { name: '用户管理' }).waitFor();
  assert.equal(await page.getByLabel('用户 ID').count(), 0);
  await page.getByLabel('用户名', { exact: true }).fill('Charlie');
  await page.getByLabel('密码', { exact: true }).fill('browser-test-only');
  await page.getByRole('button', { name: '创建普通用户' }).click();
  await page.getByText('Charlie', { exact: true }).waitFor();
  await page.getByRole('button', { name: '会话管理', exact: true }).click();
  await page.getByRole('heading', { name: '会话管理' }).waitFor();
  const aliceSession = page.getByRole('article').filter({ hasText: 'Alice 历史会话' });
  await aliceSession.waitFor();
  await page.getByText('Alice', { exact: true }).waitFor();
  await aliceSession.getByRole('button', { name: '打开' }).click();
  await aliceSession.waitFor({ state: 'hidden' });
  assert.equal(await page.locator('form.composer').count(), 0);
  assert.equal(await page.getByRole('button', { name: '新建会话', exact: true }).count(), 0);
  await page.locator('[data-card="quota"]').waitFor();
  await page.locator('.memory-card').waitFor();
  await page.getByRole('button', { name: '模型配置', exact: true }).click();
  await page.locator('.settings-form').waitFor();
  assert.equal(await page.locator('.settings-prompt-entry').count(), 1);
  assert.equal(await page.locator('.settings-plugin-card').count(), 2);
  assert.equal(await page.getByText('CPA', { exact: true }).count(), 1);
  await page.getByRole('button', { name: '提示词配置' }).click();
  await page.getByRole('heading', { name: '提示词配置' }).waitFor();
  await page.getByRole('button', { name: '返回模型配置' }).click();
  const saveResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/login' && response.request().method() === 'POST');
  await page.locator('.settings-page-head').getByRole('button', { name: '保存', exact: true }).click();
  assert.equal((await (await saveResponse).json()).ok, true);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.locator('.settings-page').evaluate(el => el.scrollWidth <= el.clientWidth), true);
  assert.deepEqual(errors, []);
  console.log('PASS: admin uses the main app, user management is a menu, all sessions are readable, composer/new-session UI is hidden');
} finally {
  await browser?.close(); mode.close(); server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
}
