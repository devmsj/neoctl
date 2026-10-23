<script setup>
import { onMounted,onBeforeUnmount,ref } from 'vue'
const outer=ref(null),inner=ref(null)
let observer,frame=0,previous
onMounted(()=>{
 observer=new ResizeObserver(()=>{
  const height=inner.value?.getBoundingClientRect().height||0
  if(!outer.value)return
  if(previous===undefined||matchMedia('(prefers-reduced-motion: reduce)').matches){outer.value.style.height=height+'px';previous=height;return}
  if(Math.abs(height-previous)<.5)return
  cancelAnimationFrame(frame)
  outer.value.style.height=outer.value.getBoundingClientRect().height+'px'
  previous=height
  frame=requestAnimationFrame(()=>{if(outer.value)outer.value.style.height=height+'px'})
 });observer.observe(inner.value)
})
onBeforeUnmount(()=>{observer?.disconnect();cancelAnimationFrame(frame)})
</script>
<template><div ref="outer" class="activity-stable-surface"><div ref="inner" class="activity-stable-inner"><slot/></div></div></template>
<style>
.activity-stable-surface{min-width:0;transition:height 260ms cubic-bezier(.2,.7,.2,1);overflow:clip}.activity-stable-inner{display:flow-root;min-width:0}@media(prefers-reduced-motion:reduce){.activity-stable-surface{transition:none}}
</style>
