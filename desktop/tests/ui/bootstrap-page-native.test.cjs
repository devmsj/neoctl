// Opt-in: runs against an already-started debug shell, never starts/stops a backend.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_CORE_PATH);
(async () => {
  const endpoint = process.env.NEO_DESKTOP_CDP;
  if (!endpoint) throw new Error('Set NEO_DESKTOP_CDP to the debug shell CDP endpoint');
  const browser = await chromium.connectOverCDP(endpoint);
  try {
    const page = browser.contexts()[0].pages()[0];
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    for (let attempt = 0; attempt < 2; attempt++) {
      await page.getByRole('button', { name: '应用菜单', exact: true }).click();
      await page.getByRole('menuitem', { name: '返回启动页', exact: true }).click();
      await page.waitForURL('http://neo-start.localhost/**');
      await page.waitForFunction(() => document.body.dataset.state === 'ready');
      assert.equal(await page.locator('#readyView').isVisible(), true);
      assert.equal(await page.locator('#logDetails').isVisible(), false);
      assert.equal(await page.locator('#enterButton').isEnabled(), true);
      assert.equal(await page.locator('#enterLabel').textContent(), '进入');
      assert.equal(await page.locator('#stopBackend').isVisible(), false);
      assert.equal(await page.locator('#updateRuntime').isVisible(), false);
      assert.equal(await page.evaluate(() => document.styleSheets.length), 1);
      assert.equal(await page.locator('body').innerText().then(value => value.includes('asset not found')), false);
      const resources = await page.evaluate(async () => {
        const results = [];
        for (const path of ['index.html', 'styles.css', 'app.js', 'missing.js']) {
          const response = await fetch(path);
          results.push({ path, status: response.status, type: response.headers.get('content-type') });
        }
        return results;
      });
      assert.deepEqual(resources.map(item => item.status), [200, 200, 200, 404]);
      assert.match(resources[0].type, /^text\/html/);
      assert.match(resources[1].type, /^text\/css/);
      assert.match(resources[2].type, /^text\/javascript/);
      if (attempt === 0 && process.env.NEO_LAUNCHER_SCREENSHOT) {
        await page.screenshot({ path: process.env.NEO_LAUNCHER_SCREENSHOT });
      }
      await page.locator('#enterButton').click();
      await page.waitForURL('http://127.0.0.1:5173/**');
      await page.locator('textarea').first().waitFor({ state: 'visible' });
    }
    assert.deepEqual(errors, []);
    console.log('PASS native launcher return twice, real IPC, HTML/CSS/JS and strict 404');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
