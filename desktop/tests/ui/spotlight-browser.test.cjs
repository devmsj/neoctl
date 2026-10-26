const assert=require('node:assert/strict');const path=require('node:path');const {pathToFileURL}=require('node:url');const {chromium}=require(process.env.PLAYWRIGHT_CORE_PATH||'../../.cache/ui-test/node_modules/playwright-core');
(async()=>{const browser=await chromium.launch({channel:'msedge',headless:true});try{
const page=await browser.newPage({viewport:{width:1180,height:760}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.addInitScript(()=>{window.calls=[];window.events={};window.__TAURI__={core:{invoke:async(n,a)=>{calls.push({n,a,time:performance.now()});if(n==='bootstrap_state')return{installed:true,auto_launch:false,install_dir:'D:/Neo',web_version:'0.1.24',core_version:'0.2.48'};if(n==='runtime_status')return true;if(n==='update_runtime')return new Promise((r,j)=>window.update={resolve:r,reject:j});}},event:{listen:async(n,f)=>{events[n]=f;return()=>{}}}};});
const url=pathToFileURL(path.join(__dirname,'../../ui/index.html')).href;await page.goto(url);await page.waitForFunction(()=>document.body.dataset.state==='ready');
assert.equal(await page.locator('#runtimeIndicator').isVisible(),false);
await page.screenshot({path:path.join(__dirname,'../../.cache/spotlight-real-manager.png')});
await page.locator('#updateRuntime').click();await page.waitForTimeout(700);
await page.evaluate(()=>{window.refs={view:document.querySelector('#progressView'),bar:document.querySelector('#progressBar')};events['runtime-log']({payload:{line:Array.from({length:120},(_,i)=>'Log '+i).join('\n')}});});
await page.locator('#logDetails summary').click();await page.locator('#installLog').focus();await page.keyboard.press('Home');
const scroll=await page.locator('#installLog').evaluate(el=>{el.scrollTop=0;return{height:el.scrollHeight,client:el.clientHeight,bar:getComputedStyle(el).scrollbarWidth}});assert.ok(scroll.height>scroll.client);assert.equal(scroll.bar,'none');
await page.locator('#installLog').hover();await page.waitForTimeout(250);await page.mouse.wheel(0,180);await page.waitForTimeout(250);assert.ok(await page.locator('#installLog').evaluate(el=>el.scrollTop)>0);
await page.locator('#installLog').focus();await page.keyboard.press('Control+Home');await page.keyboard.press('PageDown');assert.ok(await page.locator('#installLog').evaluate(el=>el.scrollTop)>0);
for(const percent of [30,35,44,58,70,72,82,86,88,94,96,98]){await page.evaluate(p=>events['install-progress']({payload:{percent:p,stage:'下载依赖包 '+p+' / 100',message:'已校验'}}),percent);assert.equal(await page.locator('#progressTrack').getAttribute('aria-valuenow'),String(percent));}
assert.equal(await page.evaluate(()=>refs.view===document.querySelector('#progressView')&&refs.bar===document.querySelector('#progressBar')),true);assert.equal(await page.locator('#logDetails').evaluate(e=>e.open),true);
await page.evaluate(()=>events['install-progress']({payload:{percent:40,stage:'延迟事件'}}));assert.equal(await page.locator('#progressTrack').getAttribute('aria-valuenow'),'98');
await page.screenshot({path:path.join(__dirname,'../../.cache/spotlight-real-progress.png')});
await page.goto(url);await page.waitForFunction(()=>document.body.dataset.state==='ready');await page.waitForTimeout(650);
await page.evaluate(()=>document.querySelector('#enterButton').addEventListener('click',()=>window.clicked=performance.now(),{once:true}));await page.locator('#enterButton').click();await page.waitForTimeout(1000);assert.equal(await page.evaluate(()=>calls.some(c=>c.n==='enter_application')),false);assert.equal(await page.locator('body').getAttribute('data-light'),'entering');
await page.waitForFunction(()=>calls.some(c=>c.n==='enter_application'));const ms=await page.evaluate(()=>calls.find(c=>c.n==='enter_application').time-clicked);assert.ok(ms>=1990&&ms<2800,ms);
await page.goto(url);await page.waitForFunction(()=>document.body.dataset.state==='ready');await page.locator('#enterButton').click();await page.evaluate(()=>window.dispatchEvent(new Event('pagehide')));await page.waitForTimeout(2200);assert.equal(await page.evaluate(()=>calls.some(c=>c.n==='enter_application')),false);
assert.deepEqual(errors,[]);console.log('PASS spotlight: hidden scrollbars with wheel/keyboard scrolling; stable progress nodes; monotonic values; 2s entry '+Math.round(ms)+'ms; disposal cancels navigation');
}finally{await browser.close()}})().catch(e=>{console.error(e);process.exitCode=1});
