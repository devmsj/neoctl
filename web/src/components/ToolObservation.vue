<script setup>
import { computed, nextTick, onMounted, onUpdated, onBeforeUnmount, ref, watch } from 'vue'
import { activityContent, activityPhase, terminalPhase } from '../tool-activity.mjs'
import ActivityPlan from './ActivityPlan.vue'
import TerminalOutputReader from '../TerminalOutputReader.vue'
import TerminalText from './TerminalText.vue'
import ToolActivityIcon from './ToolActivityIcon.vue'
import { appUrl } from '../app-url.mjs'
const props=defineProps({renderText:Function,line:Object,images:{type:Array,default:()=>[]},paused:Boolean,ownerSessionId:String,terminalRevision:Number,variant:{type:String,default:'main'}})
const emit=defineEmits(['height'])
const root=ref(null)
let sizeObserver
// Report Vue content height before paint, avoiding a second frame of
// virtual row measurement when an observation grows or shrinks.
function reportHeight(){emit('height',Math.ceil(root.value?.getBoundingClientRect().height||0))}
onUpdated(reportHeight)
onMounted(()=>{sizeObserver=new ResizeObserver(reportHeight);if(root.value)sizeObserver.observe(root.value);reportHeight()})
onBeforeUnmount(()=>sizeObserver?.disconnect())
const content=computed(()=>activityContent(props.line)),phase=computed(()=>activityPhase(props.line)),viewport=ref(null)
const terminalRecord=ref(null)
const terminalRun=computed(()=>content.value.mode==='terminal' ? props.line?.observation?.session_id || props.line?.activity?.input?.session_id : null)
const commandPhase=computed(()=>terminalPhase(props.line,terminalRecord.value))
watch(()=>[props.line?.id,terminalRun.value],()=>{terminalRecord.value=null})
function followOutput(){if(viewport.value&&!manual&&!props.paused)viewport.value.scrollTop=viewport.value.scrollHeight}
let frame=0,manual=false,scrollGeneration=0
function manualScroll(){if(props.variant==='pinned'){manual=true;cancel()}}
function manualKey(event){if(['ArrowUp','ArrowDown','PageUp','PageDown','Home','End',' '].includes(event.key))manualScroll()}
function cancel(){scrollGeneration++;cancelAnimationFrame(frame);frame=0}
watch(()=>[props.line?.id,content.value.mode,content.value.text,content.value.items,props.images.map(i=>i.imageId||i.previewUrl).join(','),props.paused],async(values,old)=>{
 cancel();const generation=scrollGeneration;if(values[0]!==old?.[0])manual=false
 await nextTick();const el=viewport.value;if(generation!==scrollGeneration||!el||manual||props.paused)return
 if(content.value.mode==='read'&&!matchMedia('(prefers-reduced-motion: reduce)').matches){const start=performance.now();el.scrollTop=0;const scroll=now=>{el.scrollTop=(el.scrollHeight-el.clientHeight)*Math.min(1,(now-start)/1800);if(now-start<1800)frame=requestAnimationFrame(scroll)};frame=requestAnimationFrame(scroll)}
 else if(!['plan'].includes(content.value.mode))el.scrollTop=el.scrollHeight
},{immediate:true})
onBeforeUnmount(cancel)
</script>
<template><section ref="root" class="tool-observation" :class="[ 'is-'+variant, {'is-rich':content.mode==='plan'||images.length,'is-paused':paused}]" :inert="variant==='main'" :data-phase="phase" :aria-label="content.draft?'生成草稿':'活动内容'">
<div ref="viewport" class="tool-observation-viewport" :tabindex="variant==='pinned'?0:undefined" @wheel="manualScroll" @touchstart="manualScroll" @keydown="manualKey" @observation-output="followOutput">
<div v-if="content.mode==='thinking' && renderText" class="observation-thinking" v-html="renderText(line)"></div>
<ActivityPlan v-else-if="content.mode==='plan'" :items="content.items"/>
<div v-else-if="content.mode==='entries'" class="observation-list"><div v-for="(entry,i) in content.entries" :key="i"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path v-if="entry.type==='directory'" d="M3 7V4h7l3 3h8v13H3z"/><path v-else d="M6 3h8l4 4v14H6zM14 3v5h4"/></svg><span>{{entry.name||entry.path}}</span></div></div>
<div v-else-if="content.mode==='matches'" class="observation-matches"><section v-for="(match,i) in content.matches" :key="i"><small>{{match.file}}:{{match.line}}</small><pre>{{match.text}}</pre></section></div>
<div v-else-if="content.mode==='search'" class="observation-search"><a v-for="(result,i) in content.results" :key="i" :href="/^https?:\/\//.test(result.url||'')?result.url:undefined" target="_blank" rel="noopener noreferrer">{{result.title||result.url}}<p v-if="result.snippet||result.text">{{result.snippet||result.text}}</p></a></div>
<div v-else-if="content.mode==='tasks'" class="observation-list"><div v-for="(task,i) in content.tasks" :key="i"><ToolActivityIcon name="subagent_run" :phase="task.status==='running'?'running':task.status==='failed'?'failed':task.status==='killed'?'interrupted':task.status==='pending'?'queued':'completed'" :paused="paused"/><span>{{task.description||task.name||task.task_id||task.agent_id}}</span></div></div>
<div v-else-if="images.length" class="observation-thumbnails"><figure v-for="(image,i) in images" :key="image.imageId||i"><img v-if="image.previewUrl" :src="appUrl(image.previewUrl)" :alt="image.label||'图片'"/><figcaption v-if="image.label">{{image.label}}</figcaption></figure></div>
<template v-else-if="content.mode==='terminal'"><div class="observation-command" :data-command-phase="commandPhase"><pre>{{content.command}}</pre></div><div v-if="commandPhase=== 'running'" class="command-running" aria-hidden="true"></div><TerminalOutputReader v-if="terminalRun && ownerSessionId" :key="terminalRun" :owner-session-id="ownerSessionId" :run-id="terminalRun" compact :refresh-key="terminalRevision" :fallback-text="content.text" :paused="paused" @record="terminalRecord=$event"/><TerminalText v-else :text="content.text" trim-end /></template>
<pre v-else-if="content.mode==='diff'" class="observation-diff" :class="{'is-draft':content.draft}"><span v-for="(text,i) in (content.text.trimEnd()?content.text.trimEnd().split('\n'):[])" :key="i" :class="text.startsWith('+')?'added':text.startsWith('-')?'removed':''">{{text}}</span></pre>
<ToolActivityIcon v-else-if="line?.toolName==='image_create' && !content.text" name="image_create" :phase="phase" :paused="paused"/>
<pre v-else>{{content.text.trimEnd()}}</pre>
</div></section></template>
<style>
.tool-observation{margin:0 0 0 var(--activity-content-inset,30px);padding:6px 0 0;max-width:900px;min-width:0;color:var(--text);background:none;border:0}.tool-observation-viewport{height:auto;max-height:190px;padding:0;overflow:hidden;scrollbar-width:none;overscroll-behavior:contain;font:11px/18px Consolas,'Microsoft YaHei',monospace;opacity:.86}.tool-observation.is-main{pointer-events:none;user-select:none}.tool-observation.is-main .tool-observation-viewport{opacity:.68;mask-image:linear-gradient(to bottom,rgba(0,0,0,.3),#000 min(7px,20%),#000 max(calc(100% - 7px),80%),rgba(0,0,0,.25))}.tool-observation.is-pinned{width:fit-content;max-width:min(900px,calc(100% - var(--activity-content-inset,30px) + 9px));margin-left:calc(var(--activity-content-inset,30px) - 9px);margin-top:6px;padding:6px 8px;border:1px dashed color-mix(in srgb,currentColor 30%,transparent);border-radius:4px}.tool-observation.is-pinned .tool-observation-viewport{opacity:.9;mask-image:none;overflow:auto;outline-offset:2px}.tool-observation-viewport::-webkit-scrollbar{display:none}.tool-observation pre{font:inherit;margin:0;white-space:pre-wrap;overflow-wrap:anywhere}.tool-observation.is-rich .tool-observation-viewport{height:auto;max-height:360px}.observation-thumbnails{display:flex;gap:10px;flex-wrap:wrap}.observation-thumbnails figure{margin:0;width:220px;flex-shrink:0;max-width:100%}.observation-thumbnails img{width:100%;height:132px;object-fit:contain;border:1px solid color-mix(in srgb,currentColor 20%,transparent);border-radius:5px;padding:4px}.observation-thumbnails figcaption{font:inherit;line-height:18px}.observation-diff span{display:block;min-height:18px}.observation-diff .added{color:var(--green);background:color-mix(in srgb,var(--green) 7%,transparent)}.observation-diff .removed{color:var(--red);background:color-mix(in srgb,var(--red) 6%,transparent)}.observation-diff.is-draft{opacity:.75}.observation-command{min-width:0}.command-running{height:2px;width:72px;background:linear-gradient(90deg,transparent,var(--purple),transparent);background-size:50% 100%;background-repeat:no-repeat;animation:command-flow 1.4s linear infinite;margin:4px 0 6px}.is-paused *{animation-play-state:paused!important}@keyframes command-flow{from{background-position:-100px 0}to{background-position:200px 0}}@media(prefers-reduced-motion:reduce){.command-running{animation:none!important}}@media(max-width:600px){.tool-observation.is-pinned{max-width:calc(100% - var(--activity-content-inset,30px) + 9px)}.tool-observation-viewport{max-height:170px}.tool-observation.is-rich .tool-observation-viewport{height:auto;max-height:300px}}
.tool-observation pre:empty{display:none}.observation-matches section:last-child,.observation-search a:last-child,.observation-search p:last-child,.activity-plan li:last-child>.activity-plan{margin-bottom:0}.observation-list>div{display:flex;gap:6px;align-items:center;min-height:22px}.observation-list svg{width:14px;height:14px;flex-shrink:0}.tool-observation .activity-icon{width:16px;height:16px;stroke-width:2.4}.tool-observation .observation-list .activity-icon{width:14px;height:14px}.observation-matches section{margin-bottom:8px}.observation-matches small{font-size:10px;opacity:.6}.observation-search a{display:block;color:inherit;text-decoration:none;margin-bottom:8px}.observation-search p{margin:2px 0;opacity:.65}
.tool-observation .observation-thinking{font:inherit;color:inherit;overflow-wrap:anywhere}
.tool-observation .observation-thinking :is(h1,h2,h3,h4,h5,h6,p,strong,em,code,pre,blockquote,a,li){font:inherit;color:inherit;letter-spacing:normal;text-shadow:none}
.tool-observation .observation-thinking :is(h1,h2,h3,h4,h5,h6,p,pre,blockquote,ul,ol){margin:0 0 6px;padding-block:0}
.tool-observation .observation-thinking > :last-child{margin-bottom:0}
.tool-observation .observation-thinking :is(pre,code,blockquote){background:none;border:0;box-shadow:none}
</style>
