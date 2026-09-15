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
  await page.addInitScript(() => {
    const NativeEventSource = window.EventSource;
    window.EventSource = class extends NativeEventSource {
      constructor(...args) {
        super(...args);
        window.testEventSource = this;
        this.addEventListener('sync', event => { window.testSync = JSON.parse(event.data); });
      }
    };
  });
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
  const uploadButton = page.locator('.upload-button');
  await page.locator('input[type="file"]').setInputFiles({ name: 'check.txt', mimeType: 'text/plain', buffer: Buffer.from('upload test') });
  await page.waitForFunction(() => {
    const button = document.querySelector('.upload-button');
    return document.querySelector('.file-attachment') && button.getAttribute('aria-busy') === 'false' && button.style.getPropertyValue('--upload-progress') === '0%';
  });
  assert.equal(await uploadButton.evaluate(el => getComputedStyle(el, '::before').width), '0px');
  await page.getByRole('button', { name: '移除附件' }).click();
  const actionButton = page.locator('.composer-action');
  assert.equal((await actionButton.textContent()).trim(), '');
  assert.equal(await actionButton.isDisabled(), true);
  await page.waitForFunction(() => window.testSync && window.testEventSource);
  const setRunning = (busy, queuedInput) => page.evaluate(({ busy, queuedInput }) => {
    const payload = { ...window.testSync, busy, queuedInput, status: { ...window.testSync.status, phase: 'idle' } };
    window.testEventSource.dispatchEvent(new MessageEvent('sync', { data: JSON.stringify(payload) }));
  }, { busy, queuedInput });
  await setRunning(true);
  await actionButton.locator('[data-action="stop"]').waitFor();
  assert.equal(await actionButton.isDisabled(), false);
  assert.equal(await actionButton.getAttribute('type'), 'button');
  await page.locator('.composer textarea').fill('draft');
  await actionButton.locator('[data-action="interrupt-send"]').waitFor();
  await page.locator('.composer textarea').fill('');
  await setRunning(true, 'queued draft');
  await actionButton.locator('[data-action="send-now"]').waitFor();
  await setRunning(false);
  await actionButton.locator('[data-action="send"]').waitFor();
  assert.equal(await actionButton.getAttribute('type'), 'submit');
  for (const endpoint of ['/api/submit', '/api/queue/send-now']) {
    let release;
    const held = new Promise(resolve => { release = resolve; });
    await page.route(`**${endpoint}?*`, async route => { await held; await route.fulfill({ json: { ok: true, interrupted: true } }); });
    if (endpoint.endsWith('send-now')) await setRunning(true, 'queued test');
    else await page.locator('.composer textarea').fill('test submit');
    await actionButton.click();
    await actionButton.locator('[data-action="waiting"]').waitFor();
    assert.equal(await actionButton.isDisabled(), true);
    release();
    await page.waitForFunction(() => document.querySelector('.composer-action').getAttribute('aria-busy') === 'false');
    await page.unroute(`**${endpoint}?*`);
    await setRunning(false);
  }
  await page.evaluate(() => {
    const line = { id: 98765, kind: 'system', text: 'compacted', compaction: { current: true, summary: 'test summary', continuationState: 'test continuation details', createdAt: new Date().toISOString() } };
    window.testEventSource.dispatchEvent(new MessageEvent('sync', { data: JSON.stringify({ ...window.testSync, busy: false, queuedInput: undefined, lines: [line] }) }));
  });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.getByRole('button', { name: '查看压缩上下文' }).click();
    const detail = page.getByRole('dialog', { name: '压缩上下文详情' });
    await detail.waitFor();
    assert.ok((await detail.innerText()).includes('test continuation details'));
    await page.keyboard.press('Escape');
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileMenu = page.locator('.mobile-nav-menu');
  await mobileMenu.locator('summary').click();
  for (const theme of ['dark', 'light']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await page.waitForFunction(expected => getComputedStyle(document.querySelector('.mobile-nav-menu nav button.active')).backgroundColor === expected,
      theme === 'dark' ? 'rgb(86, 57, 75)' : 'rgb(252, 231, 243)');
    const colors = await mobileMenu.locator('nav').evaluate(el => {
      const style = getComputedStyle(el), button = getComputedStyle(el.querySelector('button.active'));
      return { background: style.backgroundColor, active: button.backgroundColor, transform: button.transform, shadow: button.boxShadow };
    });
    assert.equal(colors.background, theme === 'dark' ? 'rgb(52, 59, 68)' : 'rgb(255, 255, 255)');
    assert.equal(colors.active, theme === 'dark' ? 'rgb(86, 57, 75)' : 'rgb(252, 231, 243)');
    assert.equal(colors.transform, 'none');
    assert.equal(colors.shadow, 'none');
  }
  await mobileMenu.locator('summary').click();
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const theme of ['dark', 'light']) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      const expected = theme === 'dark'
        ? { background: 'rgb(52, 59, 68)', color: 'rgb(243, 244, 246)', fill: 'rgb(86, 57, 75)' }
        : { background: 'rgb(255, 255, 255)', color: 'rgb(26, 26, 26)', fill: 'rgb(244, 114, 182)' };
      await uploadButton.hover();
      for (const progress of [0, 50, 100, 0]) {
        await uploadButton.evaluate((el, progress) => {
          el.disabled = progress > 0;
          el.style.setProperty('--upload-progress', `${progress}%`);
        }, progress);
        await page.waitForFunction(({ expected, progress }) => {
          const el = document.querySelector('.upload-button');
          const style = getComputedStyle(el), fill = getComputedStyle(el, '::before');
          return style.backgroundColor === expected.background && style.color === expected.color
            && fill.backgroundColor === expected.fill
            && Math.abs(parseFloat(fill.width) - el.clientWidth * progress / 100) < 1;
        }, { expected, progress });
      }
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  const metrics = page.locator('#composer-session-metrics');
  assert.equal(await metrics.count(), 1);
  const metricAppearance = () => metrics.locator('.metric-chip').first().evaluate(el => {
    const style = getComputedStyle(el);
    return { background: style.backgroundColor, border: style.borderWidth, shadow: style.boxShadow };
  });
  const desktopMetricAppearance = await metricAppearance();
  for (const width of [320, 390, 512, 820]) {
    await page.setViewportSize({ width, height: 900 });
    const toggle = page.getByRole('button', { name: '会话选项', exact: true });
    if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
    await metrics.waitFor();
    assert.equal((await toggle.textContent()).trim(), '');
    await page.waitForFunction(() => [...document.querySelector('.composer-actions').children]
      .filter(el => getComputedStyle(el).display !== 'none')
      .every(el => Math.abs(el.getBoundingClientRect().height - 40) < 0.1));
    const actionLayout = await page.locator('.composer-actions').evaluate(el => {
      const buttons = [...el.children].filter(button => getComputedStyle(button).display !== 'none');
      const rects = buttons.map(button => button.getBoundingClientRect());
      return { order: buttons.map(button => button.classList.contains('session-options-toggle') ? 'options' : button.classList.contains('upload-button') ? 'upload' : 'send'),
        aligned: rects.every(rect => Math.abs(rect.top - rects[0].top) < 1 && Math.abs(rect.height - rects[0].height) < 1),
        overlap: rects.some((rect, i) => i > 0 && rect.left < rects[i - 1].right), overflow: el.scrollWidth > el.clientWidth };
    });
    assert.deepEqual(actionLayout, { order: ['options', 'upload', 'send'], aligned: true, overlap: false, overflow: false });
    await page.locator('.composer-cwd span').evaluate(el => { el.textContent = 'C:\\workspace\\' + 'very-long-directory-name\\'.repeat(30); });
    await metrics.locator('.model-chip strong').evaluate(el => { el.textContent = 'very-long-model-name-'.repeat(30); });
    const pathLayout = await page.locator('.composer-path-row').evaluate(el => {
      const row = el.getBoundingClientRect(), button = el.querySelector('button').getBoundingClientRect();
      return { contained: button.right <= row.right + 1, overflow: el.scrollWidth > el.clientWidth, ellipsis: getComputedStyle(el.querySelector('span')).textOverflow };
    });
    assert.deepEqual(pathLayout, { contained: true, overflow: false, ellipsis: 'ellipsis' });
    assert.deepEqual(await metricAppearance(), desktopMetricAppearance);
    const geometry = await metrics.evaluate(el => {
      const root = el.getBoundingClientRect();
      const boxes = [...el.children].map(child => child.getBoundingClientRect());
      return { overflow: el.scrollWidth > el.clientWidth,
        outside: boxes.some(box => box.left < root.left - 1 || box.right > root.right + 1),
        overlap: boxes.some((box, i) => boxes.slice(i + 1).some(other => Math.min(box.right, other.right) - Math.max(box.left, other.left) > 1 && Math.min(box.bottom, other.bottom) - Math.max(box.top, other.top) > 1)),
        splitLabels: [...el.querySelectorAll('.numeric')].some(chip => { const a = chip.querySelector('em').getBoundingClientRect(), b = chip.querySelector('strong').getBoundingClientRect(); return Math.abs((a.top + a.bottom) / 2 - (b.top + b.bottom) / 2) > 2; }) };
    });
    assert.deepEqual(geometry, { overflow: false, outside: false, overlap: false, splitLabels: false }, `toolbar at ${width}px`);
    if (process.env.NEO_LOGIN_SCREENSHOT_DIR && width === 390) await page.screenshot({ path: path.join(process.env.NEO_LOGIN_SCREENSHOT_DIR, 'composer-mobile.png') });
    await toggle.click();
    assert.equal(await metrics.isVisible(), false);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  assert.equal(await metrics.isVisible(), true);
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
