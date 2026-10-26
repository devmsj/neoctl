// Mock-only launcher state/layout regression; never installs or starts a real backend.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_CORE_PATH || '../../.cache/ui-test/node_modules/playwright-core');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const os = require('node:os');
(async () => {
  const browser = await chromium.launch({channel:'msedge',headless:true});
  try {
    for (const installed of [false,true]) {
      const page=await browser.newPage();const errors=[];
      page.on('pageerror',error=>errors.push(error.message));
      await page.addInitScript(installed=>{
        window.calls=[];window.testEvents={};window.running=false;
        window.__TAURI__={core:{invoke:async(name)=>{
          window.calls.push(name);
          if(name==='bootstrap_state')return {installed,auto_launch:false,install_dir:installed?'D:\\Runtime':null,default_install_dir:'D:\\Runtime',web_version:'0.1.23',core_version:'0.2.47'};
          if(name==='runtime_status')return window.running;
          if(name==='start_backend')window.running=true;
          if(name==='stop_backend')window.running=false;
          if(name==='install_runtime'||name==='update_runtime')return new Promise((resolve,reject)=>{window.finishOperation={resolve,reject}});
          return null;
        }},event:{listen:async(name,fn)=>{window.testEvents[name]=fn;return()=>delete window.testEvents[name]}}};
      },installed);
      await page.goto(pathToFileURL(path.join(__dirname,'../../ui/index.html')).href);
      await page.waitForFunction(()=>document.body.dataset.state==='ready');
      await page.evaluate(()=>{document.documentElement.dataset.neoDesktop='';document.documentElement.style.setProperty('--neo-window-inset','36px');document.body.style.paddingTop='36px'});
      assert.equal(await page.locator('.brand-diamond,.hero,.artwork').count(),0);
      assert.equal(await page.evaluate(()=>getComputedStyle(document.body).backgroundColor),'rgb(12, 13, 15)');
      for(const [width,height] of [[1180,760],[888,700],[520,420],[390,844],[320,568]]) {
        await page.setViewportSize({width,height});await page.waitForTimeout(90);
        const layout=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,buttons:[...document.querySelectorAll('.control-dock button')].filter(e=>e.getBoundingClientRect().width).map(e=>({id:e.id,rect:e.getBoundingClientRect().toJSON(),text:e.textContent.trim(),label:e.getAttribute('aria-label')})),log:document.querySelector('#logDetails').getBoundingClientRect().toJSON()}));
        assert.ok(layout.scroll<=width,`${width}: no horizontal overflow`);
        assert.equal(await page.locator('#logDetails').isVisible(),false,'empty log stays hidden');
        for(const button of layout.buttons){assert.ok(button.text);assert.ok(button.label);assert.ok(button.rect.width>=36);assert.equal(button.rect.top,layout.buttons[0].rect.top);}
        await page.screenshot({path:path.join(os.tmpdir(),`neo-launcher-${installed?'installed':'fresh'}-${width}.png`)});
      }
      if(installed){
        assert.equal(await page.locator('#enterButton').isDisabled(),false,'stopped managed runtime has a one-click startup');
        await page.evaluate(()=>{window.running=true});await page.waitForTimeout(2100);
        assert.equal(await page.locator('#runtimeIndicator').getAttribute('data-running'),'true');
        // Entry navigates away after 2s; tested separately in spotlight-browser.

        await page.locator('#stopBackend').click();await page.waitForFunction(()=>document.querySelector('#runtimeIndicator').dataset.running==='false');
        assert.equal(await page.locator('#runtimeIndicator').getAttribute('data-running'),'false');
        await page.locator('#updateRuntime').click();
      } else {
        await page.locator('#pathOptions summary').click();await page.locator('#installPath').focus();await page.keyboard.press('Tab');
        assert.equal(await page.evaluate(()=>document.activeElement.id),'browseButton');
        await page.locator('#installButton').click();
      }
      await page.waitForFunction(()=>!!window.finishOperation);
      await page.evaluate(()=>testEvents['install-progress']({payload:{percent:42,stage:'安装依赖',message:'正在安装…',log:'[runtime] preparing dependencies\n[download] verified package\n<raw text remains safe>'}}));
      assert.equal(await page.locator('#progressTrack').getAttribute('aria-valuenow'),'42');
      assert.equal(await page.locator('#logDetails').evaluate(e=>e.open),false);
       await page.locator('#logDetails summary').click();
      assert.equal(await page.locator('#installLog raw').count(),0);
      await page.setViewportSize({width:888,height:700});await page.waitForTimeout(320);
      await page.screenshot({path:path.join(os.tmpdir(),`neo-launcher-progress-${installed?'update':'install'}.png`)});
      await page.emulateMedia({reducedMotion:'reduce'});
      assert.equal(await page.locator('.view').first().evaluate(e=>getComputedStyle(e).animationName),'none');
      await page.evaluate(()=>finishOperation.reject('Network unavailable\nDownload could not be completed.'));
      await page.waitForFunction(()=>document.body.dataset.state==='error');
      assert.equal(await page.locator('#retryButton svg').count(),1,'retry keeps SVG after error');
      assert.ok((await page.locator('#retryButton').innerText()).trim());
      assert.match(await page.locator('#installLog').innerText(),/Network unavailable/);
      await page.setViewportSize({width:520,height:420});
      await page.screenshot({path:path.join(os.tmpdir(),`neo-launcher-error-${installed?'update':'install'}.png`)});
      await page.locator('#logDetails summary').focus();await page.keyboard.press('Space');
      assert.equal(await page.locator('#logDetails').evaluate(e=>e.open),false);
      await page.keyboard.press('Space');
      assert.equal(await page.locator('#logDetails').evaluate(e=>e.open),true);
      await page.locator('#retryButton').click();await page.waitForFunction(()=>document.body.dataset.state==='ready');
      assert.deepEqual(errors,[]);await page.close();
    }
    console.log('PASS spotlight launcher, 5 sizes, state transitions, safe logs, keyboard and reduced motion');
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1});
