<script setup lang="ts">
import { onMounted } from 'vue'
import { useFleet } from '../stores/fleet'
import type { Vm } from '../shared/api'

const store = useFleet()
const emit = defineEmits<{ (e: 'select', name: string): void }>()

const short = (n: string) => (n.startsWith('mf-') ? n.slice(3) : n)

onMounted(() => {
  store.refresh()
})

function select(vm: Vm) {
  emit('select', short(vm.name))
}
</script>

<template>
  <aside class="w-64 shrink-0 border-r border-neutral-800 p-2 text-sm">
    <div v-if="store.error" class="mb-2 text-red-400">{{ store.error }}</div>
    <button
      v-for="vm in store.vms"
      :key="vm.name"
      data-test="vm-row"
      class="flex w-full items-center gap-2 rounded px-2 py-1 text-left hover:bg-neutral-800"
      @click="select(vm)"
    >
      <span
        class="h-2 w-2 rounded-full"
        :class="vm.healthy ? 'bg-green-500' : 'bg-neutral-600'"
      />
      <span class="flex-1">{{ vm.name }}</span>
      <span class="text-neutral-500">{{ vm.state }}</span>
    </button>
  </aside>
</template>
