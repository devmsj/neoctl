<script setup>
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import LoadingRing from './LoadingRing.vue'
import NeoSelect from './NeoSelect.vue'
import ChromeIcon from './ChromeIcon.vue'
import { highlightSource } from '../code-highlight.mjs'
import { DEFAULT_COLORS, NUMBERS, derivePalette } from '../../shared/appearance.mjs'

const codePreview = highlightSource('// A small workspace\nconst theme = { name: "Neo", ready: true };\nfunction openWorkspace(count = 3) {\n  return theme.ready ? count : 0;\n}', 'javascript').html
const props = defineProps({ controller: { type: Object, required: true }, confirm: { type: Function, required: true } })
const emit = defineEmits(['back'])
const clone = x => JSON.parse(JSON.stringify(x))
const draft = ref(clone(props.controller.state.config)), editing = ref(document.documentElement.dataset.theme || 'dark')
const validationError = ref('')
const tab = ref('background'), busy = ref(false), message = ref(''), error = ref(''), presetName = ref(''), preset = ref('')
const backgroundInput = ref(), fontInput = ref(), importInput = ref(), fontRole = ref('ui')
const scheme = computed(() => draft.value[editing.value])
const swatches = computed(() => { const base = DEFAULT_COLORS[editing.value], p = derivePalette(scheme.value.accent || base.accent, scheme.value.background || base.background); return [p.accent, p.soft, p.hover, p.pressed] })
const dirty = computed(() => JSON.stringify(draft.value) !== JSON.stringify(props.controller.state.config))
const colors = [['background', '背景'], ['text', '正文'], ['muted', '次要文字'], ['border', '分割线'], ['userBackground', '用户消息'], ['userText', '用户文字'], ['codeBackground', '代码背景']]
const tabs = [{ value: 'background', label: '背景' }, { value: 'type', label: '字体' }, { value: 'color', label: '颜色' }, { value: 'layout', label: '布局' }]
const defaults = { uiSize: 13, textSize: 15, codeSize: 13, textWeight: 400, lineHeight: 1.6, letterSpacing: 0, paragraphSpacing: 12, radius: 5, borderWidth: 1, messageGap: 0, contentWidth: 960, sidebarWidth: 260, informationWidth: 260, backgroundOpacity: 25, backgroundBlur: 0, backgroundBrightness: 100, backgroundSaturation: 100, backgroundX: 50, backgroundY: 50 }
const backgroundControls = [['backgroundOpacity', '浓度'], ['backgroundBlur', '模糊'], ['backgroundBrightness', '亮度'], ['backgroundSaturation', '饱和度'], ['backgroundX', '水平位置'], ['backgroundY', '垂直位置']]
const typeControls = [['uiSize', '界面字号'], ['textSize', '正文字号'], ['codeSize', '代码字号'], ['textWeight', '正文字重'], ['lineHeight', '正文行高'], ['letterSpacing', '字距'], ['paragraphSpacing', '段落间距']]
const layoutControls = [['contentWidth', '内容宽度'], ['sidebarWidth', '左栏宽度'], ['informationWidth', '右栏宽度'], ['messageGap', '消息间距'], ['radius', '圆角'], ['borderWidth', '边框']]
const presetOptions = computed(() => [{ value: '', label: '当前方案' }, { value: 'builtin:default', label: '默认' }, { value: 'builtin:ink', label: '墨青' }, { value: 'builtin:sand', label: '暖砂' }, ...draft.value.presets.map(p => ({ value: 'saved:' + p.name, label: p.name }))])
let syncing = false
watch([draft, editing], () => {
  if (syncing) return
  message.value = ''
  try { props.controller.preview(draft.value, editing.value); validationError.value = '' }
  catch (e) { validationError.value = e.message }
}, { deep: true, flush: 'sync' })
function resetDraft() { syncing = true; draft.value = clone(props.controller.state.config); editing.value = props.controller.currentMode(); validationError.value = ''; syncing = false }
function number(key, event) { scheme.value[key] = Number(event.target.value) }
function reset(key) { delete scheme.value[key] }
function value(key) { return scheme.value[key] ?? defaults[key] }
async function task(fn) { if (busy.value) return; busy.value = true; error.value = ''; message.value = ''; try { await fn() } catch (e) { error.value = e.message || '操作失败' } finally { busy.value = false } }
async function save() { await task(async () => { await props.controller.save(draft.value); resetDraft(); message.value = '已保存' }) }
async function back() {
  if (busy.value) return
  if (dirty.value && !await props.confirm({ title: '放弃未保存的外观？', message: '', confirmLabel: '放弃', cancelLabel: '继续编辑' })) return
  props.controller.cancel(); emit('back')
}
function cancel() { resetDraft(); error.value = ''; props.controller.cancel() }
async function reload() { await task(async () => { if (dirty.value && !await props.confirm({ title: '重新载入并放弃当前修改？', message: '', confirmLabel: '载入' })) return; if (!await props.controller.load(true)) throw new Error(props.controller.state.error || '外观加载失败'); resetDraft(); props.controller.cancel() }) }
function choosePreset() {
  const name = preset.value
  if (name === 'builtin:default') { draft.value.light = {}; draft.value.dark = {} }
  else if (name === 'builtin:ink') { draft.value.light = { accent: '#247f78', background: '#f7faf9' }; draft.value.dark = { accent: '#76b6a6', background: '#101918' } }
  else if (name === 'builtin:sand') { draft.value.light = { accent: '#916346', background: '#faf7f1' }; draft.value.dark = { accent: '#c5a280', background: '#1b1815' } }
  else { const p = draft.value.presets.find(p => 'saved:' + p.name === name); if (p) { draft.value.light = clone(p.light); draft.value.dark = clone(p.dark) } }
}
function savePreset() {
  const name = presetName.value.trim(); if (!name) return
  if (draft.value.presets.some(p => p.name === name)) { error.value = '方案名称已存在'; return }
  if (draft.value.presets.length >= 100) { error.value = '方案数量已达上限'; return }
  draft.value.presets.push({ name, light: clone(draft.value.light), dark: clone(draft.value.dark) }); preset.value = 'saved:' + name; presetName.value = ''
}
async function upload(event, kind) {
  const file = event.target.files?.[0]; event.target.value = ''; if (!file) return
  const mode = editing.value, role = fontRole.value
  await task(async () => { const resource = await props.controller.upload(file, kind); draft.value[mode][kind === 'background' ? 'backgroundAsset' : role + 'FontAsset'] = resource.id })
}
async function exportTheme() { await task(async () => { const blob = await props.controller.exportBundle(draft.value), url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = 'neo-theme.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000) }) }
async function importTheme(event) { const file = event.target.files?.[0]; event.target.value = ''; if (file) await task(async () => { draft.value = await props.controller.importBundle(file) }) }
function beforeUnload(event) { if (dirty.value) { event.preventDefault(); event.returnValue = '' } }
onMounted(async () => { window.addEventListener('beforeunload', beforeUnload); if (!props.controller.state.loaded) { await props.controller.load(); resetDraft() } })
onBeforeUnmount(() => { window.removeEventListener('beforeunload', beforeUnload); props.controller.cancel() })
defineExpose({ dirty, beforeLeave: async () => !busy.value && (!dirty.value || await props.confirm({ title: '放弃未保存的外观？', message: '', confirmLabel: '放弃', cancelLabel: '继续编辑' })) })
</script>

<template>
  <section class="appearance-editor" aria-label="外观">
    <header class="appearance-head">
      <button type="button" aria-label="返回全局配置" @click="back"><ChromeIcon name="back" /></button>
      <h2>外观</h2><span class="appearance-head-space"></span>
      <LoadingRing v-if="busy || controller.state.loading" />
      <button type="button" :disabled="busy || !dirty" @click="cancel">取消</button>
      <button type="button" class="appearance-apply" :disabled="busy || !controller.state.loaded || !dirty || !!validationError" @click="save">应用</button>
    </header>
    <div v-if="validationError || error || controller.state.error" class="appearance-error" role="alert">{{ validationError || error || controller.state.error }}<button type="button" :disabled="busy" @click="reload">重新载入</button></div>
    <span v-if="message" role="status" class="appearance-status">{{ message }}</span>
    <div class="appearance-topline">
      <div class="appearance-mode" role="group" aria-label="编辑日夜方案">
        <button v-for="(label, mode) in { light: '日间', dark: '夜间' }" :key="mode" type="button" :aria-pressed="editing === mode" @click="editing = mode">{{ label }}</button>
      </div>
      <NeoSelect v-model="draft.mode" :options="[{value:'system',label:'跟随系统'},{value:'light',label:'固定日间'},{value:'dark',label:'固定夜间'}]" aria-label="主题模式" />
    </div>
    <div class="appearance-presets">
      <NeoSelect v-model="preset" :options="presetOptions" aria-label="主题方案" @change="choosePreset" />
      <button type="button" data-tooltip="导入主题" @click="importInput.click()">导入</button><button type="button" :disabled="busy" @click="exportTheme">导出</button>
      <details class="appearance-save-menu"><summary><ChromeIcon name="save" /><span>保存方案</span></summary><div class="appearance-preset-save"><input v-model="presetName" maxlength="60" placeholder="方案名称" aria-label="方案名称" @keydown.enter.prevent="savePreset" /><button type="button" @click="savePreset">添加</button><button v-if="preset.startsWith('saved:')" type="button" @click="draft.presets = draft.presets.filter(p => 'saved:' + p.name !== preset); preset = ''">删除此方案</button></div></details>
    </div>
    <nav class="appearance-tabs" aria-label="外观分类"><button v-for="item in tabs" :key="item.value" type="button" :aria-current="tab === item.value ? 'page' : undefined" @click="tab = item.value">{{ item.label }}</button></nav>
    <div class="appearance-body">
      <fieldset class="appearance-controls" :disabled="busy || !controller.state.loaded">
        <template v-if="tab === 'background'">
          <button type="button" class="appearance-background-picker" @click="backgroundInput.click()"><img v-if="scheme.backgroundAsset" :src="controller.assetUrl(scheme.backgroundAsset)" alt="当前背景" /><span>{{ scheme.backgroundAsset ? '更换背景' : '上传背景图' }}</span></button>
          <div class="appearance-row"><label for="appearance-bg-color">背景色</label><input id="appearance-bg-color" type="color" :value="scheme.background || DEFAULT_COLORS[editing].background" @input="scheme.background = $event.target.value" /><button type="button" class="appearance-reset" data-tooltip="恢复背景色" @click="reset('background')">↺</button></div>
          <template v-if="scheme.backgroundAsset">
            <div class="appearance-row"><span>范围</span><NeoSelect v-model="scheme.backgroundScope" :options="[{value:'workspace',label:'整个工作台'},{value:'chat',label:'仅聊天区'}]" placeholder="整个工作台" aria-label="背景范围" /></div>
            <div class="appearance-row"><span>填充</span><NeoSelect v-model="scheme.backgroundFit" :options="[{value:'cover',label:'铺满'},{value:'contain',label:'完整显示'},{value:'repeat',label:'平铺'}]" placeholder="铺满" aria-label="背景填充" /></div>
            <div v-for="[key, label] in backgroundControls" :key="key" class="appearance-slider"><label :for="'appearance-'+key">{{ label }}</label><input :id="'appearance-'+key" type="range" :min="NUMBERS[key][0]" :max="NUMBERS[key][1]" :value="value(key)" @input="number(key,$event)" /><output>{{ value(key) }}</output><button type="button" class="appearance-reset" :aria-label="'恢复'+label" @click="reset(key)">↺</button></div>
            <button type="button" class="appearance-text-button" @click="reset('backgroundAsset')">移除背景</button>
          </template>
        </template>
        <template v-if="tab === 'color'">
          <div class="appearance-row appearance-accent"><label for="appearance-accent">重点色</label><input id="appearance-accent" type="color" :value="scheme.accent || DEFAULT_COLORS[editing].accent" @input="scheme.accent = $event.target.value" /><button type="button" class="appearance-reset" data-tooltip="恢复重点色" @click="reset('accent')">↺</button></div>
          <div class="appearance-derived" aria-label="自动配色预览"><i v-for="(color, index) in swatches" :key="index" :style="{background:color}"></i></div>
          <details class="appearance-advanced"><summary>区域配色</summary><div v-for="[key,label] in colors" :key="key" class="appearance-row"><label :for="'appearance-color-'+key">{{label}}</label><input :id="'appearance-color-'+key" type="color" :value="scheme[key] || DEFAULT_COLORS[editing][key]" @input="scheme[key] = $event.target.value"/><button type="button" class="appearance-reset" :aria-label="'恢复'+label" @click="reset(key)">↺</button></div></details>
          <div class="appearance-row"><span>代码配色</span><NeoSelect v-model="scheme.codeTheme" :options="[{value:'default',label:'跟随主题'},{value:'soft',label:'单色'},{value:'contrast',label:'多彩'}]" placeholder="跟随主题" aria-label="代码配色"/></div>
        </template>
        <template v-if="tab === 'type'">
          <div v-for="[role,label] in [['ui','界面'],['text','正文'],['code','代码']]" :key="role" class="appearance-font"><label :for="'appearance-font-'+role">{{label}}</label><div><NeoSelect :input-id="'appearance-font-'+role" editable :model-value="scheme[role+'Font'] || ''" :options="['Microsoft YaHei','Segoe UI','Noto Sans SC','SimSun','Georgia','Consolas','Cascadia Code','JetBrains Mono']" placeholder="系统默认" :aria-label="label+'字体'" @update:model-value="scheme[role+'Font']=$event; reset(role+'FontAsset')"/><button type="button" :data-tooltip="'导入'+label+'字体'" @click="fontRole=role; fontInput.click()">{{scheme[role+'FontAsset']?'已导入':'导入'}}</button><button type="button" class="appearance-reset" :aria-label="'恢复'+label+'字体'" @click="reset(role+'Font');reset(role+'FontAsset')">↺</button></div></div>
          <div v-for="[key,label] in typeControls" :key="key" class="appearance-slider"><label :for="'appearance-'+key">{{label}}</label><input :id="'appearance-'+key" type="range" :min="NUMBERS[key][0]" :max="NUMBERS[key][1]" :step="key==='lineHeight'?.05:key==='letterSpacing'?.1:key==='textWeight'?100:1" :value="value(key)" @input="number(key,$event)"/><output>{{value(key)}}</output><button type="button" class="appearance-reset" :aria-label="'恢复'+label" @click="reset(key)">↺</button></div>
        </template>
        <template v-if="tab === 'layout'"><div v-for="[key,label] in layoutControls" :key="key" class="appearance-slider"><label :for="'appearance-'+key">{{label}}</label><input :id="'appearance-'+key" type="range" :min="NUMBERS[key][0]" :max="NUMBERS[key][1]" :step="key==='borderWidth'?.5:1" :value="value(key)" @input="number(key,$event)"/><output>{{value(key)}}</output><button type="button" class="appearance-reset" :aria-label="'恢复'+label" @click="reset(key)">↺</button></div></template>
        <button type="button" class="appearance-restore" @click="draft[editing] = {}">恢复{{editing==='light'?'日间':'夜间'}}默认</button>
      </fieldset>
      <aside class="appearance-preview" aria-label="外观实时预览">
        <div class="appearance-preview-top"><span>Neo Desktop</span><LoadingRing /></div>
        <div class="appearance-preview-user">让工作台更像你。<br/>保持清晰，也保留个性。</div>
        <div class="appearance-preview-answer"><strong>你的工作空间</strong><p>文字、颜色和背景，一起恰到好处。</p><a href="#" @click.prevent>查看内容 ↗</a><div class="markdown appearance-code-preview"><pre data-lang="javascript"><code class="hljs" v-html="codePreview"></code></pre><table><thead><tr><th>名称</th><th>状态</th></tr></thead><tbody><tr><td>Workspace</td><td>Ready</td></tr></tbody></table></div></div>
        <div class="appearance-preview-input"><span>有什么想做的？</span><button type="button" tabindex="-1" aria-label="预览发送按钮">↑</button></div>
      </aside>
    </div>
    <input ref="backgroundInput" class="appearance-file" type="file" accept="image/png,image/jpeg,image/webp,image/gif" aria-label="上传背景文件" @change="upload($event,'background')"/>
    <input ref="fontInput" class="appearance-file" type="file" accept=".woff,.woff2,.ttf,.otf" aria-label="上传字体文件" @change="upload($event,'font')"/>
    <input ref="importInput" class="appearance-file" type="file" accept=".json" aria-label="导入主题文件" @change="importTheme"/>
  </section>
</template>
