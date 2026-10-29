<script setup>
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import LoadingRing from './LoadingRing.vue'
import NeoSelect from './NeoSelect.vue'
import ChromeIcon from './ChromeIcon.vue'
import AppearancePresetCard from './AppearancePresetCard.vue'
import { APPEARANCE_PRESETS, availableAppearancePresets, matchesAppearancePreset } from '../appearance-presets.mjs'
import { isDesktop } from '../local-resources.mjs'
import { appearanceDraftStore } from '../appearance-draft.mjs'
const draftStore = appearanceDraftStore()
const desktopMaterial = isDesktop() && /Windows/.test(navigator.userAgent)
import { highlightSource } from '../code-highlight.mjs'
import { DEFAULT_COLORS, NUMBERS, derivePalette } from '../../shared/appearance.mjs'

const codePreview = highlightSource('// A small workspace\nconst theme = { name: "Neo", ready: true };\nfunction openWorkspace(count = 3) {\n  return theme.ready ? count : 0;\n}', 'javascript').html
const props = defineProps({ controller: { type: Object, required: true }, confirm: { type: Function, required: true } })
const emit = defineEmits(['back'])
const clone = x => JSON.parse(JSON.stringify(x))
const draft = ref(clone(props.controller.state.config)), editing = ref(document.documentElement.dataset.theme || 'dark')
const validationError = ref('')
const builtinId = ref('')
const designing = ref(false), originalName = ref(''), designBaseline = ref('')
const tab = ref('background'), busy = ref(false), message = ref(''), error = ref(''), presetName = ref(''), preset = ref('')
const backgroundInput = ref(), fontInput = ref(), fontRole = ref('ui')
const scheme = computed(() => draft.value[editing.value])
const swatches = computed(() => { const base = DEFAULT_COLORS[editing.value], p = derivePalette(scheme.value.accent || base.accent, scheme.value.background || base.background); return [p.accent, p.soft, p.hover, p.pressed] })
const dirty = computed(() => designing.value
  ? JSON.stringify({ light: draft.value.light, dark: draft.value.dark, name: presetName.value }) !== designBaseline.value
  : JSON.stringify(draft.value) !== JSON.stringify(props.controller.state.config))
const colors = [['background', '背景'], ['text', '正文'], ['muted', '次要文字'], ['border', '分割线'], ['userBackground', '用户消息'], ['userText', '用户文字'], ['codeBackground', '代码背景']]
const tabs = [{ value: 'background', label: '背景' }, { value: 'type', label: '字体' }, { value: 'color', label: '颜色' }, { value: 'layout', label: '布局' }]
const defaults = { windowTransparency: 0, windowFrost: 0, uiSize: 13, textSize: 15, codeSize: 13, textWeight: 400, lineHeight: 1.6, letterSpacing: 0, paragraphSpacing: 12, radius: 5, borderWidth: 1, messageGap: 0, contentWidth: 960, sidebarWidth: 260, informationWidth: 260, backgroundOpacity: 25, backgroundBlur: 0, backgroundBrightness: 100, backgroundSaturation: 100, backgroundX: 50, backgroundY: 50 }
const backgroundControls = [['backgroundOpacity', '浓度'], ['backgroundBlur', '模糊'], ['backgroundBrightness', '亮度'], ['backgroundSaturation', '饱和度'], ['backgroundX', '水平位置'], ['backgroundY', '垂直位置']]
const typeControls = [['uiSize', '界面字号'], ['textSize', '正文字号'], ['codeSize', '代码字号'], ['textWeight', '正文字重'], ['lineHeight', '正文行高'], ['letterSpacing', '字距'], ['paragraphSpacing', '段落间距']]
const layoutControls = [['contentWidth', '内容宽度'], ['sidebarWidth', '左栏宽度'], ['informationWidth', '右栏宽度'], ['messageGap', '消息间距'], ['radius', '圆角'], ['borderWidth', '边框']]
const catalogue = computed(() => availableAppearancePresets(draft.value.presets, desktopMaterial))
const appliedPreset = computed(() => catalogue.value.find(p => matchesAppearancePreset(props.controller.state.config, p))?.key || '')
const selectedPreset = computed(() => catalogue.value.find(p => matchesAppearancePreset(draft.value, p))?.key || '')
function beginDesign(item) {
  if (busy.value) return
  syncing = true
  draft.value = clone(props.controller.state.config)
  if (item) { draft.value.light = clone(item.light); draft.value.dark = clone(item.dark) }
  builtinId.value = item && !item.saved ? item.id : ''
  originalName.value = item?.saved ? item.name : ''
  presetName.value = item?.name || ''
  designBaseline.value = JSON.stringify({ light: draft.value.light, dark: draft.value.dark, name: presetName.value })
  designing.value = true; tab.value = 'background'; validationError.value = ''; error.value = ''
  syncing = false
  props.controller.preview(draft.value, editing.value)
}
function openDesign() { beginDesign() }
async function returnGallery() {
  if (!await beforeLeave()) return
  designing.value = false; builtinId.value = ''; originalName.value = ''; presetName.value = ''
  cancel()
}
function editPreset(key) { beginDesign(catalogue.value.find(p => p.key === key)) }
async function applyPreset(key) { if (busy.value) return; choosePreset(key); await save() }
async function changeMode(mode) {
  if (busy.value) return
  if (designing.value) { draft.value.mode = mode; return }
  // A mode change must not silently commit an unrelated card preview/draft.
  await task(async () => {
    await props.controller.save({ ...clone(props.controller.state.config), mode })
    syncing = true; draft.value.mode = mode; syncing = false
    stashDraft()
    if (dirty.value) props.controller.preview(draft.value, editing.value)
    else editing.value = props.controller.currentMode()
  })
}

