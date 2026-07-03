<script setup lang="ts">
import { ref } from 'vue'
import FleetSidebar from '../components/FleetSidebar.vue'
import VmDetail from '../components/VmDetail.vue'
import LogPane from '../components/LogPane.vue'

const selected = ref<string | null>(null)
</script>

<template>
  <div class="flex h-screen">
    <FleetSidebar @select="selected = $event" />
    <main class="flex flex-1 flex-col">
      <template v-if="selected">
        <VmDetail :name="selected" />
        <div class="p-2"><LogPane :name="selected" /></div>
      </template>
      <div v-else class="p-6 text-sm text-neutral-500">select a VM</div>
    </main>
  </div>
</template>
