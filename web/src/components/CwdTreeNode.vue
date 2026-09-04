<script setup>
defineOptions({ name: 'CwdTreeNode' })

defineProps({
  nodes: { type: Array, default: () => [] },
  children: { type: Object, default: () => ({}) },
  expanded: { type: Object, default: () => ({}) },
  selectedPath: { type: String, default: '' },
  level: { type: Number, default: 0 },
  allowDelete: { type: Boolean, default: true },
})

const emit = defineEmits(['toggle', 'select', 'delete'])
</script>

<template>
  <div v-for="node in nodes" :key="node.path" class="cwd-tree-branch">
    <div
      :class="['cwd-tree-row', { selected: selectedPath === node.path }]"
      :style="{ '--cwd-tree-level': level }"
      @dblclick="emit('toggle', node)"
    >
      <button
        type="button"
        class="cwd-tree-toggle"
        :aria-label="expanded[node.path] ? '收起' : '展开'"
        @click.stop="emit('toggle', node)"
      >{{ expanded[node.path] ? '▾' : '▸' }}</button>
      <button type="button" class="cwd-tree-name" :title="node.path" @click="emit('select', node)">
        <span aria-hidden="true">◇</span>
        <strong>{{ node.name }}</strong>
      </button>
      <button
        v-if="allowDelete"
        type="button"
        class="cwd-tree-delete"
        :aria-label="`删除 ${node.name}`"
        @click.stop="emit('delete', node)"
      >×</button>
    </div>
    <CwdTreeNode
      v-if="expanded[node.path] && children[node.path]"
      :nodes="children[node.path]"
      :children="children"
      :expanded="expanded"
      :selected-path="selectedPath"
      :level="level + 1"
      @toggle="emit('toggle', $event)"
      @select="emit('select', $event)"
      @delete="emit('delete', $event)"
    />
  </div>
</template>
