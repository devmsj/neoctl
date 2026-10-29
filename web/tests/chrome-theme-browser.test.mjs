import { deriveSurfaces, DEFAULT_COLORS, emptyAppearance } from '../shared/appearance.mjs'
import { openGlobalSettings } from './settings-navigation.mjs'
// Run after npm run build. No model calls or real configuration writes.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, mkdir } from 'node:fs/promises'
import { resolve, extname } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
const dist=fileURLToPath(new URL('../dist/',import.meta.url))
const require=createRequire(import.meta.url)
const {chromium}=require(process.env.PLAYWRIGHT_CORE_PATH||process.env.NEO_PLAYWRIGHT_MODULE||'../../desktop/.cache/ui-test/node_modules/playwright-core')
const server=createServer(async(req,res)=>{try{const path=resolve(dist,req.url==='/'?'index.html':`.${req.url}`);res.setHeader('Content-Type',{'.html':'text/html','.css':'text/css','.js':'text/javascript'}[extname(path)]||'application/octet-stream');res.end(await readFile(path))}catch{res.writeHead(404);res.end()}})
await new Promise(r=>server.listen(0,'127.0.0.1',r))
let browser
try {
 browser=await chromium.launch({channel:'msedge',headless:true})
 const page=await browser.newPage({viewport:{width:1720,height:1000}})
 const errors=[];page.on('pageerror',e=>errors.push(e.message))
 const now=new Date().toISOString()
 const session={sessionId:'theme-review',title:'检查本机状态',updatedAt:now}
 const snapshot={busy:false,cwd:'C:\\workspace',session,catalog:{commands:[],modelIds:['gpt-5.6-luna'],reasoning:['default','high']},interactive:{},backgroundTasks:[],agentTaskHistory:[],backgroundTaskCount:0,status:{phase:'idle'},lines:[
  {id:'user',kind:'user',text:'查看当前目录并检查本机运行状态'},
  {id:'intro',kind:'assistant',text:'我会检查当前目录与运行状态，再汇总需要关注的信息。'},
  {id:'tool',kind:'tool',toolName:'terminal_run',toolUseId:'command',titleStatus:'failure',activity:{phase:'failed',input:{cmd:'Get-ComputerInfo',description:'检查本机运行状态'}},observation:{session_id:'theme-terminal',exit_code:1,stdout:'操作系统  Windows 11\n内存  32 GB\n当前目录  C:\\workspace'}},
  {id:'reply',kind:'assistant',text:'当前目录包含项目源码与运行数据。\n\n系统运行正常，部分诊断信息需要进一步确认。'}]}
 await page.addInitScript(()=>{localStorage.setItem('neo-tool-history-view','folded');localStorage.setItem('neoctl-web.theme','dark');window.EventSource=class{addEventListener(){}close(){}}})
 let appearance={...emptyAppearance(),mode:'dark'}
 await page.route('**/api/**',route=>{
  const path=new URL(route.request().url()).pathname
  let json={}
  if(path==='/api/appearance'){if(route.request().method()==='PUT')appearance=route.request().postDataJSON().config;json={config:appearance,revision:'1'}}
  else if(path==='/api/auth/status')json={isolation:false,user:null}
  else if(path==='/api/state')json=snapshot
  else if(path==='/api/sessions'){
   const params=new URL(route.request().url()).searchParams
   const all=[session,{sessionId:'prior-session',title:'工具历史展示优化',updatedAt:now}]
   const sessions=all.filter(item=>item.title.includes(params.get('q')||''))
   json={sessions,runningSessionIds:[],page:1,pageSize:10,total:sessions.length,totalCount:all.length,totalPages:1}
  }
  else if(path==='/api/login')json={provider:'openai',providers:['openai','anthropic'],fields:[{key:'baseUrl',label:'Base URL'},{key:'apiKey',label:'API Key',secret:true},{key:'model',label:'模型',options:['gpt-5.6-luna']}],values:{baseUrl:'https://example.invalid/v1',model:'gpt-5.6-luna'}}
  else if(path==='/api/tools')json={items:[{name:'file_read',source:'builtin',configuredEnabled:true},{name:'framework_feedback',source:'builtin',configuredEnabled:false}]}
  else if(path==='/api/plugins')json={items:[{id:'sample',name:'工作区插件',tools:['sample_tool'],configuredEnabled:true}],installationSupported:false}
  else if(path==='/api/prompt-library')json={items:[{id:'code-review',title:'代码审查',content:'检查代码正确性与可维护性'}]}
  else if(path==='/api/prompt-config')json={content:'在完成用户任务的前提下，优先使用结构化工具。',defaultContent:'默认提示词'}
  else if(path==='/api/framework-feedback')json={items:[{id:'feedback-one',title:'结构化工具参数',body:'问题：参数不完整。复现：省略目的。改进：补充结构化描述。',createdAt:now}],page:1,total:1,totalPages:1}
  else if(path==='/api/cpa-quota')json={quotas:[{account:'workspace',remainingPercent:91,usedPercent:9,resetAt:now,updatedAt:now}],config:{url:'',hasPassword:false}}
  else if(path==='/api/memory')json={current:{at:now,rss:104857600,heapUsed:25165824,external:4194304},history:[{at:now,rss:104857600}],sampleMs:60000}
  else if(path==='/api/terminal-output'){const stream=new URL(route.request().url()).searchParams.get('stream');const text=stream==='stdout'?'操作系统  Windows 11\n内存  32 GB\n当前目录  C:\\workspace':'';json={sessionId:session.sessionId,runId:'theme-terminal',stream,offset:0,nextOffset:Buffer.byteLength(text),text,endOfStoredOutput:true,record:{availability:'available',lifecycle:'terminal',exit:{exitCode:1},streams:{stdout:{storedBytes:Buffer.byteLength(text)},stderr:{storedBytes:0}}}}}
  else if(path==='/api/cwd/scope')json={ok:true,paths:['C:\\workspace']}
  else if(path==='/api/cwd')json={cwd:'C:\\workspace',parent:'C:\\',entries:[{name:'src',path:'C:\\workspace\\src',isDirectory:true}],locations:[]}
  return route.fulfill({json})
 })
 await page.goto(`http://127.0.0.1:${server.address().port}/`)
 await page.locator('.tool-activity-row').waitFor()
 assert.equal(await page.locator('.rows-transcript').count(),1,'legacy folded preference is ignored')
 await page.waitForFunction(()=>document.documentElement.dataset.theme==='dark'); await page.waitForTimeout(250)
 const styleOf=async(selector)=>page.locator(selector).first().evaluate(el=>{const s=getComputedStyle(el);return{background:s.backgroundColor,color:s.color,border:s.borderTopWidth,borderColor:s.borderTopColor,radius:s.borderTopLeftRadius,shadow:s.boxShadow,font:s.fontSize,weight:s.fontWeight}})
 const screenshot=async(name)=>{await mkdir('web/.run',{recursive:true});await page.screenshot({path:`web/.run/chrome-${name}.png`})}
 const surfaces=deriveSurfaces(DEFAULT_COLORS.dark.background,'dark'), rgb=hex=>'rgb('+[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)).join(', ')+')'
 assert.equal((await styleOf('.sidebar')).background,rgb(surfaces.panel))
 assert.equal((await styleOf('.composer')).border,'1px')
 assert.equal((await styleOf('.composer')).shadow,'none')
 assert.equal((await styleOf('.composer textarea')).border,'0px')
 assert.equal((await styleOf('.composer textarea')).background,'rgba(0, 0, 0, 0)')
 assert.equal((await styleOf('.right-panel .quota-card')).background,rgb(surfaces.panel))
 assert.equal((await styleOf('.transcript')).background,'rgb(17, 20, 24)')
 assert.equal((await styleOf('.tool-activity-row')).font,'12px')
 assert.equal((await styleOf('.activity-icon.failed')).color,'rgb(187, 142, 166)')
 assert.equal((await styleOf('.message.assistant .message-text')).font,'15px')
 assert.equal(await page.locator('.message.user .message-head').count(),0)
 assert.equal(await page.locator('.memory-stats, .memory-card-foot, .memory-card-head small, .quota-card-foot, .quota-card-update').count(),0,'secondary technical details removed')
 assert.equal(await page.locator('.right-panel').getByText(/RSS|V8 堆|外部内存|更新于/).count(),0)
 assert.equal(await page.locator('.memory-card-head strong').textContent(),'100 MB')
 assert.ok(await page.locator('.memory-card').evaluate(el=>el.getBoundingClientRect().height<120),'memory card stays compact')
 assert.equal(await page.locator('.quota-progress').getAttribute('aria-valuenow'),'91')
 await page.locator('.memory-trend-point').first().focus()
 await page.locator('.memory-tooltip').waitFor()
 await page.locator('.composer textarea').focus()
 await screenshot('dark-chat')
 await openGlobalSettings(page)
 await page.getByRole('button',{name:'模型',exact:true}).click()
 await page.locator('.settings-form').waitFor()
 assert.equal((await styleOf('.settings-card')).border,'1px')
 assert.equal((await styleOf('.settings-card')).shadow,'none')
 assert.equal((await styleOf('.settings-form input')).background,rgb(surfaces.surface))
 assert.equal(await page.locator('.history-view-setting').count(),0,'history view modification is hidden')
 assert.equal(await page.getByText('历史展示',{exact:true}).count(),0)
 await screenshot('dark-settings')
 await page.getByRole('button',{name:'返回全局配置',exact:true}).click()
 await page.getByRole('button',{name:'框架改进建议',exact:true}).click()
 await page.locator('.feedback-item').waitFor()
 await page.locator('.feedback-item button').click()
 await page.locator('[role=alertdialog]').waitFor()
 assert.equal((await styleOf('[role=alertdialog]')).background,rgb(surfaces.surface))
 assert.equal((await styleOf('[role=alertdialog]')).border,'1px')
 await screenshot('dark-confirm')
 await page.getByRole('button',{name:'取消',exact:true}).click()
 await page.getByRole('button',{name:'返回全局配置',exact:true}).click()
 await page.locator('.sidebar').getByRole('button',{name:'会话管理',exact:true}).click()
 await page.locator('.session-card').first().waitFor()
 assert.equal((await styleOf('.session-card')).border,'0px')
 assert.equal((await styleOf('.session-card')).shadow,'none')
 await page.locator('.session-search input').fill('工具历史')
 await page.waitForFunction(()=>document.querySelectorAll('.session-card').length===1)
 assert.equal(await page.locator('.session-card').count(),1)
 await screenshot('dark-sessions')
 await page.locator('.quick-session[aria-current="true"]').click()
 await page.getByRole('button',{name:'工作区范围',exact:true}).click()
 await page.getByRole('dialog',{name:'工作区范围',exact:true}).getByRole('button',{name:'添加路径',exact:true}).click()
 await page.locator('.cwd-picker-modal').waitFor()
 assert.equal((await styleOf('.cwd-picker-modal')).background,rgb(surfaces.surface))
 await screenshot('dark-directory')
 await page.locator('.cwd-picker-modal').getByRole('button',{name:'取消',exact:true}).click()
 await page.getByRole('dialog',{name:'工作区范围',exact:true}).getByRole('button',{name:'关闭',exact:true}).click()
 await page.getByRole('button',{name:'应用菜单',exact:true}).click(); await page.locator('.sidebar-actions-menu [data-theme-cycle]').click(); await page.waitForFunction(()=>document.documentElement.dataset.appearanceMode==='system')
 await page.waitForFunction(()=>document.documentElement.dataset.theme==='light'); await page.waitForTimeout(250)
 assert.equal((await styleOf('.sidebar')).background,'rgb(255, 255, 255)')
 assert.equal((await styleOf('.composer')).background,'rgb(255, 255, 255)')
 assert.equal((await styleOf('.transcript')).background,'rgb(255, 255, 255)')
 await page.locator('.tool-activity-row').click()
 await page.locator('.is-pinned .background-task-live-output').waitFor()
 await page.waitForFunction(()=>{const el=document.querySelector('.is-pinned .background-task-live-output');return el&&getComputedStyle(el).color==='rgb(32, 37, 45)'})
 assert.equal(await page.locator('.is-pinned .tool-observation-viewport').evaluate(el=>getComputedStyle(el).opacity),'1')
 await screenshot('light-chat')
 await openGlobalSettings(page)
 await page.getByRole('button',{name:'模型',exact:true}).click()
 await page.locator('.settings-form').waitFor()
 assert.equal((await styleOf('.settings-form input')).background,'rgb(255, 255, 255)')
 await screenshot('light-settings')
 await page.setViewportSize({width:390,height:844})
 await page.waitForTimeout(200)
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no horizontal document overflow')
 assert.ok(await page.locator('.settings-page').evaluate(el=>el.scrollWidth<=el.clientWidth+1),'settings fit narrow screen')
 await screenshot('mobile-settings')
 await page.locator('.mobile-nav-menu summary').click()
 await page.locator('.mobile-nav-menu nav button').filter({hasText:/^回到对话$/}).click()
 await page.locator('.tool-activity-row').waitFor()
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'chat fits narrow screen')
 await screenshot('mobile-chat')
 assert.deepEqual(errors,[])
 console.log('PASS chrome: dark/light, sidebar, composer, right panels, settings/select, feedback confirmation, sessions/search, directory modal, narrow navigation; transcript retained; no browser errors')
} finally {await browser?.close();await new Promise(r=>server.close(r))}