let syncing = false, leavePromise
function stashDraft() {
  if (!props.controller.state.loaded) return
  if (dirty.value) { if (!draftStore.write(draft.value, props.controller.state.revision, editing.value, designing.value ? { builtinId: builtinId.value, name: presetName.value, originalName: originalName.value, baseline: designBaseline.value } : undefined)) error.value = '草稿无法保留，请先应用修改' }
  else draftStore.clear()
}
watch([draft, editing, presetName], () => {
  if (syncing) return
  message.value = ''
  stashDraft()
  try { props.controller.preview(draft.value, editing.value); validationError.value = '' }
  catch (e) { validationError.value = e.message }
}, { deep: true, flush: 'sync' })
function resetDraft() { syncing = true; draft.value = clone(props.controller.state.config); editing.value = props.controller.currentMode(); validationError.value = ''; syncing = false }
// Menu and system-mode updates must stay in sync without replacing an open design.
watch(() => props.controller.state.config, () => {
  if (!designing.value && !props.controller.state.previewing) resetDraft()
})
function number(key, event) { scheme.value[key] = Number(event.target.value) }
function reset(key) { delete scheme.value[key] }
function value(key) { return scheme.value[key] ?? defaults[key] }
async function task(fn) { if (busy.value) return; busy.value = true; error.value = ''; message.value = ''; try { await fn() } catch (e) { error.value = e.message || '操作失败' } finally { busy.value = false } }
async function save() { await task(async () => { await props.controller.save(draft.value); draftStore.clear(); resetDraft(); message.value = '已保存' }) }
async function back() {
  if (designing.value) { await returnGallery(); return }
  if (!await beforeLeave()) return
  props.controller.cancel(); emit('back')
}
function cancel() {
  syncing = true
  if (designing.value && designBaseline.value) {
    const baseline = JSON.parse(designBaseline.value)
    draft.value.light = baseline.light; draft.value.dark = baseline.dark; presetName.value = baseline.name
  } else resetDraft()
  syncing = false; draftStore.clear(); validationError.value = ''; error.value = ''
  props.controller.cancel()
}
async function reload() { await task(async () => { if (dirty.value && !await props.confirm({ title: '重新载入并放弃当前修改？', message: '', confirmLabel: '载入' })) return; if (!await props.controller.load(true)) throw new Error(props.controller.state.error || '外观加载失败'); draftStore.clear(); resetDraft(); props.controller.cancel() }) }
function choosePreset(key = preset.value) {
  const p = catalogue.value.find(p => p.key === key)
  if (!p) return
  // One atomic preview, preserving theme mode and the user's saved catalogue.
  draft.value = { ...draft.value, light: clone(p.light), dark: clone(p.dark) }
  preset.value = p.key
}

