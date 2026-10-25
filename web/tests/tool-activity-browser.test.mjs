// Run after npm run build. Uses optional existing desktop Playwright cache and local Edge.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { resolve, extname } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const dist = fileURLToPath(new URL('../dist/', import.meta.url))
const require = createRequire(import.meta.url)
const { chromium } = require(process.env.NEO_PLAYWRIGHT_MODULE || '../../desktop/.cache/ui-test/node_modules/playwright-core')
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
const server = createServer(async (req, res) => {
  try {
    if (req.url?.startsWith('/api/images/')) {
      res.setHeader('Content-Type', 'image/png')
      res.end(pixel)
      return
    }
    const path = resolve(dist, req.url === '/' ? 'index.html' : `.${req.url}`)
    res.setHeader('Content-Type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[extname(path)] || 'application/octet-stream')
    res.end(await readFile(path))
  } catch {
    res.writeHead(404)
    res.end()
  }
})

await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
let browser
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>{localStorage.setItem('neo-tool-history-view','folded')});
  const snapshot = {
    busy:true,
    lines: [
      {id:'edit',kind:'tool',toolName:'file_edit',toolUseId:'edit-call',text:'',live:true,activity:{phase:'generating',input:{path:'a.ts',oldString:'old',newString:'new'}}},
      {id:'plan',kind:'tool',toolName:'plan_update',toolUseId:'plan-call',text:'',live:false,titleStatus:'success',activity:{phase:'completed',input:{items:[{description:'Parent',status:'in_progress',subitems:[{description:'Child',status:'pending'}]}]}}},
      { id: 'current-live', kind: 'tool', toolName: 'image_create', toolUseId: 'tool-current-live', title: '图片生成', text: JSON.stringify({ mode: 'generate', prompt: '可爱的蓝猫' }), live: true, presentationLevel: 'primary' },
      { id: 'current-result', kind: 'tool', toolName: 'image_create', toolUseId: 'tool-current-result', title: '图片生成', text: 'Generated 1 image\nopenai · gpt-image-2 · 1024x1024 · png', live: false, presentationLevel: 'primary' },
      { id: 'current-image', kind: 'tool', parentToolName: 'image_create', parentToolUseId: 'tool-current-result', text: '可爱的蓝猫', image: { src: '/api/images/current', label: '可爱的蓝猫', mimeType: 'image/png', available: true, blockIndex: 1 } },
      { id: 'legacy-result', kind: 'tool', toolName: 'image2', toolUseId: 'tool-legacy', title: '旧图片工具', text: 'Generated 1 image', live: false, presentationLevel: 'primary' },
    ],
    status: { phase: 'running_tools', currentTool: { name: 'image_create' } },
    backgroundTasks: [],
    agentTaskHistory: [],
    backgroundTaskCount: 0,
    catalog: { commands: [], modelIds: [], reasoning: [] },
    session: { sessionId: 'fake-image-create', title: 'Image create browser regression' },
    interactive: {},
  }
  let terminalLifecycle='running',terminalRequests=0;
  await page.route('**/api/**', (route) => {
    if(route.request().url().includes('/api/terminal-output')) {
      const url=new URL(route.request().url()),stream=url.searchParams.get('stream');terminalRequests++;
      assert.equal(url.searchParams.get('tail'),'true');
      const text=stream==='stdout'&&url.searchParams.get('offset')==='0'?'real process output':'';
      return route.fulfill({json:{sessionId:'fake-image-create',runId:'real-run',stream,offset:Number(url.searchParams.get('offset')),nextOffset:Number(url.searchParams.get('offset'))+text.length,text,endOfStoredOutput:true,record:{availability:'available',lifecycle:terminalLifecycle,exit:terminalLifecycle==='terminal'?{exitCode:0}:undefined,streams:{stdout:{storedBytes:19},stderr:{storedBytes:0}}}}});
    }
    if (route.request().url().includes('/api/auth/status')) return route.fulfill({ json: { isolation: false, user: null } })
    if (route.request().url().includes('/api/images/')) return route.continue()
    return route.fulfill({ json: route.request().url().includes('/api/state') ? snapshot : {} })
  })
  await page.addInitScript(()=>{window.__streams=[];window.EventSource=class{constructor(){this.handlers={};window.__streams.push(this)}addEventListener(name,fn){this.handlers[name]=fn}close(){}}})
  await page.goto(`http://127.0.0.1:${server.address().port}/`)

  await page.locator('.tool-activity-entry').first().waitFor();
  assert.equal(await page.locator('.tool-activity-entry').count(),5);
  assert.equal(await page.locator('.tool-observation').count(),1);
  await page.locator('[data-tool=file_edit] .tool-activity-row').click();
  assert.equal(await page.locator('.activity-pin').count(),1);
  assert.equal(await page.locator('.is-pinned .observation-diff .added').innerText(),'+new');
  assert.equal(await page.locator('.is-pinned .observation-diff .removed').innerText(),'-old');
  await page.evaluate(()=>window.__streams.at(-1).handlers.delta({data:JSON.stringify({sessionId:'fake-image-create',operations:[{type:'line.activity.input',id:'edit',changes:[{op:'append',path:['newString'],value:' suffix'}]}]})}));
  await page.locator('.is-pinned .observation-diff .added').filter({hasText:'+new suffix'}).waitFor();
  await page.evaluate(()=>window.__streams.at(-1).handlers.delta({data:JSON.stringify({sessionId:'fake-image-create',operations:[{type:'line.patch',id:'edit',patch:{live:false,titleStatus:'success',activity:{phase:'completed',input:{path:'a.ts',oldString:'old',newString:'new'}},observation:{patch:[{oldStart:1,oldLines:1,newStart:1,newLines:1,lines:['-actual','+applied']}]}}}]})}));
  await page.locator('.is-pinned .observation-diff .added').filter({hasText:'+applied'}).waitFor();
  assert.equal(await page.locator('.is-pinned .observation-diff.is-draft').count(),0);
  await page.locator('[data-tool=plan_update] .tool-activity-row').click();
  assert.equal(await page.locator('.is-pinned .activity-plan .activity-plan').count(),1);
  assert.ok(!(await page.locator('.tool-observation.is-pinned').innerText()).includes('进行中'));
  assert.equal(await page.locator('.image-delivery img').count(),1);
  assert.equal(await page.locator('.activity-image-placeholder').count(),1);
  const sizes=await page.locator('.activity-image-card').evaluateAll(cards=>cards.map(card=>Math.round(card.getBoundingClientRect().height)));
  assert.equal(sizes[0],sizes[1],'generated and pending image cards reserve the same height');
  await page.evaluate(()=>window.__streams.at(-1).handlers.delta({data:JSON.stringify({sessionId:'fake-image-create',operations:[{type:'line.patch',id:'current-result',patch:{titleStatus:'success',activity:{phase:'completed',input:{semanticName:'真实图片名称',prompt:'只出现一次的真实提示词',mode:'generate'}},imageResult:{model:'actual-model',size:'1024x1024',images:[{mimeType:'image/png',hasAlphaChannel:false,hasTransparentPixels:false}]}}}]})}));
  await page.locator('.image-delivery button[aria-label="详情"]').click();
  await page.locator('.tool-result-modal').waitFor();
  const detail=await page.locator('.tool-result-modal').innerText();
  assert.ok(detail.includes('actual-model'));assert.equal(detail.split('只出现一次的真实提示词').length-1,1);
  assert.equal(await page.locator('.tool-result-modal a[download]').count(),0);
  await page.getByRole('button',{name:'关闭工具结果',exact:true}).click();
  await page.locator('[data-tool=plan_update] .tool-activity-row').click();
  assert.equal(await page.locator('.activity-pin').count(),0);
  const deliver=async operations=>page.evaluate(operations=>window.__streams.at(-1).handlers.delta({data:JSON.stringify({sessionId:'fake-image-create',operations})}),operations);
  await page.evaluate(()=>window.__observerNode=document.querySelector('.tool-observation.is-main'));
  await deliver([{type:'line.append',line:{id:'early-write',kind:'tool',toolName:'file_write',toolUseId:'early-write-call',live:true,text:'',activity:{phase:'generating',input:{}}}}]);
  await page.locator('[data-tool=file_write]').waitFor();
  assert.ok(await page.evaluate(()=>window.__observerNode===document.querySelector('.tool-observation.is-main')));
  assert.equal(await page.locator('[data-tool=file_write] .activity-icon.active').count(),1);
  await deliver([{type:'line.activity.input',id:'early-write',changes:[{op:'set',path:['path'],value:'fresh.ts'},{op:'set',path:['content'],value:'first token'}]}]);
  await page.locator('[data-tool=file_write] .tool-activity-row').click();
  assert.match(await page.locator('.tool-observation.is-pinned').innerText(),/first token/);
  await deliver([{type:'line.activity.input',id:'early-write',changes:[{op:'append',path:['content'],value:' arrives now'}]}]);
  await page.getByText('first token arrives now',{exact:true}).waitFor();
  await deliver([{type:'line.append',line:{id:'plugin',kind:'tool',toolName:'expose_downloads',toolUseId:'plugin-call',live:true,text:'',activity:{phase:'generating',input:{paths:['a.txt']}}}}]);
  await page.locator('[data-tool=expose_downloads] .activity-plugin-placeholder').waitFor();
  await deliver([{type:'line.patch',id:'plugin',patch:{live:false,titleStatus:'success',resources:[{kind:'download',url:'/api/downloads/a',label:'a.txt',downloadName:'a.txt'}]}}]);
  await page.locator('.activity-file-card a[download="a.txt"]').waitFor();
  assert.equal(await page.locator('.tool-observation.is-pinned').count(),1);
  assert.equal(await page.locator('.activity-pin').count(),1);
  await deliver([{type:'line.append',line:{id:'terminal',kind:'tool',toolName:'terminal_run',toolUseId:'terminal-call',live:false,text:'',titleStatus:'success',activity:{phase:'completed',input:{cmd:'long command'}},observation:{status:'running',session_id:'real-run',stdout:'initial output'}}}]);
  await page.locator('[data-tool=terminal_run] .tool-activity-row').click();
  await page.locator('.is-pinned').getByText('real process output',{exact:true}).waitFor();
  assert.equal(await page.locator('.is-pinned .observation-command[data-command-phase=running]').count(),1);
  assert.equal(await page.locator('.is-pinned .observation-command[data-command-phase=completed]').count(),0);
  await page.evaluate(()=>window.__streams.at(-1).handlers.error({}));
  await page.waitForTimeout(100);const pausedRequests=terminalRequests;await page.waitForTimeout(1100);
  assert.equal(terminalRequests,pausedRequests);assert.equal(await page.locator('.tool-observation.is-pinned.is-paused').count(),1);
  terminalLifecycle='terminal';
  await page.evaluate(()=>{window.__streams.at(-1).handlers.open({});window.__streams.at(-1).handlers['terminal.output']({data:JSON.stringify({updates:[{ownerSessionId:'fake-image-create',sessionId:'real-run',invalidated:true}]})})});
  await page.locator('.is-pinned .observation-command[data-command-phase=completed]').waitFor();
  assert.equal(await page.locator('.tool-observation.is-pinned').count(),1);
  const density=await page.locator('[data-tool=file_edit] .tool-activity-row').evaluate(row=>{const icon=row.querySelector('.activity-icon'),text=row.querySelector('.activity-purpose');return {height:row.getBoundingClientRect().height,font:getComputedStyle(text).fontSize,gap:getComputedStyle(row).gap,icon:icon.getBoundingClientRect().width}});
  assert.deepEqual(density,{height:26,font:'12px',gap:'6px',icon:16});
  await deliver([{type:'line.append',line:{id:'sized-read',kind:'tool',toolName:'file_read',toolUseId:'sized-read-call',live:false,titleStatus:'success',text:'',activity:{phase:'completed',input:{path:'short.txt'}},observation:{content:'first visible line\nlast visible line\n\n\n'}}},{type:'line.append',line:{id:'after-observer',kind:'assistant',text:'Following assistant response',live:false}}]);
  await page.locator('[data-tool=file_read] .tool-activity-row').click();
  await page.waitForTimeout(1000);
  const observerLayout=()=>page.evaluate(()=>{const root=document.querySelector('.tool-observation.is-pinned'),view=root.querySelector('.tool-observation-viewport'),anchor=root.parentElement,next=document.querySelector('.message.assistant');return {root:root.getBoundingClientRect().height,view:view.getBoundingClientRect().height,anchor:anchor.getBoundingClientRect().height,anchorBottom:anchor.getBoundingClientRect().bottom,rootBottom:root.getBoundingClientRect().bottom,nextTop:next?.getBoundingClientRect().top,scroll:view.scrollHeight,client:view.clientHeight}});
  let layout=await observerLayout();
  assert.equal(layout.view,36,'two text lines use their real height without trailing blank lines');
  assert.equal(layout.root,50,'pinned observer adds compact padding and dashed border');
  assert.equal(layout.anchor,layout.root+6,'pinned anchor includes only the six-pixel top gap');
  assert.equal(layout.anchorBottom,layout.rootBottom,'no reserved blank space after the observer');
  assert.ok(Math.abs(layout.nextTop-layout.rootBottom)<=1,'hidden main leaves no reserved space');
  await deliver([{type:'line.patch',id:'sized-read',patch:{observation:{content:Array.from({length:40},(_,i)=>`line ${i}`).join('\n')}}}]);
  await page.waitForTimeout(2000);layout=await observerLayout();
  assert.equal(layout.view,190,'long text keeps its bounded reading viewport');assert.ok(layout.scroll>layout.client);
  assert.equal(await page.locator('.is-pinned').evaluate(el=>el.inert),false);
  await page.locator('.is-pinned .tool-observation-viewport').focus();
  await page.keyboard.press('Home');
  await page.waitForTimeout(350);
  assert.equal(await page.locator('.is-pinned .tool-observation-viewport').evaluate(el=>el.scrollTop),0,'pin supports keyboard scrolling');
  await deliver([{type:'line.patch',id:'sized-read',patch:{observation:{content:Array.from({length:45},(_,i)=>`updated ${i}`).join('\n')}}}]);
  await page.waitForTimeout(250);
  assert.equal(await page.locator('.is-pinned .tool-observation-viewport').evaluate(el=>el.scrollTop),0,'new output does not take over manual scroll');
  await page.locator('.is-pinned .tool-observation-viewport').hover();await page.mouse.wheel(0,120);await page.waitForTimeout(150);
  assert.ok(await page.locator('.is-pinned .tool-observation-viewport').evaluate(el=>el.scrollTop)>0,'pin supports mouse scrolling');
  await deliver([{type:'line.patch',id:'sized-read',patch:{observation:{content:'one short line'}}}]);
  await page.waitForTimeout(200);layout=await observerLayout();assert.equal(layout.view,18,'window shrinks again when content becomes short');assert.equal(layout.anchor,38);
  await deliver([{type:'line.patch',id:'sized-read',patch:{observation:{content:''}}}]);
  await page.waitForTimeout(200);layout=await observerLayout();assert.equal(layout.view,0,'empty content does not reserve a text window');
  await deliver([{type:'line.patch',id:'plan',patch:{activity:{phase:'completed',input:{items:[{description:'One compact task',status:'pending'}]}}}}]);
  await page.locator('[data-tool=plan_update] .tool-activity-row').click();
  await page.waitForTimeout(200);layout=await observerLayout();assert.equal(layout.view,24,'one plan item fits compact text and padding');
  const planDensity=await page.locator('.is-pinned .activity-plan-line').evaluate(el=>({font:getComputedStyle(el).fontSize,gap:getComputedStyle(el).gap,icon:el.querySelector('svg').getBoundingClientRect().width,width:el.getBoundingClientRect().width,parent:el.parentElement.getBoundingClientRect().width}));
  assert.equal(planDensity.font,'12px');assert.equal(planDensity.gap,'6px');assert.equal(planDensity.icon,13);assert.ok(planDensity.width<=planDensity.parent && planDensity.width<250,'plan frame and pinned window fit text rather than stretching');
  assert.equal(await page.locator('.is-pinned .tool-observation-viewport').evaluate(el=>getComputedStyle(el).fontSize),'11px');
  // Pinning never freezes automatic following; a new real target restores main.
  await deliver([{type:'line.append',line:{id:'next-live',kind:'tool',toolName:'file_write',toolUseId:'next-live-call',live:true,text:'',activity:{phase:'generating',input:{path:'next.ts',content:'new automatic target'}}}}]);
  await page.waitForTimeout(1100);
  assert.equal(await page.locator('.tool-observation.is-main').count(),1);
  assert.equal(await page.locator('.tool-observation.is-pinned').count(),1);
  assert.equal(await page.locator('.is-main pre').innerText(),'new automatic target');
  assert.equal(await page.locator('.tool-history-entry').filter({has:page.locator('[data-tool=plan_update]')}).locator('.tool-observation.is-pinned').count(),1,'pin lives directly below its own tool');
  assert.equal(await page.locator('.is-main').evaluate(el=>el.inert),true);
  assert.equal(await page.locator('.is-main').evaluate(el=>getComputedStyle(el).pointerEvents),'none');
  assert.equal(await page.locator('.is-main [tabindex="0"]').count(),0);
  assert.notEqual(await page.locator('.is-main .tool-observation-viewport').evaluate(el=>getComputedStyle(el).maskImage),'none');
  assert.equal(await page.locator('.is-pinned').evaluate(el=>getComputedStyle(el).borderTopStyle),'dashed');
  await page.locator('[data-tool=file_write]').last().locator('.tool-activity-row').click();
  await page.waitForTimeout(50);
  assert.equal(await page.locator('.main-observation-leave-active').count(),1,'main fades out before removal');
  await page.waitForTimeout(300);
  assert.equal(await page.locator('.tool-observation.is-main').count(),0,'same call is shown only in pinned window');
  assert.equal(await page.locator('.tool-observation.is-pinned').count(),1);
  await page.locator('[data-tool=file_write]').last().locator('.tool-activity-row').click();
  await page.waitForTimeout(50);
  assert.equal(await page.locator('.main-observation-enter-active').count(),1,'main fades back in on unpin');
  await page.waitForTimeout(300);
  assert.equal(await page.locator('.tool-observation.is-main').count(),1);
  assert.equal(await page.locator('.tool-observation.is-pinned').count(),0);
  await page.locator('[data-tool=plan_update] .tool-activity-row').click();
  await deliver([{type:'line.append',line:{id:'streaming-answer',kind:'assistant',text:'',live:true}}]);
  await page.waitForTimeout(80);assert.equal(await page.locator('.tool-observation.is-main').count(),1,'empty assistant placeholder keeps main');
  await deliver([{type:'line.text.append',id:'streaming-answer',text:'A real response begins'}]);
  await page.waitForTimeout(100);assert.equal(await page.locator('.main-observation-leave-active').count(),1,'first assistant text fades main out');
  await page.waitForTimeout(300);assert.equal(await page.locator('.tool-observation.is-main').count(),0);assert.equal(await page.locator('.tool-observation.is-pinned').count(),1,'assistant reply preserves pinned window');
  await deliver([{type:'line.patch',id:'next-live',patch:{activity:{phase:'generating',input:{content:'late old-tool update'}}}}]);
  await page.waitForTimeout(900);assert.equal(await page.locator('.tool-observation.is-main').count(),0,'old tool updates do not override an assistant reply');
  await deliver([{type:'line.append',line:{id:'after-answer-tool',kind:'tool',toolName:'file_read',toolUseId:'after-answer-tool-call',live:false,titleStatus:'success',activity:{phase:'completed',input:{path:'next.txt'}},observation:{content:'new tool phase'}}}]);
  await page.waitForTimeout(1000);assert.equal(await page.locator('.tool-observation.is-main').count(),1,'later tool phase restores main');
  await deliver([{type:'line.append',line:{id:'layout-user',kind:'user',text:'Build a small game in the current directory'}},{type:'line.append',line:{id:'layout-assistant',kind:'assistant',text:'I will inspect the files and create the game.',live:false}},{type:'line.append',line:{id:'layout-tool',kind:'tool',toolName:'file_write',toolUseId:'layout-tool-call',live:true,activity:{phase:'generating',input:{path:'game.html',description:'Create the game page',content:'<html>\n  <body>Game</body>\n</html>'}}}}]);
  await page.waitForTimeout(1000);
  const assertAlignment=async()=>{
    const alignment=await page.evaluate(()=>{const user=document.querySelector('.message.user .message-text'),assistant=[...document.querySelectorAll('.message.assistant .message-text')].at(-1),purpose=document.querySelector('[data-tool=file_write]:last-child .activity-purpose')||[...document.querySelectorAll('.activity-purpose')].at(-1),main=document.querySelector('.is-main .tool-observation-viewport'),pin=document.querySelector('.is-pinned .tool-observation-viewport');return {user:user.getBoundingClientRect().left,assistant:assistant.getBoundingClientRect().left,purpose:purpose.getBoundingClientRect().left,main:main.getBoundingClientRect().left,pin:pin.getBoundingClientRect().left}});
    const iconLeft=await page.locator('[data-tool=file_write] .tool-activity-row>.activity-icon').last().evaluate(el=>el.getBoundingClientRect().left);
    assert.ok(Math.abs(alignment.user-alignment.assistant)<=1,'user and assistant body left edges match');
    assert.ok(Math.abs(alignment.user-iconLeft)<=1,`body aligns with tool icon left edge: ${JSON.stringify({...alignment,iconLeft})}`);
    for(const name of ['main','pin'])assert.ok(Math.abs(alignment[name]-alignment.purpose)<=1,'observation content aligns with tool description');
    assert.ok(Math.abs(alignment.purpose-iconLeft-22)<=1,'tool text follows the 16px icon and 6px gap');
    assert.equal(await page.locator('.message.user .message-head,.message.assistant .message-head').count(),0,'rows omit repeated role heading rows');
    assert.equal(await page.locator('.message.user .message-marker,.message.assistant .message-marker,.conversation-role-icon').count(),0,'no role icons or reserved role column');
    assert.equal(await page.locator('.message.user>.message-body').evaluate(el=>getComputedStyle(el).borderTopWidth),'1px');
    assert.equal(await page.locator('.message.assistant').last().evaluate(el=>getComputedStyle(el).display),'block');
  };
  await page.locator('.transcript').evaluate(el=>{el.scrollTop=el.scrollHeight;el.dispatchEvent(new Event('scroll'))});
  await page.locator('.message.user .message-text').waitFor();
  await assertAlignment();
  assert.equal(await page.locator('.transcript').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(255, 255, 255)');
  assert.equal(await page.locator('.tool-activity-row').last().evaluate(el=>getComputedStyle(el).color),'rgb(66, 76, 89)');
  await page.getByRole('button',{name:'切换到夜间模式'}).click();
  assert.equal(await page.locator('html').getAttribute('data-theme'),'dark');
  await page.waitForTimeout(400);
  assert.equal(await page.locator('.transcript').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(17, 20, 24)');
  assert.equal(await page.locator('.message.user>.message-body').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(25, 30, 37)');
  assert.equal(await page.locator('.tool-activity-row').last().evaluate(el=>getComputedStyle(el).color),'rgb(154, 164, 178)');
  assert.equal(await page.locator('.tool-activity-row>.activity-icon').last().evaluate(el=>getComputedStyle(el).color),'rgb(187, 142, 166)');
  assert.equal(await page.locator('.message.assistant .message-text').last().evaluate(el=>getComputedStyle(el).color),'rgb(215, 220, 227)');
  await deliver([{type:'line.patch',id:'layout-tool',patch:{live:false,titleStatus:'failure',activity:{phase:'failed',input:{path:'game.html',description:'Create the game page'}},toolError:'Command failed'}}]);
  assert.equal(await page.locator('[data-tool=file_write] .tool-activity-row>.activity-icon.failed').last().evaluate(el=>getComputedStyle(el).color),'rgb(187, 142, 166)','failure keeps the original tool icon color');
  await assertAlignment();
  if(process.env.NEO_ACTIVITY_SCREENSHOT)await page.screenshot({path:process.env.NEO_ACTIVITY_SCREENSHOT});
  await page.setViewportSize({width:390,height:844});
  await page.waitForTimeout(200);await assertAlignment();
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await deliver([{type:'line.patch',id:'terminal',patch:{titleStatus:'failure',activity:{phase:'failed',input:{cmd:'failed command'}},observation:{exit_code:3,stdout:'Actual command failure'}}}]);
  const commandIcon=page.locator('[data-tool=terminal_run] .tool-activity-row>.activity-icon.failed');
  assert.equal(await commandIcon.evaluate(el=>getComputedStyle(el).color),'rgb(187, 142, 166)','failed command icon does not turn red');
  await page.locator('[data-tool=terminal_run] .tool-activity-row').click();
  await page.locator('.is-pinned .observation-command[data-command-phase=failed]').waitFor();
  assert.equal(await page.locator('.is-pinned .observation-command svg,.is-pinned .command-phase').count(),0,'command observation has no duplicate status glyph');
  assert.deepEqual(errors,[]);
  await page.reload();
  await page.locator('.tool-activity-entry').first().waitFor();
  assert.equal(await page.locator('.tool-activity-entry.is-entering').count(),0);
  assert.equal(await page.locator('.activity-pin').count(),0);
  assert.equal(await page.evaluate(()=>localStorage.getItem('neo-tool-history-view')),'folded','legacy preference remains ignored and is not rewritten');
  assert.equal(await page.locator('.rows-transcript').count(),1);
  await deliver([{type:'line.patch',id:'current-live',patch:{live:false,titleStatus:'success'}},{type:'line.append',line:{id:'status-answer',kind:'assistant',text:'A completed answer remains visible',live:false}}]);
  await deliver([{type:'line.append',line:{id:'purpose-stream',kind:'tool',toolName:'file_read',toolUseId:'purpose-stream-call',live:true,activity:{phase:'generating',input:{path:'src/purpose.ts'}}}}]);
  const purposeRow=page.locator('[data-tool=file_read]').last().locator('.activity-purpose');
  assert.equal(await purposeRow.innerText(),'读取 src/purpose.ts');
  await deliver([{type:'line.activity.input',id:'purpose-stream',changes:[{op:'set',path:['description'],value:'核对新增'}]}]);
  assert.equal(await purposeRow.innerText(),'核对新增');
  await deliver([{type:'line.activity.input',id:'purpose-stream',changes:[{op:'append',path:['description'],value:'配置的兼容性'}]}]);
  assert.equal(await purposeRow.innerText(),'核对新增配置的兼容性');
  await deliver([{type:'line.patch',id:'purpose-stream',patch:{live:false,titleStatus:'success',activity:{phase:'completed',input:{description:'核对新增配置的兼容性',path:'src/purpose.ts'}}}}]);
  assert.equal(await purposeRow.innerText(),'核对新增配置的兼容性');
  const setStatus=async status=>page.evaluate(status=>window.__streams.at(-1).handlers.delta({data:JSON.stringify({sessionId:'fake-image-create',status,operations:[]})}),status);
  await setStatus({phase:'calling_model',modelOutput:{kind:'text'}});
  await page.waitForFunction(()=>document.querySelector('.message-loading-label')?.getAttribute('aria-label')==='生成回复');
  await setStatus({phase:'calling_model'});
  await page.waitForFunction(()=>document.querySelector('.message-loading-label')?.getAttribute('aria-label')==='调用模型');
  assert.ok(await page.locator('.message.assistant').count()>0,'existing assistant text cannot keep a stale output phase');
  await setStatus({phase:'calling_model',modelOutput:{kind:'tool_call'}});
  await page.waitForFunction(()=>document.querySelector('.message-loading-label')?.getAttribute('aria-label')==='准备工具');
  await setStatus({phase:'stopped'});
  await page.waitForFunction(()=>document.querySelector('.message-loading-label')?.getAttribute('aria-label')==='已暂停');
  await deliver([{type:'line.append',line:{id:'thinking-icon',kind:'thinking',text:'Compare the available approaches before choosing a change.',live:true}}]);
  const thinking=page.locator('.reasoning-icon');
  await thinking.waitFor();
  assert.equal(await thinking.getAttribute('aria-label'),'思考');
  assert.equal(await thinking.evaluate(el=>el.getBoundingClientRect().width),16);
  assert.equal(await thinking.evaluate(el=>getComputedStyle(el).color),'rgb(187, 142, 166)');
  assert.equal(await thinking.locator('.thought').first().evaluate(el=>getComputedStyle(el).animationName),'tool-motion-thought');
  assert.equal(await page.locator('.reasoning-title-mark').count(),0);
  await page.evaluate(()=>window.__streams.at(-1).handlers.error({}));
  assert.equal(await thinking.locator('.motion').first().evaluate(el=>getComputedStyle(el).animationPlayState),'paused');
  await page.evaluate(()=>window.__streams.at(-1).handlers.open({}));
  snapshot.lines.push({id:'thinking-icon',kind:'thinking',text:'Compare the available approaches before choosing a change.',live:true});
  snapshot.runControl={state:'paused',canResume:true};
  await page.evaluate(snapshot=>window.__streams.at(-1).handlers.sync({data:JSON.stringify(snapshot)}),snapshot);
  await page.waitForFunction(()=>getComputedStyle(document.querySelector('.reasoning-icon .motion')).animationPlayState==='paused');
  snapshot.runControl={state:'running',canResume:false};
  await page.evaluate(snapshot=>window.__streams.at(-1).handlers.sync({data:JSON.stringify(snapshot)}),snapshot);
  await page.waitForFunction(()=>getComputedStyle(document.querySelector('.reasoning-icon .motion')).animationPlayState==='running');
  await page.emulateMedia({reducedMotion:'reduce'});
  assert.equal(await thinking.locator('.motion').first().evaluate(el=>getComputedStyle(el).animationName),'none');
  await page.emulateMedia({reducedMotion:'no-preference'});
  await page.setViewportSize({width:1440,height:1000});
  if(process.env.NEO_THINKING_SCREENSHOT)await page.screenshot({path:process.env.NEO_THINKING_SCREENSHOT});
  await deliver([{type:'line.patch',id:'thinking-icon',patch:{live:false}}]);
  assert.equal(await thinking.locator('.motion').first().evaluate(el=>getComputedStyle(el).animationName),'none');
  await page.getByRole('button',{name:'切换到日间模式'}).click();
  assert.equal(await thinking.evaluate(el=>getComputedStyle(el).color),'rgb(148, 101, 126)');
  // Empty/open and completed/closed thoughts must occupy the same rhythm as tools.
  snapshot.lines=[
    {id:'rhythm-before',kind:'tool',toolName:'file_list',toolUseId:'rhythm-before-call',live:false,activity:{phase:'completed',input:{path:'src'}}},
    {id:'rhythm-done',kind:'thinking',text:'Completed reasoning content',live:false},
    {id:'rhythm-between',kind:'tool',toolName:'file_read',toolUseId:'rhythm-between-call',live:false,activity:{phase:'completed',input:{path:'a.ts'}}},
    {id:'rhythm-live',kind:'thinking',text:'  ',live:true},
    {id:'rhythm-after',kind:'tool',toolName:'file_edit',toolUseId:'rhythm-after-call',live:false,activity:{phase:'completed',input:{path:'b.ts'}}},
  ];
  snapshot.status={phase:'thinking'};
  await page.evaluate(snapshot=>window.__streams.at(-1).handlers.sync({data:JSON.stringify(snapshot)}),snapshot);
  await page.locator('.thinking-activity-row .reasoning-icon.active').waitFor();
  await page.waitForTimeout(500);
  const rhythm=await page.evaluate(()=>{const all=[...document.querySelectorAll('.tool-activity-row')];return all.map(el=>({top:el.getBoundingClientRect().top,height:el.getBoundingClientRect().height,iconLeft:el.querySelector('svg').getBoundingClientRect().left,textLeft:el.querySelector('.activity-purpose,.reasoning-heading').getBoundingClientRect().left}))});
  assert.equal(rhythm.length,5);
  for(let i=1;i<rhythm.length;i++){
    assert.equal(rhythm[i].height,26,'thinking uses the tool row height');
    assert.ok(Math.abs(rhythm[i].top-rhythm[i-1].top-26)<=1,`no blank space between process rows: ${JSON.stringify(rhythm)}`);
    assert.equal(rhythm[i].iconLeft,rhythm[0].iconLeft);
    assert.equal(rhythm[i].textLeft,rhythm[0].textLeft);
  }
  assert.equal(await page.locator('.thinking-history-entry .reasoning-reveal').count(),0,'thinking uses observations rather than a separate disclosure');
  const activeThought=page.locator('.thinking-activity-row .reasoning-icon.active .thought').first();
  const frame1=await activeThought.evaluate(el=>({opacity:getComputedStyle(el).opacity,dash:getComputedStyle(el).strokeDashoffset}));
  await page.waitForTimeout(650);
  const frame2=await activeThought.evaluate(el=>({opacity:getComputedStyle(el).opacity,dash:getComputedStyle(el).strokeDashoffset}));
  assert.notDeepEqual(frame1,frame2,'active thinking actually changes its SVG drawing between frames');
  const thoughtRow=page.locator('.thinking-activity-row').first();
  await thoughtRow.click();
  await page.locator('.is-pinned .observation-thinking').waitFor();
  assert.equal(await thoughtRow.locator('.activity-pin').count(),1);
  assert.equal(await page.locator('.is-pinned').evaluate(el=>getComputedStyle(el).borderTopStyle),'dashed');
  await deliver([{type:'line.patch',id:'rhythm-done',patch:{text:'### Planning scoped implementation steps\n\n**Keep consistent**'}}]);
  const contentStyle=await page.locator('.is-pinned .observation-thinking h3').evaluate(el=>({font:getComputedStyle(el).fontSize,line:getComputedStyle(el).lineHeight,color:getComputedStyle(el).color,weight:getComputedStyle(el).fontWeight}));
  assert.deepEqual(contentStyle,{font:'11px',line:'18px',color:'rgb(32, 37, 45)',weight:'400'});
  await thoughtRow.click();
  assert.equal(await page.locator('.is-pinned').count(),0);
  await deliver([{type:'line.patch',id:'rhythm-live',patch:{text:'Current live reasoning'}}]);
  await page.locator('.thinking-activity-row').last().click();
  await page.waitForTimeout(1200);
  assert.equal(await page.locator('.is-main').count(),0,'same pinned and automatic thinking target is not duplicated');
  await deliver([{type:'line.patch',id:'rhythm-between',patch:{activity:{phase:'running',input:{path:'updated.ts'}},observation:{content:'updated tool output'}}}]);
  await page.waitForTimeout(1000);
  assert.equal(await page.locator('.is-main').count(),1,'a different automatic tool target can coexist with pinned thinking');
  await deliver([{type:'line.append',line:{id:'thinking-reply',kind:'assistant',text:'Actual assistant reply',live:true}}]);
  await page.waitForTimeout(300);
  assert.equal(await page.locator('.is-main').count(),0);
  assert.equal(await page.locator('.is-pinned').count(),1,'reply preserves pinned thinking');
  if(process.env.NEO_THINKING_SCREENSHOT)await page.screenshot({path:process.env.NEO_THINKING_SCREENSHOT});
  // Each newly formed group plays for two seconds independent of lifecycle.
  const linkedLines=(prefix)=>[
    {id:prefix+'-first',kind:'tool',toolName:'file_read',toolUseId:prefix+'-first-call',live:false,connectPreviousTool:false,activity:{phase:'completed',input:{path:'a.ts'}},observation:{content:'first line\nsecond line'}},
    {id:prefix+'-thought',kind:'thinking',text:'Reason between tools',live:false},
    {id:prefix+'-second',kind:'tool',toolName:'file_list',toolUseId:prefix+'-second-call',live:true,connectPreviousTool:true,activity:{phase:'queued',input:{path:'src'}}},
    {id:prefix+'-third',kind:'tool',toolName:'file_search',toolUseId:prefix+'-third-call',live:true,connectPreviousTool:true,activity:{phase:'generating',input:{query:'term'}}},
  ];
  const syncLinked=async(prefix)=>{
    snapshot.lines=linkedLines(prefix);snapshot.status={phase:'calling_model'};snapshot.runControl={state:'running',canResume:false};
    await page.evaluate(snapshot=>window.__streams.at(-1).handlers.sync({data:JSON.stringify(snapshot)}),snapshot);
    await page.locator('.tool-turn-connector.is-last').waitFor();
    await page.waitForTimeout(30);
  };
  const assertConnectionLayout=async(label)=>{
    const result=await page.evaluate(()=>{
      const links=[...document.querySelectorAll('.tool-turn-connector:not(.tool-turn-leave-active)')],r=el=>el.getBoundingClientRect();
      let joinError=0,branchError=0;const xs=[];
      for(let i=0;i<links.length;i++){
        const link=links[i],row=link.parentElement,stem=link.querySelector('.tool-turn-stem'),branch=link.querySelector('svg');
        if(i)joinError=Math.max(joinError,Math.abs(r(link).top-r(links[i-1]).bottom));
        if(branch){const icon=row.querySelector('.tool-activity-row>.activity-icon');branchError=Math.max(branchError,Math.abs(r(branch).top+13-(r(icon).top+r(icon).height/2)));xs.push(r(icon).left)}
        if(link.classList.contains('is-last'))branchError=Math.max(branchError,Math.abs(r(stem).bottom-(r(branch).top+9)));
      }
      const pin=document.querySelector('.is-pinned .tool-observation-viewport');
      return {count:links.length,joinError,branchError,xs,pinHeight:pin?r(pin).height:null,pinScroll:pin?pin.scrollHeight:null};
    });
    assert.equal(result.count,4,label);
    assert.ok(result.joinError<=1,`${label}: continuous stems ${JSON.stringify(result)}`);
    assert.ok(result.branchError<=1,`${label}: branches stay on icon centers ${JSON.stringify(result)}`);
    assert.equal(new Set(result.xs).size,1,`${label}: icon alignment unchanged`);
    return result;
  };
  const assertConnectionFrames=async(label)=>{
    const error=await page.evaluate(async()=>{
      let max=0;
      for(let frame=0;frame<5;frame++){
        await new Promise(requestAnimationFrame);
        const links=[...document.querySelectorAll('.tool-turn-connector:not(.tool-turn-leave-active)')];
        for(let i=1;i<links.length;i++)max=Math.max(max,Math.abs(links[i].getBoundingClientRect().top-links[i-1].getBoundingClientRect().bottom));
      }
      return max;
    });
    assert.ok(error<=1,`${label}: no transient gap (${error}px)`);
  };
  for(const [tool,suffix] of [['file_read','first'],['file_list','second'],['file_search','third']]){
    const prefix='pin-'+suffix,id=prefix+'-'+suffix;
    await syncLinked(prefix);
    await page.locator(`[data-tool=${tool}] .tool-activity-row`).click();
    await assertConnectionFrames(`${tool} opening`);
    const output=Array.from({length:45},(_,i)=>`actual output ${i}`).join('\n');
    await deliver([{type:'line.patch',id,patch:{live:false,activity:{...snapshot.lines.find(line=>line.id===id).activity,phase:'completed'},toolStream:{output},observation:{content:output}}}]);
    await assertConnectionFrames(`${tool} growing`);
    const long=await assertConnectionLayout(`${tool} long pin`);assert.equal(long.pinHeight,190);assert.ok(long.pinScroll>long.pinHeight);
    await page.locator('.is-pinned .tool-observation-viewport').evaluate(el=>{el.scrollTop=80});
    await assertConnectionLayout(`${tool} scrolling`);
    await deliver([{type:'line.patch',id,patch:{toolStream:{output:'one short line'},observation:{content:'one short line'}}}]);
    await assertConnectionFrames(`${tool} shrinking`);
    assert.equal((await assertConnectionLayout(`${tool} short pin`)).pinHeight,18);
    await page.locator(`[data-tool=${tool}] .tool-activity-row`).click();
    await assertConnectionFrames(`${tool} collapse`);
    assert.equal(await page.locator('.is-pinned').count(),0);
    await assertConnectionLayout(`${tool} collapsed`);
    await page.waitForTimeout(2250);
  }
  console.log('PASS pin connector geometry: first/middle/last, growing/shrinking/scroll/collapse, per-frame joins and branches within 1px');
  await syncLinked('timed');
  const started=Date.now();
  await page.locator('[data-tool=file_read] .tool-activity-row').click();
  const branch=page.locator('.tool-turn-connector .active .route').first();
  assert.equal(await branch.evaluate(el=>getComputedStyle(el).animationDuration),'2s');
  assert.equal(await branch.evaluate(el=>getComputedStyle(el).animationIterationCount),'1');
  snapshot.runControl={state:'paused',canResume:true};
  await page.evaluate(snapshot=>window.__streams.at(-1).handlers.sync({data:JSON.stringify(snapshot)}),snapshot);
  await deliver([{type:'line.append',line:{id:'timed-reply',kind:'assistant',text:'Reply must not end the two second animation'}}]);
  await page.waitForTimeout(Math.max(0,1400-(Date.now()-started)));
  assert.equal(await page.locator('.tool-turn-connector:not(.tool-turn-leave-active)').count(),4,'pause/model/reply do not shorten playback');
  await page.locator('.tool-turn-leave-active').first().waitFor({timeout:1500});
  assert.ok(Date.now()-started>=1800,'fade starts only near the two second deadline');
  await page.waitForTimeout(300);
  assert.equal(await page.locator('.tool-turn-connector').count(),0);
  assert.equal(await page.locator('.is-pinned').count(),1,'expiry preserves pin');
  await deliver([{type:'line.patch',id:'timed-second',patch:{live:false}}]);
  await page.waitForTimeout(100);assert.equal(await page.locator('.tool-turn-connector').count(),0,'updates never replay expired animation');
  console.log('PASS fixed 2s connection playback: independent of model/reply/pause; no replay; pin retained');
  snapshot.lines=Array.from({length:180},(_,i)=>i%2?{id:`scroll-thought-${i}`,kind:'thinking',text:'Historical reasoning text',live:false}:{id:`scroll-tool-${i}`,kind:'tool',toolName:'file_list',toolUseId:`scroll-call-${i}`,live:false,activity:{phase:'completed',input:{path:`folder-${i}`}}});
  await page.evaluate(snapshot=>window.__streams.at(-1).handlers.sync({data:JSON.stringify(snapshot)}),snapshot);
  await page.waitForTimeout(200);
  const scrollFrames=await page.evaluate(async()=>{
    const scroller=document.querySelector('.transcript');let maxError=0;
    for(const ratio of [0,.8,.2,1,0]){
      scroller.scrollTop=(scroller.scrollHeight-scroller.clientHeight)*ratio;
      scroller.dispatchEvent(new Event('scroll'));
      for(let f=0;f<3;f++){
        await new Promise(requestAnimationFrame);
        const rows=[...document.querySelectorAll('.virtual-message-row')].map(el=>({i:Number(el.dataset.index),top:el.getBoundingClientRect().top,height:el.getBoundingClientRect().height})).sort((a,b)=>a.i-b.i);
        for(let i=1;i<rows.length;i++)if(rows[i].i===rows[i-1].i+1)maxError=Math.max(maxError,Math.abs(rows[i].top-rows[i-1].top-rows[i-1].height));
      }
    }return maxError;
  });
  assert.ok(scrollFrames<=1,`history scroll has no estimate-to-measurement gaps: ${scrollFrames}`);
  snapshot.lines=[{id:'fixed-rows-user',kind:'user',text:'Original user message'},{id:'fixed-rows-assistant',kind:'assistant',text:'Original assistant response'},{id:'fixed-rows-thinking',kind:'thinking',text:'Completed thought',live:false}];
  await page.evaluate(()=>localStorage.setItem('neo-tool-history-view','folded'));
  await page.reload();
  await page.locator('.rows-transcript').waitFor();
  assert.equal(await page.locator('.message.user .message-head').count(),0,'fixed rows keeps role headings hidden');
  assert.equal(await page.locator('.message.user .message-marker-icon').count(),0,'fixed rows keeps role markers hidden');
  assert.equal(await page.locator('.history-view-setting').count(),0,'frontend exposes no history-view modifier');
  assert.deepEqual(errors,[]);
  console.log('PASS fixed rows: incremental drafts, main/pin windows, manual scroll, reply transitions, recursive plan, image/plugin placeholders, terminal lifecycle, themes/colors/alignment, narrow layout, reload and ignored legacy preference');

} finally {
  await browser?.close()
  await new Promise((resolveClose) => server.close(resolveClose))
}
