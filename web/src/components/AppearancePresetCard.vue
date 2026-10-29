<script setup>
import { computed } from 'vue'
import ChromeIcon from './ChromeIcon.vue'
import { DEFAULT_COLORS, deriveSurfaces } from '../../shared/appearance.mjs'
const props = defineProps({ preset: Object, mode: String, selected: Boolean, applied: Boolean, disabled: Boolean, assetUrl: Function })
defineEmits(['select', 'edit', 'apply', 'remove', 'reset'])
const style = computed(() => {
  const s = props.preset[props.mode], base = DEFAULT_COLORS[props.mode], bg = s.background || base.background, surfaces = deriveSurfaces(bg, props.mode)
  return { '--sample-bg': bg, '--sample-panel': surfaces.panel, '--sample-surface': surfaces.surface, '--sample-accent': s.accent || base.accent, '--sample-text': s.text || base.text, '--sample-radius': (s.radius ?? 5) + 'px' }
})
</script>
<template>
  <article class="appearance-preset-card" :class="{ 'is-material': preset.material }" :style="style" :data-selected="selected" :aria-label="preset.name">
    <button type="button" class="preset-preview" :aria-label="preset.name" :aria-pressed="selected" :disabled="disabled" @click="$emit('select')"><span class="preset-scene" aria-hidden="true">
      <img v-if="preset[mode].backgroundAsset" class="preset-image" :src="assetUrl(preset[mode].backgroundAsset)" alt="" loading="lazy" />
      <span class="preset-orbit"></span>
      <span class="preset-window">
        <span class="preset-side"><i></i><i></i><i></i><i></i></span>
        <span class="preset-chat"><span class="preset-user"></span><span class="preset-answer"><i></i><i></i><i></i></span><span class="preset-composer"><i></i><b>↑</b></span></span>
      </span>
    </span>
    </button>
    <span class="preset-caption"><span class="preset-name">{{ preset.name }}</span><span class="preset-kind">{{ preset.saved ? '自定义' : preset.material ? '磨砂' : '' }}</span><span class="preset-actions">
      <button type="button" :aria-label="'编辑'+preset.name" :data-tooltip="'编辑'+preset.name" :disabled="disabled" @click="$emit('edit')"><ChromeIcon name="edit" /></button>
      <button v-if="preset.saved" type="button" :aria-label="'删除'+preset.name" :disabled="disabled" @click="$emit('remove')"><ChromeIcon name="trash" /></button>
      <button v-else type="button" :aria-label="'重置'+preset.name" :disabled="disabled || !preset.modified" @click="$emit('reset')"><ChromeIcon name="undo" /></button>
      <button type="button" class="preset-apply" :aria-label="'应用'+preset.name" :data-tooltip="applied ? '已应用' : '应用'+preset.name" :aria-pressed="applied" :disabled="disabled" @click="$emit('apply')"><ChromeIcon :name="applied ? 'check' : 'apply'" /></button>
    </span></span>
  </article>