async function finishDesign() {
  const builtin = APPEARANCE_PRESETS.find(p => p.id === builtinId.value)
  const name = builtin ? builtin.name : presetName.value.trim()
  if (!name) { error.value = '请为外观命名'; return }
  if (catalogue.value.some(p => p.name === name && !(builtin ? p.id === builtin.id : p.saved && p.name === originalName.value))) { error.value = '名称已存在'; return }
  await task(async () => {
    const config = clone(props.controller.state.config)
    const item = { name, light: clone(draft.value.light), dark: clone(draft.value.dark), ...(builtin ? { builtin: builtin.id } : {}) }
    const index = config.presets.findIndex(p => builtin ? p.builtin === builtin.id : !p.builtin && p.name === originalName.value)
    if (originalName.value && index < 0) throw new Error('原方案已不存在，请重新载入')
    if (index < 0) { if (config.presets.length >= 100) throw new Error('方案数量已达上限'); config.presets.push(item) }
    else config.presets[index] = item
    // Editing the applied system scheme updates it in place; new designs and
    // custom edits remain separate from the current appearance.
    const previous = builtin && catalogue.value.find(p => p.id === builtin.id)
    if (previous && matchesAppearancePreset(config, previous)) { config.light = clone(item.light); config.dark = clone(item.dark) }
    await props.controller.save(config)
    syncing = true; designing.value = false; builtinId.value = ''; originalName.value = ''; presetName.value = ''; syncing = false
    draftStore.clear(); resetDraft(); props.controller.cancel(); message.value = '已保存外观'
  })
}
async function removePreset(item) {
  if (busy.value || !item.saved) return
  if (!await props.confirm({ title: '删除“' + item.name + '”？', message: '', confirmLabel: '删除' })) return
  await task(async () => {
    const config = clone(props.controller.state.config)
    config.presets = config.presets.filter(p => p.builtin || p.name !== item.name)
    // Keep the current appearance and its assets even when its saved card is removed.
    await props.controller.save(config)
    draftStore.clear(); resetDraft(); props.controller.cancel()
  })
}
async function restorePreset(item) {
  const builtin = APPEARANCE_PRESETS.find(p => p.id === item.id)
  if (busy.value || !builtin || item.saved) return
  await task(async () => {
    const config = clone(props.controller.state.config)
    if (matchesAppearancePreset(config, item)) { config.light = clone(builtin.light); config.dark = clone(builtin.dark) }
    config.presets = config.presets.filter(p => p.builtin !== builtin.id)
    await props.controller.save(config)
    draftStore.clear(); resetDraft(); props.controller.cancel()
  })
}
async function upload(event, kind) {
  const file = event.target.files?.[0]; event.target.value = ''; if (!file) return
  const mode = editing.value, role = fontRole.value
  await task(async () => { const resource = await props.controller.upload(file, kind); draft.value[mode][kind === 'background' ? 'backgroundAsset' : role + 'FontAsset'] = resource.id })
}
async function beforeLeave() {
  if (busy.value) return false
  if (!dirty.value) return true
  if (leavePromise) return leavePromise
  leavePromise = (async () => {
    if (!await props.confirm({ title: '放弃未保存的外观？', message: '', confirmLabel: '放弃', cancelLabel: '继续编辑' })) return false
    cancel(); return true
  })()
  try { return await leavePromise } finally { leavePromise = undefined }
}
function requestDesktopLeave(event) {
  if (!event.detail || typeof event.detail.waitUntil !== 'function') return
  event.detail.waitUntil(beforeLeave())
}
onMounted(async () => {
  window.addEventListener('neo:before-leave', requestDesktopLeave)
  if (!props.controller.state.loaded) { await props.controller.load(); resetDraft() }
  const saved = draftStore.read()
  if (!saved) return
  if (!saved.design && JSON.stringify(saved.config) === JSON.stringify(props.controller.state.config)) { draftStore.clear(); return }
  // Never overwrite a newer server revision with an older full draft silently.
  if (saved.revision !== props.controller.state.revision && !await props.confirm({ title: '恢复未应用的外观草稿？', message: '已保存的外观有更新。', confirmLabel: '恢复草稿', cancelLabel: '使用已保存' })) { draftStore.clear(); return }
  syncing = true
  draft.value = clone(saved.config); editing.value = saved.editing
  if (saved.design) { builtinId.value = saved.design.builtinId || ''; designing.value = true; presetName.value = saved.design.name; originalName.value = saved.design.originalName; designBaseline.value = saved.design.baseline }
  syncing = false; props.controller.preview(draft.value, editing.value)
  message.value = '已恢复未应用的草稿'
})
onBeforeUnmount(() => { window.removeEventListener('neo:before-leave', requestDesktopLeave); props.controller.cancel() })
defineExpose({ dirty, beforeLeave })
</script>

