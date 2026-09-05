// Optional real layout check: node desktop/ui/browser.test.cjs (Windows Edge).
const { spawn } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const assert = require('node:assert/strict');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
(async () => {
  const profile = mkdtempSync(path.join(__dirname, '.edge-test-'));
  const edge = spawn(process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=19387', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  let socket;
  try {
    let targets;
    for (let i = 0; i < 80; i++) {
      try { targets = await (await fetch('http://127.0.0.1:19387/json')).json(); if (targets.some((target) => target.type === 'page')) break; } catch {}
      await delay(100);
    }
    assert.ok(targets, 'Edge debugging endpoint available');
    socket = new WebSocket(targets.find((target) => target.type === 'page').webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    let sequence = 0;
    const pending = new Map();
    socket.onmessage = ({ data }) => { const result = JSON.parse(data); if (result.id) { const callback = pending.get(result.id); pending.delete(result.id); result.error ? callback.reject(result.error) : callback.resolve(result.result); } };
    const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
    const evaluate = async (expression) => {
      const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    await send('Page.enable');
    await send('Page.addScriptToEvaluateOnNewDocument', { source: `window.testEvents={};window.__TAURI__={core:{invoke:async(name)=>name==='bootstrap_state'?{default_install_dir:'C:\\\\Neo',installed:false}:name==='install_runtime'?new Promise(()=>{}):null},event:{listen:async(name,fn)=>{window.testEvents[name]=fn;return ()=>delete window.testEvents[name]}}};` });
    await send('Page.navigate', { url: pathToFileURL(path.join(__dirname, 'index.html')).href });
    for (let i = 0; i < 40; i++) { if (await evaluate(`document.body?.dataset.state === 'ready'`)) break; await delay(100); }
    assert.equal(await evaluate(`document.body.dataset.state`), 'ready');
    for (const [width, height] of [[1180,760],[760,580],[390,844],[320,568]]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      await delay(80);
      const layout = await evaluate(`({width:innerWidth,scroll:document.documentElement.scrollWidth,button:document.querySelector('#installButton').getBoundingClientRect().width,views:[...document.querySelectorAll('.view')].filter(e=>getComputedStyle(e).display!=='none').length})`);
      assert.ok(layout.scroll <= layout.width, `${width}: horizontal overflow ${JSON.stringify(layout)}`);
      assert.ok(layout.button >= 44);
      assert.equal(layout.views, 1);
      console.log('PASS responsive layout', width, height);
    }
    await evaluate(`document.querySelector('#installPath').focus()`);
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    assert.equal(await evaluate('document.activeElement.id'), 'browseButton');
    await evaluate(`document.querySelector('#installForm').requestSubmit()`);
    await evaluate(`testEvents['install-progress']({payload:{percent:42,stage:'安装依赖',message:'正在安装…',log:'test log'}})`);
    assert.equal(await evaluate(`document.querySelector('#progressTrack').getAttribute('aria-valuenow')`), '42');
    assert.equal(await evaluate(`document.querySelector('#logDetails').open`), false);
    await evaluate(`document.querySelector('#logDetails summary').focus()`);
    assert.equal(await evaluate('document.activeElement.tagName'), 'SUMMARY');
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
    await delay(100); // Native disclosure toggling is queued by the browser.
    assert.equal(await evaluate(`document.querySelector('#logDetails').open`), true);
    console.log('PASS keyboard navigation, native log disclosure and event progress');
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    const motion = await evaluate(`getComputedStyle(document.querySelector('.brand-diamond')).animationName`);
    assert.equal(motion, 'none');
    console.log('PASS reduced-motion disables brand animation');
    await send('Browser.close');
  } finally {
    socket?.close(); edge.kill();
    await delay(1000);
    rmSync(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
