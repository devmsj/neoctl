<script setup>
import { ref, computed, nextTick, onMounted, onBeforeUnmount, watch } from 'vue'
import NeoSelect from './NeoSelect.vue'
import ChromeIcon from './ChromeIcon.vue'
import ToolActivityIcon from './ToolActivityIcon.vue'
import TaskStatusIcon from './TaskStatusIcon.vue'
import ToolObservation from './ToolObservation.vue'
import { runIndependentModelTests } from '../model-tests.mjs'
import { useToolObservation } from '../use-tool-observation.mjs'
const props=defineProps({endpoint:{type:String,required:true}})
const emit=defineEmits(['applied','metadata-saved'])
const copy=x=>JSON.parse(JSON.stringify(x))
const connections=ref([])
// Slot api fields are derived on the server from the priority list; the draft only carries order + models.
const emptyDraft=()=>({order:[],main:{api:'',model:'',effort:'high',tokens:'',timeout:'',idle:'',retries:''},image:{api:'',model:'',timeout:''},search:{api:'',model:'',context:'',tokens:'',timeout:'',toolType:'web_search',exa:true,exaUrl:'https://mcp.exa.ai/mcp',exaTool:'web_search_exa',exaTimeout:''}})
const draft=ref(emptyDraft()),revision=ref(''),loading=ref(true),busy=ref(false),loadError=ref(''),testResults=ref([]),metadataFile=ref(''),metadataOriginal=ref(null),connectionDirty=ref(false)
let testController
async function request(suffix='',data,signal){const url=new URL(props.endpoint,location.href);url.pathname+=suffix;const response=await fetch(url,{method:data===undefined?'GET':'POST',headers:data===undefined?{}:{'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data),signal,cache:'no-store'});const result=await response.json();if(!response.ok||result.error)throw new Error(result.error||'请求失败');return result}
function normalizeOrder(order=[]){const ids=new Set(connections.value.map(a=>a.id));const kept=order.filter(o=>ids.has(o.id)).map(o=>({id:o.id,enabled:o.enabled===true}));return [...kept,...connections.value.filter(a=>!kept.some(o=>o.id===a.id)).map(a=>({id:a.id,enabled:false}))]}
function receive(data,reset=false){revision.value=data.revision;connections.value=data.connections;metadata.value=data.catalog.models;catalogRevision.value=data.catalog.revision;removedModelIds.value=data.catalog.removedModelIds||[];metadataFile.value=data.metadataFile;if(reset){const c=data.composition,e=emptyDraft();draft.value={order:normalizeOrder(c.order),main:{...e.main,...c.main,api:''},image:{...e.image,...c.image,api:''},search:{...e.search,...c.search,api:''}};delete draft.value.main.protocol;initial.value=copy(draft.value);connectionDirty.value=Boolean(data.pendingConnections)}else for(const c of [draft.value,initial.value])c.order=normalizeOrder(c.order)}
async function load(){loading.value=true;loadError.value='';try{receive(await request(),true)}catch(e){loadError.value=e.message}finally{loading.value=false}}
async function perform(action){if(busy.value)return;busy.value=true;error.value='';try{await action()}catch(e){error.value=e.message;toast(e.message)}finally{busy.value=false}}
const initial=ref(copy(draft.value))
const catalogRevision=ref(''),removedModelIds=ref([]),modelDelete=ref(null),apiDelete=ref(null)
const metadata=ref([]),dirty=computed(()=>JSON.stringify(draft.value)!==JSON.stringify(initial.value)||connectionDirty.value)
const norm=s=>String(s??'').trim().toLowerCase()
const natural=(a,b)=>a.localeCompare(b,'en',{numeric:true})
const lookup=id=>metadata.value.find(m=>[m.id,...m.modelIds].some(x=>norm(x)===norm(id)))
const removed=id=>!lookup(id)&&removedModelIds.value.some(x=>norm(x)===norm(id))
const mainMeta=computed(()=>lookup(draft.value.main.model)),imageModels=['gpt-image-2.5-sunburst','gpt-image-2.5-flare','gpt-image-2']
const protocolNames={responses:'OpenAI Responses',messages:'Anthropic Messages',images:'OpenAI Images'}
const kindOptions=[{value:'openai',label:'OpenAI 兼容'},{value:'anthropic',label:'Anthropic 兼容'}]
const protoShort={openai:'OpenAI',anthropic:'Anthropic'}
const defaultUrls={openai:'https://api.openai.com',anthropic:'https://api.anthropic.com'}
const protocols=a=>a?.protocols||[a?.kind||'openai']
const modelProtocols=m=>m.protocols||[m.provider==='anthropic'?'anthropic':'openai']
const conn=id=>connections.value.find(a=>a.id===id)
// Mirrors engine routeModel: top-most enabled connection that lists the model and shares a protocol. No failover.
const wantedProtocols=id=>imageModels.includes(String(id).trim())?['openai']:(m=>m?modelProtocols(m):undefined)(lookup(id))
function route(id,need){if(!String(id??'').trim())return undefined;const m=lookup(id),keys=new Set((m?[m.id,...m.modelIds]:[id]).map(norm)),wanted=wantedProtocols(id);for(const o of draft.value.order){const a=o.enabled?conn(o.id):undefined;if(!a||!(a.models||[]).some(x=>keys.has(norm(x))))continue;const sup=protocols(a),p=(wanted||[a.kind,...sup]).find(p=>sup.includes(p)&&(!need||p===need));if(p)return {connection:a,protocol:p}}return undefined}
const enabledConnections=computed(()=>draft.value.order.filter(o=>o.enabled).map(o=>conn(o.id)).filter(Boolean))
const bothProtocols=computed(()=>['openai','anthropic'].every(p=>enabledConnections.value.some(a=>protocols(a).includes(p))))
function pool(filter,need){const ids=new Map();for(const a of enabledConnections.value)for(const raw of a.models||[]){const id=lookup(raw)?.id||raw;if(!ids.has(norm(id))&&filter(id)&&route(id,need))ids.set(norm(id),id)}return [...ids.values()].sort(natural)}
function withCurrent(options,value){return value&&!options.some(o=>o.value===value)?[...options,{value,label:value,disabled:true}]:options}
const mainRoute=computed(()=>route(draft.value.main.model)),imageRoute=computed(()=>route(draft.value.image.model,'openai')),searchRoute=computed(()=>route(draft.value.search.model,'openai'))
const mainModelOptions=computed(()=>withCurrent(pool(id=>!imageModels.includes(id)).map(id=>({value:id,label:bothProtocols.value?`${id} / ${protoShort[route(id).protocol]}`:id})),draft.value.main.model))
const imageModelOptions=computed(()=>withCurrent([{value:'',label:'关闭'},...pool(id=>imageModels.includes(id),'openai').map(id=>({value:id,label:id}))],draft.value.image.model))
const searchModelOptions=computed(()=>withCurrent([{value:'',label:'关闭'},...pool(id=>!imageModels.includes(id),'openai').map(id=>({value:id,label:id}))],draft.value.search.model))
const isClaude=computed(()=>mainRoute.value?.protocol==='anthropic')
const mainWire=computed(()=>mainRoute.value?protocolNames[isClaude.value?'messages':'responses']:'未选择')
const adaptive=id=>/claude-(?:opus-4-[678]|sonnet-4-6|(?:opus|sonnet|haiku|fable|mythos)-5|mythos-preview)/i.test(id)
const efforts=computed(()=>mainMeta.value?.reasoning===false?[]:mainMeta.value?.reasoningEfforts||[])
const effortOptions=computed(()=>{if(mainMeta.value?.reasoning===false)return [{value:draft.value.main.effort,label:'不支持推理',disabled:true}];const out=[...efforts.value.map(value=>({value,label:value==='none'?'none / 不推理':value}))];const v=draft.value.main.effort;if(v&&!out.some(o=>o.value===v))out.push({value:v,label:v==='off'?(isClaude.value?'off / 关闭 thinking（原配置）':'off / 不发送推理参数（原配置）'):v+' / 当前模型不支持',disabled:true});return out})
const imageStatus=computed(()=>mainMeta.value?.imageInput===true?'支持图片输入 / image_inspect 可用':mainMeta.value?.imageInput===false?'仅文字 / 图片输入和 image_inspect 不可用':'图片能力未知 / 请在模型库中配置')
const mainIssue=computed(()=>{const b=draft.value.main,m=mainMeta.value;if(!enabledConnections.value.length)return '请至少启用一个 API。';if(!b.model.trim())return '请选择主模型。';if(removed(b.model))return '此模型已删除，请重新选择模型。';if(!mainRoute.value)return '没有已启用的 API 提供此模型。';if(m?.reasoning!==false&&b.effort&&!efforts.value.includes(b.effort))return '当前模型不支持已选推理设置，请重新选择。';if(b.tokens!==''&&b.tokens!==undefined&&b.tokens!==null){const n=Number(b.tokens);if(!Number.isSafeInteger(n)||n<=0)return '最大输出 Token 必须为正整数。';if(m?.maxOutputTokens&&n>m.maxOutputTokens)return `最大输出 Token 不能超过 ${m.maxOutputTokens}。`;if(isClaude.value&&!adaptive(b.model)&&['low','medium','high'].includes(b.effort)&&n<=1024)return '此模型启用推理时，最大输出 Token 至少为 1025。'}return ''})
const imageIssue=computed(()=>draft.value.image.model&&!imageRoute.value?'没有已启用的 OpenAI 兼容 API 提供此图片模型。':'')
const searchIssue=computed(()=>draft.value.search.model&&!searchRoute.value?'没有已启用的 OpenAI 兼容 API 提供此搜索模型。':'')
const serveSlots=[{slot:'main',icon:'model',label:'主模型',route:mainRoute},{slot:'image',icon:'imageGenerate',label:'图片生成',route:imageRoute},{slot:'search',icon:'search',label:'搜索',route:searchRoute}]
const serving=id=>serveSlots.filter(s=>s.route.value?.connection.id===id)
const dialog=ref(''),error=ref(''),notice=ref(''),apiForm=ref({}),apiContext=ref({}),paramForm=ref({}),paramSlot=ref(''),query=ref(''),metaForm=ref({}),metaOriginal=ref(''),deleteId=ref(''),testSelection=ref([])
const tx=ref({left:[],right:[],qL:'',qR:''})
let apiStash=null
let opener,toastTimer
function toast(s){notice.value=s;clearTimeout(toastTimer);toastTimer=setTimeout(()=>notice.value='',4200)}
function open(type){opener=document.activeElement;error.value='';dialog.value=type;nextTick(()=>document.querySelector('[role="dialog"] input,[role="dialog"] button')?.focus())}
function close(){if(busy.value){if(testController)testController.abort();return}apiStash=null;dialog.value='';error.value='';nextTick(()=>opener?.isConnected&&opener.focus())}
function openApi(id,focusModels=false){apiContext.value={id};apiForm.value=copy(conn(id)||{name:'',baseUrl:defaultUrls.openai,kind:'openai',models:[]});apiForm.value.protocols=[...protocols(apiForm.value)];apiForm.value.models=[...(apiForm.value.models||[])];apiForm.value.key='';tx.value={left:[],right:[],qL:'',qR:''};open('api');if(focusModels)nextTick(()=>{const box=document.querySelector('[role="dialog"] .transfer');box?.scrollIntoView({block:'nearest'});box?.querySelector('input.transfer-search')?.focus()})}
function changeProtocols(){const f=apiForm.value,previousDefault=defaultUrls[f.kind];if(f.protocols.length===1){f.kind=f.protocols[0];if(!f.baseUrl.trim()||f.baseUrl===previousDefault)f.baseUrl=defaultUrls[f.kind]}}
// Transfer box: left = model library entries compatible with this connection, right = its allowlist.
const compatible=(id,ps=apiForm.value.protocols||[])=>{const w=wantedProtocols(id);return !w||w.some(p=>ps.includes(p))}
const txCandidates=computed(()=>[...metadata.value.map(m=>m.id),...imageModels])
const txLeft=computed(()=>{const have=new Set((apiForm.value.models||[]).map(id=>norm(lookup(id)?.id||id))),q=norm(tx.value.qL);return txCandidates.value.filter(id=>compatible(id)&&!have.has(norm(id))&&norm(id).includes(q)).sort(natural)})
const txRight=computed(()=>{const q=norm(tx.value.qR);return (apiForm.value.models||[]).filter(id=>norm(id).includes(q)).sort(natural)})
const txCanAdd=computed(()=>{const q=tx.value.qL.trim();return Boolean(q)&&!lookup(q)&&!imageModels.includes(q)&&!/\s/.test(q)})
const txTag=id=>imageModels.includes(id)?'图片':(w=>w?w.map(p=>protoShort[p]).join(' / '):'未知')(wantedProtocols(id))
const txUnavailable=id=>!compatible(id)?`连接未启用 ${txTag(id)} 接口，不会使用`:(!lookup(id)&&!imageModels.includes(id)?'模型库中没有此模型':'')
function txToggle(side,id){const list=tx.value[side];tx.value[side]=list.includes(id)?list.filter(x=>x!==id):[...list,id]}
function txAll(side,ids){tx.value[side]=ids.every(id=>tx.value[side].includes(id))?[]:[...ids]}
function txMove(dir){const f=apiForm.value;if(dir==='in')f.models=[...f.models,...tx.value.left.filter(id=>txLeft.value.includes(id))];if(dir==='all-in')f.models=[...f.models,...txLeft.value];if(dir==='out')f.models=f.models.filter(id=>!tx.value.right.includes(id));if(dir==='all-out'){const r=new Set(txRight.value);f.models=f.models.filter(id=>!r.has(id))}tx.value.left=[];tx.value.right=[]}
function txNew(){const q=tx.value.qL.trim();apiStash={form:copy(apiForm.value),context:copy(apiContext.value),tx:copy(tx.value)};metadataOriginal.value=null;metaOriginal.value='';const ps=apiForm.value.protocols?.length?[...apiForm.value.protocols]:['openai'];metaForm.value={id:q,provider:ps[0],protocols:ps,effortsText:'',aliases:'',contextWindowTokens:'',maxOutputTokens:'',imageInput:undefined,reasoning:undefined,reasoningEfforts:[]};open('metadata')}
function returnToApi(addedId){const s=apiStash;apiStash=null;apiForm.value=s.form;apiContext.value=s.context;tx.value={...s.tx,qL:''};if(addedId&&!apiForm.value.models.some(id=>norm(id)===norm(addedId)))apiForm.value.models.push(addedId);open('api')}
async function saveApi(){const f=apiForm.value;if(!f.protocols?.length)return error.value='请选择兼容接口。';if(!f.name.trim())return error.value='请输入 API 名称。';try{if(!['http:','https:'].includes(new URL(f.baseUrl).protocol))throw 0}catch{return error.value='请输入有效的 HTTP(S) 地址。'}await perform(async()=>{const oldIds=new Set(connections.value.map(a=>a.id));const id0=apiContext.value.id;const models=f.models.filter(id=>compatible(id,f.protocols));const data=await request('/connection',{revision:revision.value,connection:{...copy(f),models,id:id0||''}});receive(data);connectionDirty.value=Boolean(data.pendingConnections);const id=id0||connections.value.find(a=>!oldIds.has(a.id))?.id;if(!id0&&id){draft.value.order=[...draft.value.order.filter(o=>o.id!==id),{id,enabled:true}];initial.value.order=normalizeOrder(initial.value.order)}dialog.value='';toast(id0?'API 已保存':'API 已添加到末位')})}

async function requestDelete(id){await perform(async()=>{apiDelete.value=await request('/connection/usage',{id});deleteId.value=id;dialog.value='delete'})}
async function removeApi(){await perform(async()=>{try{const id=deleteId.value;const data=await request('/connection/delete',{revision:apiDelete.value.revision,id,confirmed:true,interruptConfirmed:apiDelete.value.usage.running>0});receive(data);for(const c of [draft.value,initial.value])c.order=c.order.filter(o=>o.id!==id);connectionDirty.value=Boolean(data.pendingConnections);dialog.value='';emit('applied');toast('已删除，已生效')}catch(e){const latest=await request('/connection/usage',{id:deleteId.value}).catch(()=>null);if(latest)apiDelete.value=latest;throw e}})}
function parameters(slot){paramSlot.value=slot;paramForm.value=copy(draft.value[slot]);open('params')}
function saveParams(){const f=paramForm.value;for(const key of ['tokens','timeout','idle','exaTimeout'])if(f[key]!==undefined&&f[key]!==''&&(!Number.isSafeInteger(Number(f[key]))||Number(f[key])<=0))return error.value='Token 与超时须填写正整数。';if(paramSlot.value==='search'){try{if(!['https:','http:'].includes(new URL(f.exaUrl).protocol))throw 0}catch{return error.value='请输入有效的 Exa MCP 地址。'}if(!f.exaTool.trim()||!f.toolType.trim())return error.value='工具名称不能为空。'}Object.assign(draft.value[paramSlot.value],f);close()}
// Priority list: pointer drag + ↑/↓ on the handle; rows that make room glide (FLIP).
const connList=ref(null),drag=ref(null)
async function reorder(from,to){const list=connList.value,order=draft.value.order;if(!list||from===to||to<0||to>=order.length)return;const before=new Map([...list.children].map(r=>[r.dataset.id,r.getBoundingClientRect().top]));const [x]=order.splice(from,1);order.splice(to,0,x);await nextTick();for(const r of list.children){if(r.dataset.id===drag.value?.id)continue;const dy=(before.get(r.dataset.id)??0)-r.getBoundingClientRect().top;if(!dy)continue;r.style.transition='none';r.style.transform=`translateY(${dy}px)`;r.getBoundingClientRect();r.style.transition='';r.style.transform=''}}
function startDrag(e,id){if(e.button!==0||busy.value)return;e.preventDefault();const row=e.currentTarget.closest('.conn-row');e.currentTarget.setPointerCapture(e.pointerId);drag.value={id,row,pointer:e.pointerId,startY:e.clientY,origin:row.offsetTop}}
async function moveDrag(e){const d=drag.value;if(!d||e.pointerId!==d.pointer)return;const list=connList.value,row=d.row,want=d.origin+e.clientY-d.startY,clamped=Math.max(-row.offsetHeight/2,Math.min(list.scrollHeight-row.offsetHeight/2,want)),center=clamped+row.offsetHeight/2;const others=[...list.children].filter(r=>r!==row);let to=others.findIndex(r=>center<r.offsetTop+r.offsetHeight/2);if(to<0)to=others.length;const from=draft.value.order.findIndex(o=>o.id===d.id);if(to!==from)await reorder(from,to);if(drag.value===d){row.style.transition='none';row.style.transform=`translateY(${clamped-row.offsetTop}px)`}}
function endDrag(e){const d=drag.value;if(!d||e.pointerId!==d.pointer)return;d.row.style.transition='transform .18s cubic-bezier(.2,.72,.2,1)';d.row.style.transform='';setTimeout(()=>{if(drag.value===d){d.row.style.transition='';drag.value=null}},190)}
async function keyMove(id,delta){const from=draft.value.order.findIndex(o=>o.id===id);await reorder(from,from+delta);nextTick(()=>connList.value?.querySelector(`.conn-row[data-id="${CSS.escape(id)}"] .drag-handle`)?.focus({preventScroll:true}))}
const visibleModels=computed(()=>metadata.value.filter(m=>(m.id+' '+m.modelIds.join(' ')).toLowerCase().includes(query.value.toLowerCase())).sort((a,b)=>a.id.localeCompare(b.id,'en',{numeric:true})))
function editModel(m){metadataOriginal.value=m?copy(m):null;metaOriginal.value=m?.id||'';metaForm.value=m?{...copy(m),protocols:[...modelProtocols(m)],reasoningEfforts:m.reasoningEfforts||[],effortsText:(m.reasoningEfforts||[]).join('\n'),aliases:m.modelIds.join('\n')}:{id:'',provider:'openai',protocols:['openai'],effortsText:'',aliases:'',contextWindowTokens:'',maxOutputTokens:'',imageInput:undefined,reasoning:undefined,reasoningEfforts:[]};open('metadata')}
async function requestModelDelete(m){await perform(async()=>{const data=await request('/metadata/usage',{id:m.id});modelDelete.value=data;dialog.value='model-delete'})}
async function removeModel(){await perform(async()=>{const target=modelDelete.value;try{const data=await request('/metadata/delete',{original:target.original,catalogRevision:target.catalogRevision,confirmed:true,interruptConfirmed:target.usage.running>0});receive(data);const ids=[target.original.id,...target.original.modelIds].map(id=>id.toLowerCase());for(const c of [draft.value,initial.value])for(const slot of ['main','image','search'])if(ids.includes(c[slot].model.toLowerCase()))c[slot].model='';dialog.value='catalog';emit('metadata-saved');toast('已删除，已生效')}catch(e){const latest=await request('/metadata/usage',{id:target.original.id}).catch(()=>null);if(latest)modelDelete.value=latest;throw e}})}
const triOptions=[{value:undefined,label:'未配置'},{value:true,label:'支持'},{value:false,label:'不支持'}]
const activationText=(data,verb)=>data.activation?.deferred?`${verb}，正在运行中的会话下一轮 API 调用时生效`:'已生效'
async function saveMetadata(){const f=copy(metaForm.value);f.id=f.id.trim();if(!f.id)return error.value='请输入模型 ID。';if(metadata.value.some(m=>m.id.toLowerCase()===f.id.toLowerCase()&&m.id!==metaOriginal.value))return error.value='模型 ID 已存在。';for(const k of ['contextWindowTokens','maxOutputTokens']){if(f[k]===''||f[k]===undefined)delete f[k];else if(!Number.isSafeInteger(Number(f[k]))||Number(f[k])<=0)return error.value='Token 须为正整数。';else f[k]=Number(f[k])}f.modelIds=[...new Set([f.id,...f.aliases.split(/\n/).map(x=>x.trim()).filter(Boolean)])];if(metadata.value.some(m=>m.id!==metaOriginal.value&&[m.id,...m.modelIds].some(x=>f.modelIds.some(a=>a.toLowerCase()===x.toLowerCase()))))return error.value='模型别名已被其他条目使用。';delete f.aliases;f.reasoningEfforts=[...new Set((f.effortsText||'').split(/\r?\n/).map(v=>v.trim()).filter(Boolean))];delete f.effortsText;if(f.reasoningEfforts.some(v=>! /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(v)||['default','off'].includes(v)))return error.value='档位须为接口参数值，不可使用 default 或 off。';if(!f.protocols?.length)return error.value='请选择兼容接口。';if(f.reasoning===false)f.reasoningEfforts=[];await perform(async()=>{const data=await request('/metadata',{entry:f,original:metadataOriginal.value,catalogRevision:catalogRevision.value});receive(data);emit('metadata-saved');toast(activationText(data,'已保存'));if(apiStash)returnToApi(f.id);else dialog.value='catalog'})}
function metadataBack(){if(apiStash)returnToApi();else open('catalog')}

const testItems=computed(()=>[{id:'main',label:'主模型'},...(mainMeta.value?.imageInput===true?[{id:'vision',label:'图片输入'}]:[]),...(imageRoute.value?[{id:'image',label:'图片生成'}]:[]),...(searchRoute.value?[{id:'search',label:'OpenAI 搜索'}]:[]),...(draft.value.search.exa?[{id:'exa',label:'Exa 备用'}]:[])])
const testObservationLines=ref([]),testObservationRun=ref(0)
const {pinned:testPinned,observed:testObserved,pinnedLine:testPinnedLine,toggle:toggleTestObservation}=useToolObservation(testObservationLines,()=>testObservationRun.value)
const testIcon={main:'thinking',vision:'image_inspect',image:'image_create',search:'web_search',exa:'web_search'}
const testResult=id=>testResults.value.find(result=>result.id===id)
function toggleTestDetails(id){const line=testObservationLines.value.find(line=>line.id===id);if(line)toggleTestObservation(line)}
watch(testResults,results=>{if(!results.length){testObservationLines.value=[];testObservationRun.value++}},{flush:'sync'})
const testRunning=id=>busy.value&&testSelection.value.includes(id)&&!testResult(id)
const testState=id=>{const result=testResult(id);return result?(result.cancelled?'stopped':result.ok?'completed':'failed'):'pending'}
function openTests(slot){testSelection.value=testItems.value.filter(x=>slot?x.id===slot||(slot==='main'&&x.id==='vision')||(slot==='search'&&x.id==='exa'):x.id!=='image').map(x=>x.id);testResults.value=[];open('test')}
async function runTests(){
  if(busy.value)return
  if(!testSelection.value.length)return error.value='请至少选择一项检测。'
  const controller=new AbortController()
  testController=controller
  const payload={revision:revision.value,composition:copy(draft.value),selection:[...testSelection.value],imageConsent:testSelection.value.includes('image')}
  try{
    await perform(async()=>{
      testResults.value=[]
      await runIndependentModelTests({request,payload,signal:controller.signal,onResult(result){
        if(testController!==controller)return
        testResults.value=[...testResults.value.filter(item=>item.id!==result.id),result]
          .sort((a,b)=>payload.selection.indexOf(a.id)-payload.selection.indexOf(b.id))
        testObservationLines.value.push({id:result.id,toolName:'model_test',text:result.detail||'',activity:{phase:result.cancelled?'interrupted':result.ok?'completed':'failed'}})
      }})
    })
  }finally{if(testController===controller)testController=null}
}
const applyIssue=computed(()=>mainIssue.value||imageIssue.value||searchIssue.value)
async function apply(){if(applyIssue.value)return toast(applyIssue.value);await perform(async()=>{const data=await request('/apply',{revision:revision.value,composition:copy(draft.value)});receive(data,true);connectionDirty.value=false;emit('applied');toast(activationText(data,'已应用'))})}
function discard(){draft.value=copy(initial.value);toast('已撤销编排修改；已保存的 API 保留')}
watch(()=>JSON.stringify(draft.value)+revision.value+JSON.stringify(metadata.value)+JSON.stringify(testSelection.value),()=>{testResults.value=[]})

function handleKeys(e){if(!dialog.value)return;if(e.key==='Escape'){e.preventDefault();close()}if(e.key==='Tab'){const els=[...document.querySelectorAll('[role="dialog"] button:not(:disabled),[role="dialog"] input:not(:disabled),[role="dialog"] textarea,[role="dialog"] summary')].filter(x=>x.offsetParent!==null);const a=els[0],b=els.at(-1);if(e.shiftKey&&document.activeElement===a){e.preventDefault();b?.focus()}else if(!e.shiftKey&&document.activeElement===b){e.preventDefault();a?.focus()}}}
onMounted(()=>{document.addEventListener('keydown',handleKeys);load()});onBeforeUnmount(()=>{document.removeEventListener('keydown',handleKeys);testController?.abort()})
const dialogTitle=computed(()=>({api:apiContext.value.id?'编辑 API':'添加 API',delete:'删除 API',params:({main:'主模型参数',image:'图片生成参数',search:'搜索参数'})[paramSlot.value],catalog:'模型库','model-delete':'删除模型',metadata:metaOriginal.value?'编辑模型':'添加模型',test:'检测'})[dialog.value])
</script>

<template>
<div class="model-settings-content" :aria-busy="loading||busy">
<div v-if="loading" role="status" class="load-state">正在加载配置…</div>
<div v-else-if="loadError" role="alert" class="load-state">{{loadError}} <button class="ghost" @click="load">重试</button></div>
<template v-else>
<div class="model-toolbar"><span class="spacer"/><button class="ghost" @click="query='';open('catalog')"><ChromeIcon name="library"/>模型库</button><button class="settings-icon-button" title="重新加载配置" aria-label="重新加载配置" @click="load"><ChromeIcon name="refresh"/></button></div>
    <div class="settings-form composition-panel">
      <section class="settings-card api-card" aria-label="API 配置">
        <header class="settings-card-head"><ChromeIcon name="plugins"/><strong>API</strong><span class="strategy" tabindex="0" title="每项能力使用最靠上、提供所选模型的已启用 API；请求失败不自动切换">顶部优先</span><span class="spacer"/><button class="settings-icon-button" aria-label="添加 API" title="添加 API" @click="openApi(null)"><ChromeIcon name="plus"/></button></header>
        <div ref="connList" class="conn-list" :class="{sorting:drag}" role="list" aria-label="API 优先级">
          <div v-for="(o,i) in draft.order" :key="o.id" class="conn-row" :class="{off:!o.enabled,dragging:drag?.id===o.id}" :data-id="o.id" role="listitem">
            <button type="button" class="drag-handle" :aria-label="'拖动排序 '+conn(o.id)?.name" title="拖动排序" @pointerdown="startDrag($event,o.id)" @pointermove="moveDrag" @pointerup="endDrag" @pointercancel="endDrag" @keydown.up.prevent="keyMove(o.id,-1)" @keydown.down.prevent="keyMove(o.id,1)"><ChromeIcon name="grip"/></button>
            <span class="conn-index">{{i+1}}</span>
            <input v-model="o.enabled" type="checkbox" :aria-label="'启用 '+conn(o.id)?.name">
            <span class="conn-main"><strong>{{conn(o.id)?.name}}</strong><span>{{conn(o.id)?.baseUrl}}</span></span>
            <span class="row-tags"><span v-for="p in protocols(conn(o.id))" :key="p" class="proto-tag">{{protoShort[p]}}</span></span>
            <span class="conn-serving"><span v-for="s in serving(o.id)" :key="s.slot" class="serve" :title="s.label+'：'+draft[s.slot].model" :aria-label="s.label+'生效'"><ChromeIcon :name="s.icon"/></span></span>
            <button class="settings-icon-button conn-models" title="可用模型" :aria-label="conn(o.id)?.name+' 可用模型 '+(conn(o.id)?.models?.length||0)+' 个'" @click="openApi(o.id,true)"><ChromeIcon name="library"/><span>{{conn(o.id)?.models?.length||0}}</span></button>
            <button class="settings-icon-button" :aria-label="'编辑 '+conn(o.id)?.name" title="编辑 API" @click="openApi(o.id)"><ChromeIcon name="edit"/></button>
          </div>
        </div>
      </section>
      <section class="settings-card main-card" aria-label="主模型配置">
        <header class="settings-card-head"><ChromeIcon name="model"/><strong>主模型</strong><span class="spacer"/><button class="settings-icon-button" aria-label="主模型参数" title="参数" @click="parameters('main')"><ChromeIcon name="sliders"/></button><button class="settings-icon-button" aria-label="检测主模型" title="检测主模型" @click="openTests('main')"><ChromeIcon name="diagnose"/></button></header>
        <div class="settings-field-grid main-grid">
          <div class="settings-field"><span class="label-line">模型<span class="capability" :class="{'unsupported':mainMeta?.imageInput!==true}" :title="imageStatus" :aria-label="imageStatus" tabindex="0"><ChromeIcon name="image"/></span><span class="spacer"/><span v-if="mainRoute" class="route-hint" :title="mainRoute.connection.name+' / '+mainRoute.connection.baseUrl" :aria-label="'生效 API：'+mainRoute.connection.name"><ChromeIcon name="plugins"/><span>{{mainRoute.connection.name}}</span></span></span><NeoSelect v-model="draft.main.model" :options="mainModelOptions" aria-label="主模型" placeholder="选择模型"/></div>
          <div class="settings-field"><span>推理强度</span><NeoSelect v-model="draft.main.effort" :options="effortOptions" :disabled="mainMeta?.reasoning===false||!efforts.length" aria-label="推理强度" :title="!efforts.length?'此模型尚无可用的推理档位配置':''"/></div>
          <label class="settings-field"><span>最大输出 Token</span><input v-model="draft.main.tokens" aria-label="最大输出 Token" type="number" min="1" :max="mainMeta?.maxOutputTokens" :placeholder="isClaude?String(mainMeta?.maxOutputTokens??64000):'服务端默认'"></label>
        </div>
        <p v-if="mainIssue" class="field-error" role="alert">{{ mainIssue }}</p>
      </section>
      <section class="settings-card" aria-label="图片生成配置">
        <header class="settings-card-head"><ChromeIcon name="imageGenerate"/><strong>图片生成</strong><span class="spacer"/><button class="settings-icon-button" :disabled="!draft.image.model" aria-label="图片生成参数" title="参数" @click="parameters('image')"><ChromeIcon name="sliders"/></button><button class="settings-icon-button" :disabled="!imageRoute" aria-label="检测图片生成" title="检测图片生成" @click="openTests('image')"><ChromeIcon name="diagnose"/></button></header>
        <div class="settings-field-grid single-grid"><div class="settings-field"><span class="label-line">模型<span class="spacer"/><span v-if="imageRoute" class="route-hint" :title="imageRoute.connection.name+' / '+imageRoute.connection.baseUrl" :aria-label="'生效 API：'+imageRoute.connection.name"><ChromeIcon name="plugins"/><span>{{imageRoute.connection.name}}</span></span></span><NeoSelect v-model="draft.image.model" :options="imageModelOptions" aria-label="图片生成模型"/></div></div>
        <p v-if="imageIssue" class="field-error" role="alert">{{ imageIssue }}</p>
      </section>
      <section class="settings-card" aria-label="搜索配置">
        <header class="settings-card-head"><ChromeIcon name="search"/><strong>搜索</strong><span class="spacer"/><button class="settings-icon-button" aria-label="搜索参数" title="参数" @click="parameters('search')"><ChromeIcon name="sliders"/></button><button class="settings-icon-button" :disabled="!searchRoute&&!draft.search.exa" aria-label="检测搜索" title="检测搜索" @click="openTests('search')"><ChromeIcon name="diagnose"/></button></header>
        <div class="settings-field-grid single-grid"><div class="settings-field"><span class="label-line">模型<span class="spacer"/><span v-if="searchRoute" class="route-hint" :title="searchRoute.connection.name+' / '+searchRoute.connection.baseUrl" :aria-label="'生效 API：'+searchRoute.connection.name"><ChromeIcon name="plugins"/><span>{{searchRoute.connection.name}}</span></span></span><NeoSelect v-model="draft.search.model" :options="searchModelOptions" aria-label="搜索模型"/></div></div>
        <p v-if="searchIssue" class="field-error" role="alert">{{ searchIssue }}</p>
        <div class="fallback-row"><label class="fallback-label"><input v-model="draft.search.exa" type="checkbox" aria-label="启用 Exa 备用">Exa <span class="fallback-badge">{{draft.search.model?'备用':'直接搜索'}}</span></label></div>
      </section>
    </div>
    <footer class="page-footer"><span v-if="dirty" class="pending">未应用</span><span class="spacer"/><button v-if="dirty" class="ghost" @click="discard"><ChromeIcon name="undo"/>撤销</button><button class="ghost" @click="openTests()"><ChromeIcon name="diagnose"/>检测</button><button class="primary" :disabled="busy||!dirty||!!applyIssue" @click="apply"><ChromeIcon name="check"/>应用</button></footer>
</template></div>
<Teleport to="body"><div v-if="dialog" class="modal-backdrop" @mousedown.self="close"><section role="dialog" aria-modal="true" :aria-label="dialogTitle" class="config-modal" :class="{'wide':dialog==='catalog','transfer-modal':dialog==='api'}"><header class="modal-head"><strong>{{dialogTitle}}</strong><span class="spacer"/><button class="icon" aria-label="关闭" title="关闭" @click="close"><ChromeIcon name="close"/></button></header><div class="modal-scroll"><fieldset class="modal-body" :class="{'test-body':dialog==='test'}" :disabled="busy&&dialog!=='test'">
  <template v-if="dialog==='api'">
    <div class="settings-field-grid compact-grid">
      <label class="settings-field"><span>名称</span><input v-model="apiForm.name" aria-label="API 名称" placeholder="自定义名称"></label>
      <div class="settings-field"><span>接口类型</span><div class="checks"><label v-for="option in kindOptions" :key="option.value"><input v-model="apiForm.protocols" type="checkbox" :value="option.value" :aria-label="option.label" @change="changeProtocols">{{option.label}}</label></div></div>
      <label class="settings-field"><span>Base URL</span><input v-model="apiForm.baseUrl" aria-label="Base URL" :placeholder="defaultUrls[apiForm.kind]" autocomplete="off"></label>
      <label class="settings-field"><span>API Key</span><input v-model="apiForm.key" aria-label="API Key" type="password" :placeholder="apiContext.id?'留空保留原密钥':'输入 API Key'" autocomplete="new-password"></label>
    </div>
    <div class="settings-field"><span>模型</span><div class="transfer">
      <div class="transfer-pane">
        <div class="transfer-head"><input type="checkbox" :checked="txLeft.length>0&&txLeft.every(id=>tx.left.includes(id))" :disabled="!txLeft.length" aria-label="全选模型库" @change="txAll('left',txLeft)"><span>模型库</span><span class="spacer"/><span class="transfer-count">{{tx.left.length?tx.left.length+' / ':''}}{{txLeft.length}}</span></div>
        <input v-model="tx.qL" class="transfer-search" placeholder="搜索或输入模型 ID" aria-label="搜索模型库">
        <div class="transfer-list" role="listbox" aria-multiselectable="true" aria-label="模型库">
          <button v-for="id in txLeft" :key="id" type="button" role="option" :aria-selected="tx.left.includes(id)" class="transfer-item" :class="{checked:tx.left.includes(id)}" @click="txToggle('left',id)" @dblclick="tx.left=[id];txMove('in')"><input type="checkbox" tabindex="-1" :checked="tx.left.includes(id)" aria-hidden="true"><span class="transfer-id">{{id}}</span><span v-if="apiForm.protocols.length>1||imageModels.includes(id)" class="proto-tag">{{txTag(id)}}</span></button>
          <button v-if="txCanAdd" type="button" class="transfer-add" @click="txNew"><ChromeIcon name="plus"/><span>添加「{{tx.qL.trim()}}」</span></button>
          <p v-else-if="!txLeft.length" class="transfer-empty">{{apiForm.protocols.length?'无':'请选择接口类型'}}</p>
        </div>
      </div>
      <div class="transfer-actions">
        <button type="button" class="ghost tx-btn" aria-label="全部添加" title="全部添加" :disabled="!txLeft.length" @click="txMove('all-in')"><ChromeIcon name="rightAll"/></button>
        <button type="button" class="ghost tx-btn" aria-label="添加所选" title="添加所选" :disabled="!tx.left.length" @click="txMove('in')"><ChromeIcon name="right"/></button>
        <button type="button" class="ghost tx-btn" aria-label="移除所选" title="移除所选" :disabled="!tx.right.length" @click="txMove('out')"><ChromeIcon name="left"/></button>
        <button type="button" class="ghost tx-btn" aria-label="全部移除" title="全部移除" :disabled="!txRight.length" @click="txMove('all-out')"><ChromeIcon name="leftAll"/></button>
      </div>
      <div class="transfer-pane">
        <div class="transfer-head"><input type="checkbox" :checked="txRight.length>0&&txRight.every(id=>tx.right.includes(id))" :disabled="!txRight.length" aria-label="全选可用" @change="txAll('right',txRight)"><span>可用</span><span class="spacer"/><span class="transfer-count">{{tx.right.length?tx.right.length+' / ':''}}{{txRight.length}}</span></div>
        <input v-model="tx.qR" class="transfer-search" placeholder="搜索" aria-label="搜索可用模型">
        <div class="transfer-list" role="listbox" aria-multiselectable="true" aria-label="可用模型">
          <button v-for="id in txRight" :key="id" type="button" role="option" :aria-selected="tx.right.includes(id)" class="transfer-item" :class="{checked:tx.right.includes(id),unavailable:!!txUnavailable(id)}" :title="txUnavailable(id)" @click="txToggle('right',id)" @dblclick="tx.right=[id];txMove('out')"><input type="checkbox" tabindex="-1" :checked="tx.right.includes(id)" aria-hidden="true"><span class="transfer-id">{{id}}</span><span v-if="apiForm.protocols.length>1||imageModels.includes(id)||txUnavailable(id)" class="proto-tag">{{txTag(id)}}</span></button>
          <p v-if="!txRight.length" class="transfer-empty">无</p>
        </div>
      </div>
    </div></div>
  </template>
  <template v-else-if="dialog==='delete'"><p>删除「{{conn(deleteId)?.name}}」？</p><p v-if="apiDelete?.usage.running" class="dialog-error" role="alert">有活动会话正通过此 API 调用，删除将打断会话；之后由下方符合条件的 API 生效。</p></template>
  <template v-else-if="dialog==='params'">
    <template v-if="paramSlot==='main'"><dl class="parameter-summary"><dt>接口</dt><dd>{{mainWire}}</dd></dl><div class="settings-field-grid compact-grid"><label class="settings-field"><span>请求超时（ms）</span><input v-model="paramForm.timeout" type="number" min="1" placeholder="360000"></label><label class="settings-field"><span>流式空闲超时（ms）</span><input v-model="paramForm.idle" type="number" min="1" placeholder="360000"></label></div></template>
    <template v-if="paramSlot==='image'"><dl class="parameter-summary"><dt>接口</dt><dd>OpenAI Images</dd></dl><label class="settings-field"><span>请求超时（ms）</span><input v-model="paramForm.timeout" type="number" min="1" placeholder="360000"></label><p class="small-note">质量、尺寸与格式由每次图片请求指定。</p></template>
    <template v-if="paramSlot==='search'"><div class="subheading">OpenAI</div><div class="settings-field-grid compact-grid"><div class="settings-field"><span>搜索上下文</span><NeoSelect v-model="paramForm.context" :options="[{value:'',label:'默认'},'low','medium','high']" aria-label="搜索上下文"/></div><label class="settings-field"><span>最大输出 Token</span><input v-model="paramForm.tokens" aria-label="搜索最大输出 Token" type="number" min="1" placeholder="1200"></label><label class="settings-field"><span>请求超时（ms）</span><input v-model="paramForm.timeout" type="number" min="1" placeholder="120000"></label></div><details><summary>接口</summary><label class="settings-field"><span>搜索工具类型</span><input v-model="paramForm.toolType" placeholder="web_search"></label></details><div class="subheading separated">Exa</div><label class="settings-field"><span>MCP URL</span><input v-model="paramForm.exaUrl" aria-label="Exa MCP URL" placeholder="https://mcp.exa.ai/mcp"></label><div class="settings-field-grid compact-grid"><label class="settings-field"><span>工具名称</span><input v-model="paramForm.exaTool" placeholder="web_search_exa"></label><label class="settings-field"><span>请求超时（ms）</span><input v-model="paramForm.exaTimeout" type="number" min="1" placeholder="120000"></label></div><p class="small-note">OpenAI 不可用或结果不完整时，由模型调用 Exa；也可按用户要求使用。</p></template>
  </template>
  <template v-else-if="dialog==='catalog'"><input v-model="query" aria-label="搜索模型元数据" placeholder="搜索模型 ID 或别名"><div class="catalog-list"><div v-for="m in visibleModels" :key="m.id" class="manager-row"><div><strong>{{m.id}}</strong><span>{{m.provider}}<template v-if="m.contextWindowTokens"> / {{m.contextWindowTokens.toLocaleString()}} Token</template></span></div><span class="spacer"/><button class="icon" :aria-label="'编辑模型 '+m.id" title="编辑模型" @click="editModel(m)"><ChromeIcon name="edit"/></button><button class="icon danger-icon" :aria-label="'删除模型 '+m.id" title="删除模型" @click="requestModelDelete(m)"><ChromeIcon name="trash"/></button></div></div></template>
  <template v-else-if="dialog==='model-delete'"><p>删除「{{modelDelete?.original.id}}」？</p><p v-if="modelDelete?.usage.running" class="dialog-error" role="alert">有活动会话使用该模型，删除将打断会话，模型选择将清空。</p></template>
  <template v-else-if="dialog==='metadata'"><label class="settings-field"><span>模型 ID</span><input v-model="metaForm.id" aria-label="模型 ID" ></label><div class="settings-field"><span>供应商</span><NeoSelect v-model="metaForm.provider" editable :options="['openai','anthropic']" aria-label="模型供应商"/></div><div class="settings-field"><span>兼容接口</span><div class="checks"><label v-for="option in kindOptions" :key="option.value"><input v-model="metaForm.protocols" type="checkbox" :value="option.value" :aria-label="'模型'+option.label">{{option.label}}</label></div></div><div class="settings-field-grid compact-grid"><label class="settings-field"><span>上下文 Token</span><input v-model="metaForm.contextWindowTokens" type="number" min="1" aria-label="上下文 Token" placeholder="未配置"></label><label class="settings-field"><span>最大输出 Token</span><input v-model="metaForm.maxOutputTokens" type="number" min="1" aria-label="模型最大输出 Token" placeholder="未配置"></label><div class="settings-field"><span>图片输入</span><NeoSelect v-model="metaForm.imageInput" :options="triOptions" aria-label="模型图片输入"/></div><div class="settings-field"><span>推理</span><NeoSelect v-model="metaForm.reasoning" :options="triOptions" aria-label="模型推理能力"/></div></div><div v-if="metaForm.reasoning!==false" class="settings-field"><span>推理档位</span><textarea v-model="metaForm.effortsText" rows="4" aria-label="推理档位" placeholder="每行一个档位" spellcheck="false"/></div><details><summary>别名与来源</summary><label class="settings-field"><span>别名 / 每行一个</span><textarea v-model="metaForm.aliases" rows="3"/></label><label class="settings-field"><span>知识截止日期</span><input v-model="metaForm.knowledgeCutoff" placeholder="YYYY-MM-DD"></label><label class="settings-field"><span>来源</span><input v-model="metaForm.source"></label><label class="settings-field"><span>备注</span><textarea v-model="metaForm.notes" rows="2"/></label></details></template>
  <template v-else-if="dialog==='test'">
    <div v-for="item in testItems" :key="item.id" class="test-row">
      <input v-model="testSelection" type="checkbox" :value="item.id" :disabled="busy" :aria-label="item.label"/>
      <button type="button" class="test-activity-row" :disabled="!testResult(item.id)" :aria-label="item.label+'详情'" :aria-pressed="testPinned===item.id" @click="toggleTestDetails(item.id)">
        <ToolActivityIcon :name="testIcon[item.id]" :phase="testRunning(item.id)?'running':'completed'" aria-hidden="true"/>
        <span>{{item.label}}</span>
        <svg v-if="testPinned===item.id" class="activity-pin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M8 3h8l-1 7 4 4v2H5v-2l4-4zM12 16v6"/></svg>
        <span class="test-status" role="status" :aria-label="testResult(item.id)?(testResult(item.id).cancelled?'已取消':testResult(item.id).ok?'通过':'失败'):testRunning(item.id)?'检测中':'未检测'">
          <TaskStatusIcon v-if="testResult(item.id)" :status="testState(item.id)" aria-hidden="true"/>
          <span v-if="testResult(item.id)" class="test-duration">{{(testResult(item.id).durationMs/1000).toFixed(1)}} s</span>
        </span>
      </button>
      <ToolObservation v-if="testPinned===item.id&&testPinnedLine" :key="testPinned" class="test-inline-detail" :line="testPinnedLine" variant="pinned" :aria-label="item.label+'检测详情'"/>
    </div>
    <ToolObservation v-if="testObserved&&testObserved.id!==testPinned" class="test-auto-observation" :line="testObserved" variant="main" aria-label="检测观察窗"/>

  </template>
  <p v-if="error" class="dialog-error" role="alert">{{error}}</p>
</fieldset></div><footer class="modal-footer">
  <template v-if="dialog==='api'"><button v-if="apiContext.id" class="icon danger-icon" aria-label="删除 API" title="删除 API" @click="requestDelete(apiContext.id)"><ChromeIcon name="trash"/></button><span class="spacer"/><button class="ghost" @click="close">取消</button><button class="primary" :disabled="busy" @click="saveApi"><ChromeIcon name="save"/>保存</button></template>
  <template v-else-if="dialog==='delete'"><span class="spacer"/><button class="ghost" @click="open('api')">取消</button><button class="danger" :disabled="busy" @click="removeApi">{{apiDelete?.usage.running?'删除并中断':'删除'}}</button></template>
  <template v-else-if="dialog==='params'"><span class="spacer"/><button class="ghost" @click="close">取消</button><button class="primary" :disabled="busy" @click="saveParams">确定</button></template>
  <template v-else-if="dialog==='catalog'"><span class="metadata-path" :title="metadataFile">{{metadataFile}}</span><span class="spacer"/><button class="ghost" @click="editModel()"><ChromeIcon name="plus"/>添加模型</button></template>
  <template v-else-if="dialog==='model-delete'"><span class="spacer"/><button class="ghost" :disabled="busy" @click="open('catalog')">取消</button><button class="danger" :disabled="busy" @click="removeModel">{{modelDelete?.usage.running?'删除并中断':'删除'}}</button></template>
  <template v-else-if="dialog==='metadata'"><button v-if="metaOriginal" class="icon danger-icon" aria-label="删除模型" title="删除模型" :disabled="busy" @click="requestModelDelete(metadataOriginal)"><ChromeIcon name="trash"/></button><button class="ghost" @click="metadataBack">返回</button><span class="spacer"/><button class="primary" :disabled="busy" @click="saveMetadata"><ChromeIcon name="save"/>保存</button></template>
  <template v-else-if="dialog==='test'"><span class="spacer"/><button v-if="busy" class="ghost" @click="testController?.abort()">取消检测</button><button class="primary" :disabled="busy" @click="runTests"><ChromeIcon name="diagnose"/>开始检测</button></template>
</footer></section></div><div v-if="notice" class="toast" role="status">{{notice}}</div></Teleport>
</template>

<style scoped>
.model-settings-content,.config-modal{--chrome-success:var(--chrome-accent);--chrome-danger:var(--chrome-accent)}
.test-row :deep(.activity-icon.active),.test-row :deep(.task-status-icon),.test-row .activity-pin{color:var(--chrome-accent)}
.test-row :deep(.task-state-stop),.test-row :deep(.task-state-unknown){color:color-mix(in srgb,var(--chrome-accent) 55%,var(--chrome-faint))}
.model-settings-content{width:100%;min-width:0}.model-toolbar{display:flex;align-items:center;gap:8px;margin-bottom:16px}.model-toolbar .ghost{display:inline-flex;align-items:center;gap:7px}.settings-card-head{display:flex;align-items:center;gap:10px}.settings-card-head>.chrome-icon{color:var(--chrome-faint)}.settings-field-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));padding:16px;gap:16px 20px}.settings-field{display:flex;flex-direction:column;gap:8px;min-width:0}.settings-field>span{font-size:12px;color:var(--chrome-muted)}.settings-field input,.settings-field textarea{box-sizing:border-box;width:100%;min-width:0;padding:8px 10px}.api-control{display:flex;gap:6px;align-items:center;min-width:0}.api-control>:first-child{flex:1;min-width:0}.label-line{display:flex;align-items:center;min-height:17px}.capability{display:inline-flex;color:var(--chrome-success);position:relative}.capability.unsupported{color:var(--chrome-faint)}.spacer{flex:1}.fallback-row{display:flex;align-items:center;gap:10px;border-top:1px solid var(--chrome-line-soft);margin:0 16px;padding:10px 0;min-height:52px;color:var(--chrome-faint)}.fallback-label{display:flex;align-items:center;gap:9px;color:var(--chrome-text);font-size:12px}.fallback-badge{color:var(--chrome-faint);font-size:11px}.page-footer{display:flex;align-items:center;gap:10px;padding-top:18px}.page-footer button{display:flex;align-items:center;gap:7px}.pending{font-size:12px;color:var(--chrome-accent)}.field-error{color:var(--chrome-danger);font-size:12px;padding:0 16px 14px}.modal-backdrop{position:fixed;inset:0;z-index:1000;background:var(--chrome-overlay);display:flex;align-items:center;justify-content:center;padding:20px}.config-modal{box-sizing:border-box;width:480px;max-width:100%;max-height:calc(100dvh - 40px);display:flex;flex-direction:column;color:var(--chrome-text)}.config-modal.wide{width:620px}.modal-head{display:flex;align-items:center;gap:10px;border-bottom:1px solid var(--chrome-line-soft);padding:12px 16px;min-height:56px}.modal-head strong{font-size:15px;font-weight:500}.modal-body{margin:0;border:0;padding:20px;overflow:auto;overscroll-behavior:contain;display:flex;flex-direction:column;gap:16px;min-height:0;min-width:0}.modal-footer{display:flex;align-items:center;gap:10px;padding:12px 16px;border-top:1px solid var(--chrome-line-soft);min-height:60px}.modal-footer button{display:flex;align-items:center;gap:7px}.checks{display:grid;grid-template-columns:1fr 1fr;gap:12px}.checks label{display:flex;align-items:center;gap:8px;font-size:12px}.checks.efforts{grid-template-columns:repeat(3,1fr)}input[type=checkbox]{accent-color:var(--chrome-accent);width:14px;height:14px;margin:0}.manager-row{display:flex;gap:12px;align-items:center;min-height:62px;padding:12px 0;border-bottom:1px solid var(--chrome-line-soft)}.manager-row>div{display:flex;flex-direction:column;gap:5px;min-width:0}.manager-row strong{font-size:13px;overflow-wrap:anywhere;font-weight:500}.manager-row span:not(.spacer){font-size:12px;color:var(--chrome-faint);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.icon{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;min-width:32px;padding:7px;border:0!important;background:transparent!important}.danger-icon{color:var(--chrome-danger)!important}.compact-grid{padding:0}.parameter-summary{display:flex;gap:12px;margin:0;align-items:center;font-size:12px}.parameter-summary dt{color:var(--chrome-faint)}.parameter-summary dd{margin:0}.subheading{font-size:13px;font-weight:500}.separated{border-top:1px solid var(--chrome-line-soft);padding-top:18px}.small-note{font-size:12px;line-height:1.7;color:var(--chrome-faint)}details summary{cursor:pointer;color:var(--chrome-muted);font-size:12px}details[open] summary{margin-bottom:16px}details .settings-field{margin-bottom:14px}.dialog-error,.failed{color:var(--chrome-danger)!important;font-size:12px;line-height:1.7}.catalog-list{max-height:410px;overflow:auto}.metadata-path{font-size:11px;color:var(--chrome-faint);overflow-wrap:anywhere;min-width:0;max-width:60%}.test-row{display:grid;padding:0;border-bottom:1px solid var(--chrome-line-soft);grid-template-columns:1fr auto;column-gap:12px;row-gap:0;align-items:center;min-height:36px;font-size:12px}.test-row :deep(.activity-icon){width:20px;height:20px}.test-row :deep(.activity-icon:not(.active)){color:var(--chrome-faint)}.test-status{display:flex;align-items:center;gap:7px;min-width:64px;justify-content:flex-end;font-variant-numeric:tabular-nums;color:var(--chrome-faint);font-size:11px}.toast{position:fixed;bottom:28px;left:50%;transform:translateX(-50%);padding:12px 18px;border:1px solid var(--chrome-line);border-radius:6px;background:var(--chrome-raised);max-width:calc(100vw - 32px);z-index:1200;font-size:12px;line-height:1.6}.load-state{padding:24px}.model-settings-content :deep(.neo-select-input){border:0!important}
.modal-body.test-body{gap:0;padding-top:12px;padding-bottom:12px}
.test-row{grid-template-columns:auto minmax(0,1fr);column-gap:8px;row-gap:0;border:0}
.config-modal .modal-body .test-row .test-activity-row{display:flex;align-items:center;gap:8px;min-width:0;width:100%;min-height:32px!important;padding:6px 0!important;border:0!important;background:transparent!important;color:var(--chrome-text);text-align:left;font:inherit;cursor:pointer}
.test-activity-row:disabled{opacity:1;cursor:default}
.test-activity-row:focus-visible{outline:2px solid var(--chrome-accent);outline-offset:2px}
.test-activity-row .test-status{margin-left:auto}
.test-activity-row .activity-pin{width:13px;height:16px;flex-shrink:0;stroke-linecap:round;stroke-linejoin:round}
.test-row :deep(.test-inline-detail.tool-observation.is-pinned){grid-column:1/-1;--activity-content-inset:46px;margin-left:46px;margin-bottom:4px;padding:6px 0 0;border:0!important}
.modal-body :deep(.test-auto-observation){--activity-content-inset:46px}
.config-modal{overflow:hidden}
.config-modal .modal-head,.config-modal .modal-footer{flex-shrink:0}
.config-modal .modal-scroll{flex:1 1 auto;min-height:0;min-width:0;overflow:auto;overscroll-behavior:contain}
.config-modal .modal-body{min-inline-size:0;overflow:visible}
.config-modal .modal-body>*{flex-shrink:0}
.config-modal .modal-body details{min-width:0}
.config-modal .modal-body details summary{display:list-item;min-height:0!important;padding:4px 0!important;border:0!important;background:transparent!important;box-shadow:none!important;line-height:20px}
.config-modal .modal-body details summary:focus:not(:focus-visible){outline:none!important}
.config-modal .modal-body details summary:focus-visible{outline:1px solid var(--chrome-accent)!important;outline-offset:3px}
.config-modal .modal-body .settings-field :deep(.neo-select .neo-select-editable input.neo-select-input){border:0!important;background:transparent!important;box-shadow:none!important;outline:none!important}
@media(max-width:820px){.settings-field-grid{grid-template-columns:1fr}.compact-grid{grid-template-columns:1fr 1fr}}@media(max-width:480px){.modal-backdrop{padding:12px}.config-modal{max-height:calc(100dvh - 24px)}.modal-body{padding:16px}.test-row{grid-template-columns:auto minmax(0,1fr)}.modal-footer{gap:7px}.checks{gap:12px 8px}}

/* A single composition surface; retain all controls and native project components. */
.model-settings-content .model-toolbar{margin-bottom:12px}
.model-settings-content .composition-panel{gap:0;border:var(--appearance-border-width,1px) solid var(--chrome-line-soft);border-radius:var(--appearance-radius,7px);padding:0 18px}
.model-settings-content .composition-panel>.settings-card{border:0!important;border-radius:0!important;padding:14px 0;background:transparent!important}
.model-settings-content .composition-panel>.settings-card+.settings-card{border-top:var(--appearance-border-width,1px) solid var(--chrome-line-soft)!important}
.model-settings-content .composition-panel .settings-card-head{min-height:32px;padding:0;gap:8px;border:0!important;background:transparent!important}
.model-settings-content .composition-panel .settings-card-head>.chrome-icon{color:var(--chrome-muted)}
.model-settings-content .composition-panel .settings-field-grid{padding:10px 0 0;gap:12px 20px;grid-template-columns:repeat(2,minmax(0,1fr))}
.model-settings-content .composition-panel .settings-field{gap:6px}
.model-settings-content .composition-panel .settings-field>span:first-child,.model-settings-content .connection-label{min-height:24px;display:flex;align-items:center}
.model-settings-content .connection-label{display:flex;align-items:center;justify-content:space-between;gap:8px;color:var(--chrome-muted);font-size:calc(12px * var(--appearance-ui-scale,1))}
.model-settings-content .connection-label .settings-icon-button{width:24px!important;min-width:24px!important;min-height:24px!important;height:24px!important;padding:4px!important}
.model-settings-content .composition-panel .fallback-row{margin:10px 0 0;padding:0;min-height:30px;border:0;gap:8px}
.model-settings-content .composition-panel .field-error{padding:10px 0 0;margin:0}
.model-settings-content .page-footer{padding-top:12px}
@media(max-width:600px){
 .model-settings-content .composition-panel{padding:0 12px}
 .model-settings-content .composition-panel .settings-field-grid{grid-template-columns:1fr;gap:12px}
 .model-settings-content .composition-panel>.settings-card{padding:12px 0}
 .model-settings-content .model-toolbar{gap:6px}
}
/* API priority list: top-most enabled connection serving a model is used; no automatic switching. */
.strategy{font-size:11px;color:var(--chrome-faint);cursor:help}
.strategy:focus-visible{outline:1px solid var(--chrome-accent);outline-offset:2px}
.conn-list{display:flex;flex-direction:column;gap:2px;padding-top:8px;position:relative}
.conn-row{display:grid;grid-template-columns:24px 16px 14px minmax(0,1fr) auto 50px 52px 24px;align-items:center;gap:10px;min-height:46px;padding:4px 6px 4px 2px;border-radius:var(--appearance-radius,6px);background:transparent;transition:transform .18s cubic-bezier(.2,.72,.2,1),background .14s ease,box-shadow .14s ease;position:relative;touch-action:none}
.conn-row:hover{background:var(--chrome-hover)}
.conn-list.sorting .conn-row:hover{background:transparent}
.conn-row.dragging{z-index:3;background:var(--chrome-raised)!important;box-shadow:0 10px 28px rgb(0 0 0 / 28%),0 0 0 1px color-mix(in srgb,var(--chrome-accent) 45%,transparent);cursor:grabbing}
.conn-row.dragging .drag-handle{color:var(--chrome-accent)!important}
:root[data-theme] .settings-page .conn-row button.drag-handle{display:inline-flex;align-items:center;justify-content:center;width:24px;height:32px;min-height:32px;padding:0!important;border:0!important;background:transparent!important;box-shadow:none!important;color:var(--chrome-faint)!important;cursor:grab;touch-action:none;border-radius:calc(var(--appearance-radius,6px) - 2px)!important}
:root[data-theme] .settings-page .conn-row button.drag-handle:hover{color:var(--chrome-text)!important}
.conn-row .drag-handle:focus-visible{outline:1px solid var(--chrome-accent);outline-offset:1px}
.drag-handle .chrome-icon{stroke-width:2.4}
.conn-index{font-size:11px;color:var(--chrome-faint);font-variant-numeric:tabular-nums;text-align:center}
.conn-main{display:flex;flex-direction:column;gap:3px;min-width:0}
.conn-main strong{font-size:13px;font-weight:500;color:var(--chrome-text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.conn-main span{font-size:11px;color:var(--chrome-faint);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.conn-row.off .conn-main strong,.conn-row.off .row-tags,.conn-row.off .conn-index{opacity:.45}
.conn-row.off .conn-main span{opacity:.6}
.model-settings-content .conn-row .settings-icon-button{width:24px!important;min-width:24px!important;height:24px!important;min-height:24px!important;padding:4px!important}
:root[data-theme] .settings-page .conn-row button.settings-icon-button.conn-models{width:52px!important;min-width:52px!important;gap:5px;justify-content:flex-start;padding:4px 6px!important;font-size:12px;font-variant-numeric:tabular-nums;color:var(--chrome-muted)!important}
.conn-models .chrome-icon{width:14px;height:14px;flex-basis:14px}
.conn-serving{display:flex;align-items:center;justify-content:flex-end;gap:4px;min-width:0}
.conn-serving .serve{display:inline-flex;color:var(--chrome-accent);cursor:default}
.conn-serving .chrome-icon{width:14px;height:14px;flex-basis:14px}
.conn-row.off .conn-serving{visibility:hidden}
.proto-tag{display:inline-flex;align-items:center;flex:0 0 auto;height:18px;padding:0 6px;margin-left:auto;border:var(--appearance-border-width,1px) solid var(--chrome-line-soft);border-radius:calc(var(--appearance-radius,6px) - 3px);color:var(--chrome-faint);font-size:11px;font-weight:400;line-height:1;white-space:nowrap}
.row-tags{display:flex;gap:4px;flex:0 0 auto}
.row-tags .proto-tag{margin:0}
.route-hint{display:inline-flex;align-items:center;gap:4px;font-size:11px;color:var(--chrome-faint);white-space:nowrap;cursor:default;min-width:0}
.route-hint>span{overflow:hidden;text-overflow:ellipsis}
.route-hint .chrome-icon{width:13px;height:13px;flex-basis:13px}
.model-settings-content .label-line .capability{margin-left:6px}
.model-settings-content .composition-panel .settings-field-grid.main-grid{grid-template-columns:minmax(0,2fr) minmax(0,1fr) minmax(0,1fr)}
.model-settings-content .composition-panel .settings-field-grid.single-grid{grid-template-columns:minmax(0,1fr)}
/* Connection dialog: transfer box selects the models this API serves. */
.config-modal.transfer-modal{width:720px}
.transfer{display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);gap:10px;align-items:stretch;min-width:0}
.transfer-pane{display:flex;flex-direction:column;min-width:0;height:300px;border:var(--appearance-border-width,1px) solid var(--chrome-line-soft);border-radius:var(--appearance-radius,6px);background:color-mix(in srgb,var(--chrome-raised) 60%,transparent);overflow:hidden}
.transfer-head{display:flex;align-items:center;gap:8px;min-height:36px;padding:0 10px;border-bottom:var(--appearance-border-width,1px) solid var(--chrome-line-soft);font-size:12px;color:var(--chrome-muted)}
.transfer-count{font-variant-numeric:tabular-nums;color:var(--chrome-faint);font-size:11px}
.config-modal .modal-body input.transfer-search{border:0!important;border-bottom:var(--appearance-border-width,1px) solid var(--chrome-line-soft)!important;border-radius:0!important;background:transparent!important;box-shadow:none!important;min-height:34px;padding:0 10px!important;font-size:12px;width:100%}
.transfer-list{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;padding:4px;display:flex;flex-direction:column;gap:1px}
.config-modal .modal-body .transfer-item,.config-modal .modal-body .transfer-add{display:flex!important;align-items:center;gap:8px;width:100%;min-height:30px!important;padding:0 8px!important;border:0!important;border-radius:calc(var(--appearance-radius,6px) - 2px)!important;background:transparent!important;box-shadow:none!important;color:var(--chrome-text)!important;font:inherit;font-size:12px!important;font-weight:400!important;text-align:left;cursor:pointer;user-select:none;transform:none!important}
.config-modal .modal-body .transfer-item:hover{background:var(--chrome-hover)!important}
.config-modal .modal-body .transfer-item.checked{background:var(--chrome-accent-soft)!important}
.config-modal .modal-body .transfer-item:focus-visible,.config-modal .modal-body .transfer-add:focus-visible{outline:1px solid var(--chrome-accent);outline-offset:-1px}
.transfer-item input{pointer-events:none}
.transfer-id{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.transfer-item.unavailable .transfer-id{color:var(--chrome-faint);text-decoration:line-through;text-decoration-color:color-mix(in srgb,var(--chrome-faint) 60%,transparent)}
.config-modal .modal-body .transfer-add{color:var(--chrome-accent)!important}
.transfer-add .chrome-icon{width:14px;height:14px;flex-basis:14px}
.transfer-empty{margin:auto;padding:16px;color:var(--chrome-faint);font-size:12px}
.transfer-actions{display:flex;flex-direction:column;justify-content:center;gap:6px}
:root[data-theme] .config-modal button.tx-btn{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;min-width:32px;min-height:32px!important;padding:0!important}
.tx-btn .chrome-icon{width:14px;height:14px;flex-basis:14px}
@media(max-width:820px){.model-settings-content .composition-panel .settings-field-grid.main-grid{grid-template-columns:1fr 1fr}.main-grid>.settings-field:first-child{grid-column:1/-1}}
@media(max-width:600px){
 .conn-row{grid-template-columns:24px 14px minmax(0,1fr) 50px 52px 24px;gap:8px}.conn-index,.conn-row .row-tags{display:none}
 .model-settings-content .composition-panel .settings-field-grid.main-grid{grid-template-columns:1fr}
 .transfer{grid-template-columns:1fr}.transfer-actions{flex-direction:row;justify-content:center}.tx-btn .chrome-icon{transform:rotate(90deg)}.transfer-pane{height:220px}
 .config-modal .compact-grid{grid-template-columns:1fr!important}
}
</style>