<template>
  <section class="appearance-editor" aria-label="外观">
    <header class="appearance-head">
      <button type="button" :aria-label="designing ? '返回外观' : '返回全局配置'" @click="back"><ChromeIcon name="back" /></button>
      <h2>{{ designing ? (originalName || builtinId ? '编辑外观' : '设计外观') : '外观' }}</h2><span class="appearance-head-space"></span>
      <LoadingRing v-if="busy || controller.state.loading" />
      <button v-if="designing" type="button" aria-label="撤销修改" data-tooltip="撤销修改" :disabled="busy || !dirty" @click="cancel"><ChromeIcon name="undo" /></button>
      <button v-if="designing" type="button" aria-label="完成设计" data-tooltip="完成设计" class="appearance-apply" :disabled="busy || !controller.state.loaded || !presetName.trim() || !!validationError" @click="finishDesign"><ChromeIcon name="save" /></button>
    </header>
    <div v-if="validationError || error || controller.state.error" class="appearance-error" role="alert">{{ validationError || error || controller.state.error }}<button type="button" :disabled="busy" @click="reload">重新载入</button></div>
    <span v-if="message" role="status" class="appearance-status">{{ message }}</span>
    <div class="appearance-topline">
      <div class="appearance-mode" role="group" aria-label="编辑日夜方案">
        <button v-for="(label, mode) in { light: '日间', dark: '夜间' }" :key="mode" type="button" :aria-pressed="editing === mode" @click="editing = mode">{{ label }}</button>
      </div>
      <NeoSelect v-if="!designing" :model-value="draft.mode" :disabled="busy" @update:model-value="changeMode" :options="[{value:'system',label:'跟随系统'},{value:'light',label:'固定日间'},{value:'dark',label:'固定夜间'}]" aria-label="主题模式" />
    </div>
    <template v-if="!designing">
      <div class="appearance-gallery-toolbar">
        <button type="button" class="appearance-design-entry" :disabled="busy || !controller.state.loaded" @click="openDesign"><ChromeIcon name="edit" /><span>设计外观</span><span aria-hidden="true">↗</span></button>
        <span class="appearance-head-space"></span>
      </div>
      <div class="appearance-preset-grid" aria-label="外观预设">
        <AppearancePresetCard v-for="item in catalogue" :key="item.key" :preset="item" :mode="editing" :selected="selectedPreset === item.key" :applied="appliedPreset === item.key" :disabled="busy || !controller.state.loaded" :asset-url="controller.assetUrl" @select="choosePreset(item.key)" @edit="editPreset(item.key)" @apply="applyPreset(item.key)" @remove="removePreset(item)" @reset="restorePreset(item)" />
      </div>
    </template>
    <template v-else>
    <div class="appearance-design-name"><label for="appearance-design-name">名称</label><input id="appearance-design-name" v-model="presetName" maxlength="60" placeholder="为外观命名" aria-label="外观名称" :readonly="!!builtinId" :disabled="busy" @keydown.enter.prevent="finishDesign" /></div>
    <nav class="appearance-tabs" aria-label="外观分类"><button v-for="item in tabs" :key="item.value" type="button" :aria-current="tab === item.value ? 'page' : undefined" @click="tab = item.value">{{ item.label }}</button></nav>
    <div class="appearance-body">
      <fieldset class="appearance-controls" :disabled="busy || !controller.state.loaded">
        <template v-if="tab === 'background'">
          <button type="button" class="appearance-background-picker" @click="backgroundInput.click()"><img v-if="scheme.backgroundAsset" :src="controller.assetUrl(scheme.backgroundAsset)" alt="当前背景" /><span>{{ scheme.backgroundAsset ? '更换背景' : '上传背景图' }}</span></button>
          <div class="appearance-row"><label for="appearance-bg-color">背景色</label><input id="appearance-bg-color" type="color" :value="scheme.background || DEFAULT_COLORS[editing].background" @input="scheme.background = $event.target.value" /><button type="button" class="appearance-reset" data-tooltip="恢复背景色" @click="reset('background')">↺</button></div>
          <template v-if="desktopMaterial">
            <div class="appearance-slider"><label for="appearance-windowTransparency">窗口透明度</label><input id="appearance-windowTransparency" type="range" min="0" max="100" :value="value('windowTransparency')" @input="number('windowTransparency',$event)" /><output>{{ value('windowTransparency') }}%</output><button type="button" class="appearance-reset" aria-label="恢复窗口透明度" @click="reset('windowTransparency')">↺</button></div>
            <div class="appearance-row"><label for="appearance-windowFrost">磨砂度</label><NeoSelect input-id="appearance-windowFrost" :model-value="String(value('windowFrost'))" :options="[{value:'0',label:'关闭'},{value:'2',label:'Windows 磨砂'}]" aria-label="磨砂度" @update:model-value="scheme.windowFrost = Number($event)" /><button type="button" class="appearance-reset" aria-label="恢复磨砂度" @click="reset('windowFrost')">↺</button></div>
          </template>
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
    </template>
    <input ref="backgroundInput" class="appearance-file" type="file" accept="image/png,image/jpeg,image/webp,image/gif" aria-label="上传背景文件" @change="upload($event,'background')"/>
    <input ref="fontInput" class="appearance-file" type="file" accept=".woff,.woff2,.ttf,.otf" aria-label="上传字体文件" @change="upload($event,'font')"/>
  </section>
</template>
