<script setup lang="ts">
import { ref } from 'vue'
import FleetSidebar from '../components/FleetSidebar.vue'
import LogPane from '../components/LogPane.vue'
import VmDetail from '../components/VmDetail.vue'

const selected = ref<{ name: string; running: boolean } | null>(null)
</script>

<template>
  <div class="flex h-screen">
    <FleetSidebar @select="selected = $event" />
    <main class="flex flex-1 flex-col">
      <template v-if="selected">
        <VmDetail :name="selected.name" :running="selected.running" />
        <div class="p-2"><LogPane :name="selected.name" :running="selected.running" /></div>
      </template>
      <div v-else class="p-6 text-sm text-neutral-500">select a VM</div>
    </main>
  </div>
</template>
