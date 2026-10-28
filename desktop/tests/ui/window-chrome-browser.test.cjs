const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_CORE_PATH);
const path = require('node:path');
(async () => {
  const browser = await chromium.launch({channel:'msedge',headless:true});
  try {
    const page=await browser.newPage({viewport:{width:888,height:788}});
    await page.setContent('<main id="app"></main>');
    await page.evaluate(()=>{window.calls=[];window.__TAURI_INTERNALS__={invoke:async(command,args)=>{window.calls.push({command,...args});if(args.action==='toggle_pin')window.pinned=!window.pinned;if(['toggle_pin','pin_state'].includes(args.action))return !!window.pinned;return args.action==='toggle_maximize'}}});
    await page.addScriptTag({path:path.join(__dirname,'../../ui/window-chrome.js')});
    await page.getByRole('button',{name:'应用菜单',exact:true}).click();
    await page.getByRole('menuitem',{name:'返回启动页',exact:true}).click();
    await page.getByRole('button',{name:'最大化',exact:true}).click();
    assert.equal(await page.getByRole('button',{name:'还原窗口',exact:true}).count(),1);
    await page.getByRole('button',{name:'最小化',exact:true}).click();
    await page.getByRole('button',{name:'关闭',exact:true}).click();
    await page.getByRole('button',{name:'应用菜单',exact:true}).focus();await page.keyboard.press('ArrowDown');
    assert.equal(await page.evaluate(()=>document.querySelector('neo-window-chrome').shadowRoot.activeElement.dataset.app),'start_page');
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.evaluate(()=>document.querySelector('neo-window-chrome').shadowRoot.activeElement.dataset.app),'check_updates');
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('button',{name:'应用菜单',exact:true}).getAttribute('aria-expanded'),'false');
    for(const width of [888,760,390]) {
      await page.setViewportSize({width,height:788});
      assert.ok(await page.evaluate(()=>{const s=document.querySelector('neo-window-chrome').shadowRoot;const d=s.querySelector('.drag').getBoundingClientRect(),a=s.querySelector('.app').getBoundingClientRect();return d.left>=a.right||d.top>=a.bottom||d.bottom<=a.top}),`drag does not cover app controls at ${width}`);
    }
    // Workspace-only gear uses frontend navigation, never window/native commands.
    assert.equal(await page.getByRole('button',{name:'全局配置',exact:true}).count(),0);
    await page.evaluate(()=>{window.settingsOpens=0;window.addEventListener('neo:open-settings',()=>window.settingsOpens++);document.documentElement.dataset.neoThemeReady=''});
    await page.getByRole('button',{name:'全局配置',exact:true}).click();
    assert.equal(await page.evaluate(()=>window.settingsOpens),1);
    await page.getByRole('button',{name:'窗口置顶',exact:true}).click();
    assert.equal(await page.getByRole('button',{name:'取消置顶',exact:true}).getAttribute('aria-pressed'),'true');
    const pinStyle = await page.locator('[data-pin-action]').evaluate(el=>({background:getComputedStyle(el).backgroundColor,shadow:getComputedStyle(el).boxShadow}));
    assert.notEqual(pinStyle.shadow,'none');assert.notEqual(pinStyle.background,'rgba(0, 0, 0, 0)');
    await page.getByRole('button',{name:'取消置顶',exact:true}).click();
    assert.equal(await page.locator('[data-pin-action]').getAttribute('aria-pressed'),'false');
    for (const accent of ['#287b82','#d9a556']) {
      await page.evaluate(value=>document.documentElement.style.setProperty('--appearance-accent',value),accent);
      await page.waitForTimeout(160); // Preserve the existing color transition.
      const colors=await page.locator('.accent-control').evaluateAll(els=>els.map(el=>getComputedStyle(el).color));
      assert.equal(colors[0],colors[1]);assert.equal(colors[0],accent==='#287b82'?'rgb(40, 123, 130)':'rgb(217, 165, 86)');
    }
    for (const width of [1180,821,520]) {
      await page.setViewportSize({width,height:788});
      assert.ok(await page.evaluate(()=>{const s=document.querySelector('neo-window-chrome').shadowRoot,g=s.querySelector('[data-settings-action]').getBoundingClientRect(),m=s.querySelector('[data-window=minimize]').getBoundingClientRect(),d=s.querySelector('.drag').getBoundingClientRect();return g.right<=m.left && d.right<=g.left}));
    }
    await page.evaluate(()=>delete document.documentElement.dataset.neoThemeReady);
    await page.waitForFunction(()=>document.querySelector('neo-window-chrome').shadowRoot.querySelector('[data-settings-action]').hidden);
    // Native and WebView surfaces follow the page, without per-resize IPC.
    await page.addStyleTag({content: '.shell { background: rgb(17,20,24) } [data-theme=light] .shell { background: rgb(248,249,251) }'});
    await page.evaluate(()=>{const shell=document.createElement('div');shell.className='shell';document.body.append(shell);document.documentElement.dataset.theme='dark'});
    await page.waitForTimeout(100);
    let surface=await page.evaluate(()=>window.calls.filter(c=>c.command.endsWith('|sync_surface')).at(-1));
    assert.deepEqual(surface.color,[17,20,24]);assert.equal(surface.dark,true);
    const before=await page.evaluate(()=>window.calls.filter(c=>c.command.endsWith('|sync_surface')).length);
    for(const width of [520,650,888,760]) await page.setViewportSize({width,height:420});
    await page.waitForTimeout(250);
    assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.command.endsWith('|sync_surface')).length),before);
    await page.evaluate(()=>document.documentElement.dataset.theme='light');await page.waitForTimeout(100);
    surface=await page.evaluate(()=>window.calls.filter(c=>c.command.endsWith('|sync_surface')).at(-1));
    assert.deepEqual(surface.color,[248,249,251]);assert.equal(surface.dark,false);
    const calls=await page.evaluate(()=>window.calls);
    for(const action of ['start_page','toggle_maximize','minimize','close']) assert.ok(calls.some(c=>c.action===action));
    console.log('PASS desktop chrome commands, menu keyboard, responsive hit areas');
  } finally {await browser.close()}
})().catch(error=>{console.error(error);process.exitCode=1});