</template>
<style scoped>
:root[data-theme] .appearance-editor .appearance-preset-card {
  display:flex; flex-direction:column; padding:0 !important; min-width:0; width:100%; text-align:left;
  border:1px solid var(--chrome-line-soft) !important; border-radius:var(--appearance-radius,8px) !important;
  overflow:hidden; background:transparent !important; transform:none !important; transition:border-color .16s;
}
:root[data-theme] .appearance-editor .appearance-preset-card:hover:not(:disabled) { border-color:var(--chrome-accent) !important; background:transparent !important; }
:root[data-theme] .appearance-editor .appearance-preset-card[data-selected='true'] { border-color:var(--chrome-accent) !important; outline:1px solid var(--chrome-accent); outline-offset:2px; }
.appearance-preset-card:focus-visible { outline:2px solid var(--chrome-accent) !important; outline-offset:3px; }
.preset-scene { display:block; position:relative; width:100%; aspect-ratio:1.65; overflow:hidden; isolation:isolate; background:var(--sample-bg); }
.preset-orbit { position:absolute; width:75%; aspect-ratio:1; border-radius:50%; right:-8%; top:-22%; background:radial-gradient(ellipse,color-mix(in srgb,var(--sample-accent) 20%,transparent),transparent 70%); }
.is-material .preset-orbit { background:linear-gradient(135deg,color-mix(in srgb,var(--sample-accent) 55%,transparent),transparent); transform:rotate(-25deg); width:110%; border-radius:28%; filter:blur(13px); top:-20%; }
.preset-image { position:absolute; inset:0; width:100%; height:100%; object-fit:cover; opacity:.5; }
.preset-window { display:flex; position:absolute; inset:15% 10% 12%; border:1px solid color-mix(in srgb,var(--sample-text) 13%,transparent); border-radius:var(--sample-radius); overflow:hidden; background:color-mix(in srgb,var(--sample-panel) 82%,transparent); box-shadow:0 8px 18px #0000000c; }
.is-material .preset-window { background:color-mix(in srgb,var(--sample-panel) 48%,transparent); }
.preset-side { display:flex; flex-direction:column; gap:9%; width:23%; padding:13% 5% 0; border-right:1px solid color-mix(in srgb,var(--sample-text) 9%,transparent); background:color-mix(in srgb,var(--sample-panel) 50%,transparent); }
.preset-side i { display:block; height:3px; background:color-mix(in srgb,var(--sample-text) 20%,transparent); border-radius:2px; }
.preset-side i:first-child { background:var(--sample-accent); height:5px; margin-bottom:10%; }
.preset-chat { flex:1; min-width:0; padding:10% 7% 6%; display:flex; flex-direction:column; gap:10%; }
.preset-user { width:70%; height:14%; min-height:7px; align-self:flex-end; border-radius:2px; background:color-mix(in srgb,var(--sample-accent) 20%,transparent); }
.preset-answer { display:grid; gap:5px; }.preset-answer i { height:2px; width:90%; background:color-mix(in srgb,var(--sample-text) 28%,transparent); }.preset-answer i:last-child { width:56%; }
.preset-composer { display:flex; align-items:center; justify-content:space-between; margin-top:auto; height:25%; min-height:15px; padding:3px 5px; border:1px solid color-mix(in srgb,var(--sample-text) 12%,transparent); border-radius:3px; background:color-mix(in srgb,var(--sample-surface) 60%,transparent); }
.preset-composer i { width:44%; height:2px; background:color-mix(in srgb,var(--sample-text) 22%,transparent); }.preset-composer b { color:var(--sample-accent); font:12px/1 sans-serif; }
.preset-caption { display:flex; align-items:center; gap:8px; padding:13px 14px; width:100%; box-sizing:border-box; }
.preset-name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }.preset-kind { font-size:10px; color:var(--chrome-muted); margin-left:auto; white-space:nowrap; }.preset-dot { width:7px; height:7px; flex:none; border-radius:50%; background:var(--sample-accent); }
@media(prefers-reduced-motion:reduce) { .appearance-preset-card { transition:none !important; } }
/* The preview and actions are siblings, never nested interactive buttons. */
:root[data-theme] .appearance-editor .preset-preview { display:block; width:100%; padding:0 !important; border:0 !important; border-radius:0 !important; overflow:hidden; background:transparent !important; }
.preset-actions { display:flex; gap:3px; align-items:center; margin-left:auto; }
:root[data-theme] .appearance-editor .preset-actions button { display:grid; place-items:center; min-height:28px; width:28px; padding:4px !important; }
.preset-actions svg { width:14px; height:14px; }
:root[data-theme] .appearance-editor .preset-actions .preset-apply[aria-pressed='true'] { color:var(--chrome-accent) !important; }
.preset-kind { margin-left:0; }.preset-caption { gap:6px; padding:10px 11px; }
</style>
