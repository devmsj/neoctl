// Opt-in: exercise an already-started debug shell; never send a model message.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_CORE_PATH);
(async () => {
  const endpoint = process.env.NEO_DESKTOP_CDP;
  if (!endpoint) throw new Error('Set NEO_DESKTOP_CDP to the debug shell CDP endpoint');
  const browser = await chromium.connectOverCDP(endpoint, {timeout:10000});
  try {
    const page = browser.contexts()[0].pages()[0];
    page.setDefaultTimeout(12000);
    const origin = new URL(page.url()).origin;
    assert.match(origin,/^http:\/\/127\.0\.0\.1:\d+$/);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const rounds = Number(process.env.NEO_NAVIGATION_ROUNDS || 10);
    for (let attempt = 0; attempt < rounds; attempt++) {
      const started=Date.now();
      await page.getByRole('button', { name: '应用菜单', exact: true }).click();
      await page.getByRole('menuitem', { name: '返回启动页', exact: true }).click();
      await page.waitForURL('http://neo-start.localhost/**');
      await page.waitForFunction(() => document.body.dataset.state === 'ready');
      assert.equal(await page.locator('#enterButton').isEnabled(), true);
      if(attempt===0){
        const statuses=await page.evaluate(async()=>Promise.all(['index.html','styles.css','app.js','missing.js'].map(async p=>(await fetch(p)).status)));
        assert.deepEqual(statuses,[200,200,200,404]);
      }
      await page.locator('#enterButton').click();
      await page.waitForURL(url=>url.origin===origin);
      await page.locator('.composer textarea').waitFor({ state: 'visible' });
      // These real IPC calls used to contend: UI-side drop registration versus
      // worker-side surface authorization, which held runtime_url while waiting for UI.
      await page.evaluate(async () => {
        const invoke=window.__TAURI_INTERNALS__?.invoke || window.__TAURI__?.core?.invoke;
        const dark=document.documentElement.dataset.theme==='dark';
        const channels=Array.from({length:6},()=>new window.__TAURI__.core.Channel());
        await Promise.all(channels.flatMap(channel=>[
          invoke('plugin:local-resources|watch_file_drops',{channel}),
          invoke('plugin:desktop-chrome|sync_surface',{dark,color:dark?[17,20,24]:[248,249,251]})
        ]));
        await Promise.all(channels.map(channel=>invoke('plugin:local-resources|unwatch_file_drops',{channelId:channel.id})));
        const original=await fetch('/api/client-info');if(!original.ok)throw Error('backend unavailable');
      });
      console.log(JSON.stringify({round:attempt+1,ms:Date.now()-started,url:page.url()}));
    }
    // Restore normal drop ownership by letting the app register once on fresh load.
    await page.reload();await page.locator('.composer textarea').waitFor();
    assert.deepEqual(errors, []);
    console.log(`PASS ${rounds} native launcher round trips and concurrent surface/drop IPC`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
