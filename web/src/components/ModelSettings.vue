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
const emptyDraft=()=>({main:{api:'',protocol:'responses',model:'',effort:'high',tokens:'',timeout:'',idle:'',retries:''},image:{api:'',model:'gpt-image-2.5-sunburst',timeout:''},search:{api:'',model:'gpt-4.1-mini',context:'',tokens:'',timeout:'',toolType:'web_search',exa:true,exaUrl:'https://mcp.exa.ai/mcp',exaTool:'web_search_exa',exaTimeout:''}})
const draft=ref(emptyDraft()),revision=ref(''),loading=ref(true),busy=ref(false),loadError=ref(''),testResults=ref([]),metadataFile=ref(''),metadataOriginal=ref(null),connectionDirty=ref(false)
let testController
async function request(suffix='',data,signal){const url=new URL(props.endpoint,location.href);url.pathname+=suffix;const response=await fetch(url,{method:data===undefined?'GET':'POST',headers:data===undefined?{}:{'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data),signal,cache:'no-store'});const result=await response.json();if(!response.ok||result.error)throw new Error(result.error||'请求失败');return result}
function receive(data,reset=false){revision.value=data.revision;connections.value=data.connections;metadata.value=data.catalog.models;metadataFile.value=data.metadataFile;if(reset){draft.value={main:{...emptyDraft().main,...data.composition.main},image:{...emptyDraft().image,...data.composition.image},search:{...emptyDraft().search,...data.composition.search}};draft.value.main.protocol=mainProtocol(conn(draft.value.main.api),data.composition.main.protocol);initial.value=copy(draft.value);initialConnections.value=copy(connections.value);connectionDirty.value=Boolean(data.pendingConnections)} }
async function load(){loading.value=true;loadError.value='';try{receive(await request(),true)}catch(e){loadError.value=e.message}finally{loading.value=false}}
async function perform(action){if(busy.value)return;busy.value=true;error.value='';try{await action()}catch(e){error.value=e.message;toast(e.message)}finally{busy.value=false}}
const initial=ref(copy(draft.value)),initialConnections=ref(copy(connections.value))
const metadata=ref([]),dirty=computed(()=>JSON.stringify(draft.value)!==JSON.stringify(initial.value)||connectionDirty.value)
const lookup=id=>metadata.value.find(m=>m.modelIds.some(x=>x.toLowerCase()===id.trim().toLowerCase()))
const mainMeta=computed(()=>lookup(draft.value.main.model)),imageModels=['gpt-image-2.5-sunburst','gpt-image-2.5-flare','gpt-image-2']
const protocolNames={responses:'OpenAI Responses',messages:'Anthropic Messages',images:'OpenAI Images'}
const kindOptions=[{value:'openai',label:'OpenAI 兼容'},{value:'anthropic',label:'Anthropic 兼容'}]
const defaultUrls={openai:'https://api.openai.com',anthropic:'https://api.anthropic.com'}
const protocols=a=>a?.protocols||[a?.kind||'openai']
const modelProtocols=m=>m.protocols||[m.provider==='anthropic'?'anthropic':'openai']
const mainProtocol=(a,current=draft.value.main.protocol)=>{const values=protocols(a).map(p=>p==='anthropic'?'messages':'responses');return values.includes(current)?current:values[0]}
const mainProtocolOptions=computed(()=>protocols(conn(draft.value.main.api)).map(p=>({value:p==='anthropic'?'messages':'responses',label:p==='anthropic'?'Anthropic Messages':'OpenAI Responses'})))
const conn=id=>connections.value.find(a=>a.id===id)
function eligible(slot,a){return slot==='main'?protocols(a).length>0:protocols(a).includes('openai')}
function apiOptions(slot){return [...(slot==='main'?[]:[{value:'',label:'关闭'}]),...connections.value.filter(a=>eligible(slot,a)).map(a=>({value:a.id,label:a.name})),{value:'__add',label:'＋ 添加 API…'}]}
function models(slot){if(slot==='image')return imageModels;const kind=slot==='main'&&draft.value.main.protocol==='messages'?'anthropic':'openai';const ids=metadata.value.filter(m=>modelProtocols(m).includes(kind)).map(m=>m.id).sort((a,b)=>a.localeCompare(b,'en',{numeric:true}));return slot==='search'?['gpt-4.1-mini',...ids]:ids}
function chooseApi(slot,id){if(id==='__add'){openApi(null,slot);return}draft.value[slot].api=id;if(slot==='main')draft.value.main.protocol=mainProtocol(conn(id))}
const isClaude=computed(()=>draft.value.main.protocol==='messages')
const adaptive=id=>/claude-(?:opus-4-[678]|sonnet-4-6|(?:opus|sonnet|haiku|fable|mythos)-5|mythos-preview)/i.test(id)
const efforts=computed(()=>mainMeta.value?.reasoning===false?[]:mainMeta.value?.reasoningEfforts||[])
const effortOptions=computed(()=>{if(mainMeta.value?.reasoning===false)return [{value:draft.value.main.effort,label:'不支持推理',disabled:true}];const out=[...efforts.value.map(value=>({value,label:value==='none'?'none / 不推理':value}))];const v=draft.value.main.effort;if(v&&!out.some(o=>o.value===v))out.push({value:v,label:v==='off'?(isClaude.value?'off / 关闭 thinking（原配置）':'off / 不发送推理参数（原配置）'):v+' / 当前模型不支持',disabled:true});return out})
const imageStatus=computed(()=>mainMeta.value?.imageInput===true?'支持图片输入 / image_inspect 可用':mainMeta.value?.imageInput===false?'仅文字 / 图片输入和 image_inspect 不可用':'图片能力未知 / 请在模型库中配置')
const mainIssue=computed(()=>{const b=draft.value.main,m=mainMeta.value;if(!b.model.trim())return '请输入主模型 ID。';if(m&&!modelProtocols(m).includes(isClaude.value?'anthropic':'openai'))return '模型不支持当前接口，请重新选择。';if(m?.reasoning!==false&&b.effort&&!efforts.value.includes(b.effort))return '当前模型不支持已选推理设置，请重新选择。';if(b.tokens!==''){const n=Number(b.tokens);if(!Number.isSafeInteger(n)||n<=0)return '最大输出 Token 必须为正整数。';if(m?.maxOutputTokens&&n>m.maxOutputTokens)return `最大输出 Token 不能超过 ${m.maxOutputTokens}。`;if(isClaude.value&&!adaptive(b.model)&&['low','medium','high'].includes(b.effort)&&n<=1024)return '此模型启用推理时，最大输出 Token 至少为 1025。'}return ''})
const dialog=ref(''),error=ref(''),notice=ref(''),apiForm=ref({}),apiContext=ref({}),paramForm=ref({}),paramSlot=ref(''),query=ref(''),metaForm=ref({}),metaOriginal=ref(''),deleteId=ref(''),testSelection=ref([])
const apiKindOptions=computed(()=>kindOptions.filter(option=>!apiContext.value.slot||eligible(apiContext.value.slot,{kind:option.value})))
let opener,toastTimer
function toast(s){notice.value=s;clearTimeout(toastTimer);toastTimer=setTimeout(()=>notice.value='',4200)}
function open(type){opener=document.activeElement;error.value='';dialog.value=type;nextTick(()=>document.querySelector('[role="dialog"] input,[role="dialog"] button')?.focus())}
function close(){if(busy.value){if(testController)testController.abort();return}dialog.value='';error.value='';nextTick(()=>opener?.isConnected&&opener.focus())}
function openApi(id,slot='',manager=false){apiContext.value={slot,manager,id};apiForm.value=copy(conn(id)||{name:'',baseUrl:defaultUrls.openai,kind:'openai'});apiForm.value.protocols=[...protocols(apiForm.value)];apiForm.value.key='';open('api')}
function changeProtocols(){const f=apiForm.value,previousDefault=defaultUrls[f.kind];if(f.protocols.length===1){f.kind=f.protocols[0];if(!f.baseUrl.trim()||f.baseUrl===previousDefault)f.baseUrl=defaultUrls[f.kind]}}
async function saveApi(){const f=apiForm.value;if(!f.protocols?.length)return error.value='请选择兼容接口。';if(!f.name.trim())return error.value='请输入 API 名称。';try{if(!['http:','https:'].includes(new URL(f.baseUrl).protocol))throw 0}catch{return error.value='请输入有效的 HTTP(S) 地址。'}if(apiContext.value.slot&&!eligible(apiContext.value.slot,f))return error.value='该连接不支持当前能力所需接口。';await perform(async()=>{const oldIds=new Set(connections.value.map(a=>a.id));const ctx={...apiContext.value};const data=await request('/connection',{revision:revision.value,connection:{...copy(f),id:ctx.id||''}});receive(data);connectionDirty.value=Boolean(data.pendingConnections);const id=ctx.id||connections.value.find(a=>!oldIds.has(a.id))?.id;if(ctx.slot)chooseApi(ctx.slot,id);if(draft.value.main.api===id)draft.value.main.protocol=mainProtocol(conn(id));dialog.value=ctx.manager?'manager':'';toast('API 已保存')})}

function requestDelete(id){const refs=['main','image','search'].filter(k=>draft.value[k].api===id||initial.value[k].api===id);if(refs.length){error.value='此 API 仍被引用，请先更换连接并应用。';return}deleteId.value=id;open('delete')}
async function removeApi(){await perform(async()=>{receive(await request('/connection/delete',{revision:revision.value,id:deleteId.value}));connectionDirty.value=true;dialog.value='manager'})}
function parameters(slot){paramSlot.value=slot;paramForm.value=copy(draft.value[slot]);open('params')}
function saveParams(){const f=paramForm.value;for(const key of ['tokens','timeout','idle','exaTimeout'])if(f[key]!==undefined&&f[key]!==''&&(!Number.isSafeInteger(Number(f[key]))||Number(f[key])<=0))return error.value='Token 与超时须填写正整数。';if(f.retries!==undefined&&f.retries!==''&&(!Number.isSafeInteger(Number(f.retries))||Number(f.retries)<0))return error.value='重试次数须为非负整数。';if(paramSlot.value==='search'){try{if(!['https:','http:'].includes(new URL(f.exaUrl).protocol))throw 0}catch{return error.value='请输入有效的 Exa MCP 地址。'}if(!f.exaTool.trim()||!f.toolType.trim())return error.value='工具名称不能为空。'}Object.assign(draft.value[paramSlot.value],f);close()}
const visibleModels=computed(()=>metadata.value.filter(m=>(m.id+' '+m.modelIds.join(' ')).toLowerCase().includes(query.value.toLowerCase())).sort((a,b)=>a.id.localeCompare(b.id,'en',{numeric:true})))
function editModel(m){metadataOriginal.value=m?copy(m):null;metaOriginal.value=m?.id||'';metaForm.value=m?{...copy(m),protocols:[...modelProtocols(m)],reasoningEfforts:m.reasoningEfforts||[],effortsText:(m.reasoningEfforts||[]).join('\n'),aliases:m.modelIds.join('\n')}:{id:'',provider:'openai',protocols:['openai'],effortsText:'',aliases:'',contextWindowTokens:'',maxOutputTokens:'',imageInput:undefined,reasoning:undefined,reasoningEfforts:[]};open('metadata')}
const triOptions=[{value:undefined,label:'未配置'},{value:true,label:'支持'},{value:false,label:'不支持'}]
const activationText=(data,verb)=>data.activation?.deferred?`${verb}，正在运行中的会话下一轮 API 调用时生效`:'已生效'
async function saveMetadata(){const f=copy(metaForm.value);f.id=f.id.trim();if(!f.id)return error.value='请输入模型 ID。';if(metadata.value.some(m=>m.id===f.id&&m.id!==metaOriginal.value))return error.value='模型 ID 已存在。';for(const k of ['contextWindowTokens','maxOutputTokens']){if(f[k]===''||f[k]===undefined)delete f[k];else if(!Number.isSafeInteger(Number(f[k]))||Number(f[k])<=0)return error.value='Token 须为正整数。';else f[k]=Number(f[k])}f.modelIds=[...new Set([f.id,...f.aliases.split(/\n/).map(x=>x.trim()).filter(Boolean)])];if(metadata.value.some(m=>m.id!==metaOriginal.value&&m.modelIds.some(x=>f.modelIds.some(a=>a.toLowerCase()===x.toLowerCase()))))return error.value='模型别名已被其他条目使用。';delete f.aliases;f.reasoningEfforts=[...new Set((f.effortsText||'').split(/\r?\n/).map(v=>v.trim()).filter(Boolean))];delete f.effortsText;if(f.reasoningEfforts.some(v=>! /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(v)||['default','off'].includes(v)))return error.value='档位须为接口参数值，不可使用 default 或 off。';if(!f.protocols?.length)return error.value='请选择兼容接口。';if(f.reasoning===false)f.reasoningEfforts=[];await perform(async()=>{const data=await request('/metadata',{entry:f,original:metadataOriginal.value});receive(data);dialog.value='catalog';emit('metadata-saved');toast(activationText(data,'已保存'))})}

const testItems=computed(()=>[{id:'main',label:'主模型'},...(mainMeta.value?.imageInput===true?[{id:'vision',label:'图片输入'}]:[]),...(draft.value.image.api?[{id:'image',label:'图片生成'}]:[]),...(draft.value.search.api?[{id:'search',label:'OpenAI 搜索'}]:[]),...(draft.value.search.exa?[{id:'exa',label:'Exa 备用'}]:[])])
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
async function apply(){if(mainIssue.value)return toast(mainIssue.value);await perform(async()=>{const data=await request('/apply',{revision:revision.value,composition:copy(draft.value)});receive(data,true);connectionDirty.value=false;emit('applied');toast(activationText(data,'已应用'))})}
function discard(){draft.value=copy(initial.value);toast('已撤销编排修改；已保存的 API 保留')}
watch(()=>JSON.stringify(draft.value)+revision.value+JSON.stringify(metadata.value)+JSON.stringify(testSelection.value),()=>{testResults.value=[]})

function handleKeys(e){if(!dialog.value)return;if(e.key==='Escape'){e.preventDefault();close()}if(e.key==='Tab'){const els=[...document.querySelectorAll('[role="dialog"] button:not(:disabled),[role="dialog"] input:not(:disabled),[role="dialog"] textarea,[role="dialog"] summary')].filter(x=>x.offsetParent!==null);const a=els[0],b=els.at(-1);if(e.shiftKey&&document.activeElement===a){e.preventDefault();b?.focus()}else if(!e.shiftKey&&document.activeElement===b){e.preventDefault();a?.focus()}}}
onMounted(()=>{document.addEventListener('keydown',handleKeys);load()});onBeforeUnmount(()=>{document.removeEventListener('keydown',handleKeys);testController?.abort()})
const dialogTitle=computed(()=>({api:apiContext.value.id?'编辑 API':'添加 API',manager:'API 配置',delete:'删除 API',params:({main:'主模型参数',image:'图片生成参数',search:'搜索参数'})[paramSlot.value],catalog:'模型库',metadata:metaOriginal.value?'编辑模型':'添加模型',test:'检测'})[dialog.value])
</script>

<template>
<div class="model-settings-content" :aria-busy="loading||busy">
<div v-if="loading" role="status" class="load-state">正在加载配置…</div>
<div v-else-if="loadError" role="alert" class="load-state">{{loadError}} <button class="ghost" @click="load">重试</button></div>
<template v-else>
<div class="model-toolbar"><span class="spacer"/><button class="ghost" @click="query='';open('catalog')"><ChromeIcon name="document"/>模型库</button><button class="ghost" @click="query='';open('manager')"><ChromeIcon name="plugins"/>API 配置</button><button class="settings-icon-button" title="重新加载配置" aria-label="重新加载配置" @click="load"><ChromeIcon name="refresh"/></button></div>
    <div class="settings-form">
      <section class="settings-card main-card" aria-label="主模型配置">
        <header class="settings-card-head"><ChromeIcon name="context"/><strong>主模型</strong><span class="spacer"/><button class="settings-icon-button" aria-label="主模型参数" title="参数" @click="parameters('main')"><ChromeIcon name="tools"/></button><button class="settings-icon-button" aria-label="检测主模型" title="检测主模型" @click="openTests('main')"><ChromeIcon name="sendNow"/></button></header>
        <div class="settings-field-grid">
          <div class="settings-field"><span>API</span><div class="api-control"><NeoSelect :model-value="draft.main.api" :options="apiOptions('main')" aria-label="主模型 API" @change="chooseApi('main',$event)"/><button class="settings-icon-button" aria-label="编辑主模型 API" title="编辑 API" @click="openApi(draft.main.api,'main')"><ChromeIcon name="edit"/></button></div></div>
          <div class="settings-field"><span class="label-line">模型<span class="spacer"/><span class="capability" :class="{'unsupported':mainMeta?.imageInput!==true}" :title="imageStatus" :aria-label="imageStatus" tabindex="0"><ChromeIcon name="image"/></span></span><NeoSelect v-model="draft.main.model" editable :options="models('main')" aria-label="主模型" placeholder="选择或输入模型 ID"/></div>
          <div v-if="mainProtocolOptions.length>1" class="settings-field"><span>接口</span><NeoSelect v-model="draft.main.protocol" :options="mainProtocolOptions" aria-label="主模型接口"/></div><div class="settings-field"><span>推理强度</span><NeoSelect v-model="draft.main.effort" :options="effortOptions" :disabled="mainMeta?.reasoning===false||!efforts.length" aria-label="推理强度" :title="!efforts.length?'此模型尚无可用的推理档位配置':''"/></div>
          <label class="settings-field"><span>最大输出 Token</span><input v-model="draft.main.tokens" aria-label="最大输出 Token" type="number" min="1" :max="mainMeta?.maxOutputTokens" :placeholder="isClaude?'8192':'服务端默认'"></label>
        </div>
        <p v-if="mainIssue" class="field-error" role="alert">{{ mainIssue }}</p>
      </section>
      <section class="settings-card" aria-label="图片生成配置">
        <header class="settings-card-head"><ChromeIcon name="image"/><strong>图片生成</strong><span class="spacer"/><button class="settings-icon-button" :disabled="!draft.image.api" aria-label="图片生成参数" title="参数" @click="parameters('image')"><ChromeIcon name="tools"/></button><button class="settings-icon-button" :disabled="!draft.image.api" aria-label="检测图片生成" title="检测图片生成" @click="openTests('image')"><ChromeIcon name="sendNow"/></button></header>
        <div class="settings-field-grid"><div class="settings-field"><span>API</span><div class="api-control"><NeoSelect :model-value="draft.image.api" :options="apiOptions('image')" aria-label="图片生成 API" @change="chooseApi('image',$event)"/><button class="settings-icon-button" :disabled="!draft.image.api" aria-label="编辑图片生成 API" title="编辑 API" @click="openApi(draft.image.api,'image')"><ChromeIcon name="edit"/></button></div></div><div class="settings-field"><span>默认模型</span><NeoSelect v-model="draft.image.model" :options="imageModels" :disabled="!draft.image.api" aria-label="图片生成模型"/></div></div>
      </section>
      <section class="settings-card" aria-label="搜索配置">
        <header class="settings-card-head"><ChromeIcon name="quota"/><strong>搜索</strong><span class="spacer"/><button class="settings-icon-button" aria-label="搜索参数" title="参数" @click="parameters('search')"><ChromeIcon name="tools"/></button><button class="settings-icon-button" :disabled="!draft.search.api&&!draft.search.exa" aria-label="检测搜索" title="检测搜索" @click="openTests('search')"><ChromeIcon name="sendNow"/></button></header>
        <div class="settings-field-grid"><div class="settings-field"><span>OpenAI API</span><div class="api-control"><NeoSelect :model-value="draft.search.api" :options="apiOptions('search')" aria-label="搜索 OpenAI API" @change="chooseApi('search',$event)"/><button class="settings-icon-button" :disabled="!draft.search.api" aria-label="编辑搜索 API" title="编辑 API" @click="openApi(draft.search.api,'search')"><ChromeIcon name="edit"/></button></div></div><div class="settings-field"><span>搜索模型</span><NeoSelect v-model="draft.search.model" editable :options="models('search')" :disabled="!draft.search.api" aria-label="搜索模型" placeholder="gpt-4.1-mini"/></div></div>
        <div class="fallback-row"><ChromeIcon name="incoming"/><label class="fallback-label"><input v-model="draft.search.exa" type="checkbox" aria-label="启用 Exa 备用">Exa <span class="fallback-badge">{{draft.search.api?'备用':'直接搜索'}}</span></label><span class="spacer"/><span class="fallback-service" :title="draft.search.exaUrl">{{draft.search.exaUrl==='https://mcp.exa.ai/mcp'?'官方 MCP':'自定义 MCP'}}</span><button class="settings-icon-button" aria-label="Exa 配置" title="Exa 配置" @click="parameters('search')"><ChromeIcon name="edit"/></button></div>
      </section>
    </div>
    <footer class="page-footer"><span v-if="dirty" class="pending">未应用</span><span class="spacer"/><button v-if="dirty" class="ghost" @click="discard"><ChromeIcon name="undo"/>撤销</button><button class="ghost" @click="openTests()"><ChromeIcon name="sendNow"/>检测</button><button class="primary" :disabled="busy||!dirty||!!mainIssue" @click="apply"><ChromeIcon name="apply"/>应用</button></footer>
</template></div>
<Teleport to="body"><div v-if="dialog" class="modal-backdrop" @mousedown.self="close"><section role="dialog" aria-modal="true" :aria-label="dialogTitle" class="config-modal" :class="{'wide':dialog==='catalog'}"><header class="modal-head"><strong>{{dialogTitle}}</strong><span class="spacer"/><button class="icon" aria-label="关闭" title="关闭" @click="close"><ChromeIcon name="close"/></button></header><div class="modal-scroll"><fieldset class="modal-body" :class="{'test-body':dialog==='test'}" :disabled="busy&&dialog!=='test'">
  <template v-if="dialog==='api'">
    <label class="settings-field"><span>名称</span><input v-model="apiForm.name" aria-label="API 名称" placeholder="自定义名称"></label>
    <div class="settings-field"><span>接口类型</span><div class="checks"><label v-for="option in apiKindOptions" :key="option.value"><input v-model="apiForm.protocols" type="checkbox" :value="option.value" :aria-label="option.label" @change="changeProtocols">{{option.label}}</label></div></div>
    <label class="settings-field"><span>Base URL</span><input v-model="apiForm.baseUrl" aria-label="Base URL" :placeholder="defaultUrls[apiForm.kind]" autocomplete="off"></label>
    <label class="settings-field"><span>API Key</span><input v-model="apiForm.key" aria-label="API Key" type="password" :placeholder="apiContext.id?'留空保留原密钥':'输入 API Key'" autocomplete="new-password"></label>

  </template>
  <template v-else-if="dialog==='manager'"><input v-model="query" aria-label="搜索 API" placeholder="搜索 API"><div v-for="a in connections.filter(x=>x.name.toLowerCase().includes(query.toLowerCase()))" :key="a.id" class="manager-row"><ChromeIcon name="plugins"/><div><strong>{{a.name}}</strong><span>{{a.baseUrl}}</span></div><span class="spacer"/><button class="icon" :aria-label="'编辑 '+a.name" title="编辑" @click="openApi(a.id,'',true)"><ChromeIcon name="edit"/></button><button class="icon danger-icon" :aria-label="'删除 '+a.name" title="删除" @click="requestDelete(a.id)"><ChromeIcon name="trash"/></button></div></template>
  <template v-else-if="dialog==='delete'"><p>删除「{{conn(deleteId)?.name}}」？</p></template>
  <template v-else-if="dialog==='params'">
    <template v-if="paramSlot==='main'"><dl class="parameter-summary"><dt>接口</dt><dd>{{protocolNames[paramForm.protocol]}}</dd></dl><div class="settings-field-grid compact-grid"><label class="settings-field"><span>请求超时（ms）</span><input v-model="paramForm.timeout" type="number" min="1" placeholder="360000"></label><label class="settings-field"><span>流式空闲超时（ms）</span><input v-model="paramForm.idle" type="number" min="1" placeholder="360000"></label><label class="settings-field"><span>最大重试次数</span><input v-model="paramForm.retries" type="number" min="0" placeholder="2"></label></div></template>
    <template v-if="paramSlot==='image'"><dl class="parameter-summary"><dt>接口</dt><dd>OpenAI Images</dd></dl><label class="settings-field"><span>请求超时（ms）</span><input v-model="paramForm.timeout" type="number" min="1" placeholder="360000"></label><p class="small-note">质量、尺寸与格式由每次图片请求指定。</p></template>
    <template v-if="paramSlot==='search'"><div class="subheading">OpenAI</div><div class="settings-field-grid compact-grid"><div class="settings-field"><span>搜索上下文</span><NeoSelect v-model="paramForm.context" :options="[{value:'',label:'默认'},'low','medium','high']" aria-label="搜索上下文"/></div><label class="settings-field"><span>最大输出 Token</span><input v-model="paramForm.tokens" aria-label="搜索最大输出 Token" type="number" min="1" placeholder="1200"></label><label class="settings-field"><span>请求超时（ms）</span><input v-model="paramForm.timeout" type="number" min="1" placeholder="120000"></label></div><details><summary>接口</summary><label class="settings-field"><span>搜索工具类型</span><input v-model="paramForm.toolType" placeholder="web_search"></label></details><div class="subheading separated">Exa</div><label class="settings-field"><span>MCP URL</span><input v-model="paramForm.exaUrl" aria-label="Exa MCP URL" placeholder="https://mcp.exa.ai/mcp"></label><div class="settings-field-grid compact-grid"><label class="settings-field"><span>工具名称</span><input v-model="paramForm.exaTool" placeholder="web_search_exa"></label><label class="settings-field"><span>请求超时（ms）</span><input v-model="paramForm.exaTimeout" type="number" min="1" placeholder="120000"></label></div><p class="small-note">OpenAI 不可用或结果不完整时，由模型调用 Exa；也可按用户要求使用。</p></template>
  </template>
  <template v-else-if="dialog==='catalog'"><input v-model="query" aria-label="搜索模型元数据" placeholder="搜索模型 ID 或别名"><div class="catalog-list"><div v-for="m in visibleModels" :key="m.id" class="manager-row"><div><strong>{{m.id}}</strong><span>{{m.provider}}<template v-if="m.contextWindowTokens"> / {{m.contextWindowTokens.toLocaleString()}} Token</template></span></div><span class="spacer"/><button class="icon" :aria-label="'编辑模型 '+m.id" title="编辑模型" @click="editModel(m)"><ChromeIcon name="edit"/></button></div></div></template>
  <template v-else-if="dialog==='metadata'"><label class="settings-field"><span>模型 ID</span><input v-model="metaForm.id" aria-label="模型 ID" :readonly="!!metaOriginal"></label><div class="settings-field"><span>供应商</span><NeoSelect v-model="metaForm.provider" editable :options="['openai','anthropic']" aria-label="模型供应商"/></div><div class="settings-field"><span>兼容接口</span><div class="checks"><label v-for="option in kindOptions" :key="option.value"><input v-model="metaForm.protocols" type="checkbox" :value="option.value" :aria-label="'模型'+option.label">{{option.label}}</label></div></div><div class="settings-field-grid compact-grid"><label class="settings-field"><span>上下文 Token</span><input v-model="metaForm.contextWindowTokens" type="number" min="1" aria-label="上下文 Token" placeholder="未配置"></label><label class="settings-field"><span>最大输出 Token</span><input v-model="metaForm.maxOutputTokens" type="number" min="1" aria-label="模型最大输出 Token" placeholder="未配置"></label><div class="settings-field"><span>图片输入</span><NeoSelect v-model="metaForm.imageInput" :options="triOptions" aria-label="模型图片输入"/></div><div class="settings-field"><span>推理</span><NeoSelect v-model="metaForm.reasoning" :options="triOptions" aria-label="模型推理能力"/></div></div><div v-if="metaForm.reasoning!==false" class="settings-field"><span>推理档位</span><textarea v-model="metaForm.effortsText" rows="4" aria-label="推理档位" placeholder="每行一个档位" spellcheck="false"/></div><details><summary>别名与来源</summary><label class="settings-field"><span>别名 / 每行一个</span><textarea v-model="metaForm.aliases" rows="3"/></label><label class="settings-field"><span>知识截止日期</span><input v-model="metaForm.knowledgeCutoff" placeholder="YYYY-MM-DD"></label><label class="settings-field"><span>来源</span><input v-model="metaForm.source"></label><label class="settings-field"><span>备注</span><textarea v-model="metaForm.notes" rows="2"/></label></details></template>
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
  <template v-if="dialog==='api'"><button v-if="apiContext.id" class="icon danger-icon" aria-label="删除 API" title="删除 API" @click="requestDelete(apiContext.id)"><ChromeIcon name="trash"/></button><span class="spacer"/><button class="ghost" @click="apiContext.manager?open('manager'):close()">取消</button><button class="primary" :disabled="busy" @click="saveApi"><ChromeIcon name="save"/>{{apiContext.slot&&!apiContext.id?'添加并选用':'保存'}}</button></template>
  <template v-else-if="dialog==='manager'"><button class="ghost" @click="openApi(null,'',true)"><ChromeIcon name="plus"/>添加 API</button><span class="spacer"/><button class="ghost" @click="close">完成</button></template>
  <template v-else-if="dialog==='delete'"><span class="spacer"/><button class="ghost" @click="open('manager')">取消</button><button class="danger" @click="removeApi">删除</button></template>
  <template v-else-if="dialog==='params'"><span class="spacer"/><button class="ghost" @click="close">取消</button><button class="primary" :disabled="busy" @click="saveParams">确定</button></template>
  <template v-else-if="dialog==='catalog'"><span class="metadata-path" :title="metadataFile">{{metadataFile}}</span><span class="spacer"/><button class="ghost" @click="editModel()"><ChromeIcon name="plus"/>添加模型</button></template>
  <template v-else-if="dialog==='metadata'"><button class="ghost" @click="open('catalog')">返回</button><span class="spacer"/><button class="primary" :disabled="busy" @click="saveMetadata"><ChromeIcon name="save"/>保存</button></template>
  <template v-else-if="dialog==='test'"><span class="spacer"/><button v-if="busy" class="ghost" @click="testController?.abort()">取消检测</button><button class="primary" :disabled="busy" @click="runTests"><ChromeIcon name="sendNow"/>开始检测</button></template>
</footer></section></div><div v-if="notice" class="toast" role="status">{{notice}}</div></Teleport>
</template>

<style scoped>
.model-settings-content,.config-modal{--chrome-success:var(--chrome-accent);--chrome-danger:var(--chrome-accent)}
.test-row :deep(.activity-icon.active),.test-row :deep(.task-status-icon),.test-row .activity-pin{color:var(--chrome-accent)}
.test-row :deep(.task-state-stop),.test-row :deep(.task-state-unknown){color:color-mix(in srgb,var(--chrome-accent) 55%,var(--chrome-faint))}
.model-settings-content{width:100%;min-width:0}.model-toolbar{display:flex;align-items:center;gap:8px;margin-bottom:16px}.model-toolbar .ghost{display:inline-flex;align-items:center;gap:7px}.settings-card-head{display:flex;align-items:center;gap:10px}.settings-card-head>.chrome-icon{color:var(--chrome-faint)}.settings-field-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));padding:16px;gap:16px 20px}.settings-field{display:flex;flex-direction:column;gap:8px;min-width:0}.settings-field>span{font-size:12px;color:var(--chrome-muted)}.settings-field input,.settings-field textarea{box-sizing:border-box;width:100%;min-width:0;padding:8px 10px}.api-control{display:flex;gap:6px;align-items:center;min-width:0}.api-control>:first-child{flex:1;min-width:0}.label-line{display:flex;align-items:center;min-height:17px}.capability{display:inline-flex;color:var(--chrome-success);position:relative}.capability.unsupported{color:var(--chrome-faint)}.spacer{flex:1}.fallback-row{display:flex;align-items:center;gap:10px;border-top:1px solid var(--chrome-line-soft);margin:0 16px;padding:10px 0;min-height:52px;color:var(--chrome-faint)}.fallback-label{display:flex;align-items:center;gap:9px;color:var(--chrome-text);font-size:12px}.fallback-badge,.fallback-service{color:var(--chrome-faint);font-size:11px}.page-footer{display:flex;align-items:center;gap:10px;padding-top:18px}.page-footer button{display:flex;align-items:center;gap:7px}.pending{font-size:12px;color:var(--chrome-accent)}.field-error{color:var(--chrome-danger);font-size:12px;padding:0 16px 14px}.modal-backdrop{position:fixed;inset:0;z-index:1000;background:var(--chrome-overlay);display:flex;align-items:center;justify-content:center;padding:20px}.config-modal{box-sizing:border-box;width:480px;max-width:100%;max-height:calc(100dvh - 40px);display:flex;flex-direction:column;color:var(--chrome-text)}.config-modal.wide{width:620px}.modal-head{display:flex;align-items:center;gap:10px;border-bottom:1px solid var(--chrome-line-soft);padding:12px 16px;min-height:56px}.modal-head strong{font-size:15px;font-weight:500}.modal-body{margin:0;border:0;padding:20px;overflow:auto;overscroll-behavior:contain;display:flex;flex-direction:column;gap:16px;min-height:0;min-width:0}.modal-footer{display:flex;align-items:center;gap:10px;padding:12px 16px;border-top:1px solid var(--chrome-line-soft);min-height:60px}.modal-footer button{display:flex;align-items:center;gap:7px}.checks{display:grid;grid-template-columns:1fr 1fr;gap:12px}.checks label{display:flex;align-items:center;gap:8px;font-size:12px}.checks.efforts{grid-template-columns:repeat(3,1fr)}input[type=checkbox]{accent-color:var(--chrome-accent);width:14px;height:14px;margin:0}.manager-row{display:flex;gap:12px;align-items:center;min-height:62px;padding:12px 0;border-bottom:1px solid var(--chrome-line-soft)}.manager-row>div{display:flex;flex-direction:column;gap:5px;min-width:0}.manager-row strong{font-size:13px;overflow-wrap:anywhere;font-weight:500}.manager-row span:not(.spacer){font-size:12px;color:var(--chrome-faint);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.icon{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;min-width:32px;padding:7px;border:0!important;background:transparent!important}.danger-icon{color:var(--chrome-danger)!important}.compact-grid{padding:0}.parameter-summary{display:flex;gap:12px;margin:0;align-items:center;font-size:12px}.parameter-summary dt{color:var(--chrome-faint)}.parameter-summary dd{margin:0}.subheading{font-size:13px;font-weight:500}.separated{border-top:1px solid var(--chrome-line-soft);padding-top:18px}.small-note{font-size:12px;line-height:1.7;color:var(--chrome-faint)}details summary{cursor:pointer;color:var(--chrome-muted);font-size:12px}details[open] summary{margin-bottom:16px}details .settings-field{margin-bottom:14px}.dialog-error,.failed{color:var(--chrome-danger)!important;font-size:12px;line-height:1.7}.catalog-list{max-height:410px;overflow:auto}.metadata-path{font-size:11px;color:var(--chrome-faint);overflow-wrap:anywhere;min-width:0;max-width:60%}.test-row{display:grid;padding:0;border-bottom:1px solid var(--chrome-line-soft);grid-template-columns:1fr auto;column-gap:12px;row-gap:0;align-items:center;min-height:36px;font-size:12px}.test-row :deep(.activity-icon){width:20px;height:20px}.test-row :deep(.activity-icon:not(.active)){color:var(--chrome-faint)}.test-status{display:flex;align-items:center;gap:7px;min-width:64px;justify-content:flex-end;font-variant-numeric:tabular-nums;color:var(--chrome-faint);font-size:11px}.toast{position:fixed;bottom:28px;left:50%;transform:translateX(-50%);padding:12px 18px;border:1px solid var(--chrome-line);border-radius:6px;background:var(--chrome-raised);max-width:calc(100vw - 32px);z-index:1200;font-size:12px;line-height:1.6}.load-state{padding:24px}.model-settings-content :deep(.neo-select-input){border:0!important}
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
</style>
