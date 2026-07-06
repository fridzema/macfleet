<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import FleetSidebar from '../components/FleetSidebar.vue'
import LogPane from '../components/LogPane.vue'
import VmDetail from '../components/VmDetail.vue'
import { vmStatus } from '../shared/api'
import { useFleet } from '../stores/fleet'

const store = useFleet()
const selected = ref<string | null>(null)
const short = (n: string) => (n.startsWith('mf-') ? n.slice(3) : n)

// Resolve the selection against the live (polled) list so the detail pane tracks
// state changes — a booting VM starts streaming once healthy; a stopped one stops.
const selectedVm = computed(() => store.vms.find((v) => short(v.name) === selected.value) ?? null)
const running = computed(() => !!selectedVm.value && vmStatus(selectedVm.value) === 'running')

// Drop the selection if its VM disappears (nuked).
watch(
  () => store.vms,
  () => {
    if (selected.value && !selectedVm.value) selected.value = null
  },
)
</script>

<template>
  <div class="flex h-full">
    <FleetSidebar :selected="selected" @select="selected = $event" />
    <main class="flex min-w-0 flex-1 flex-col">
      <template v-if="selectedVm">
        <VmDetail
          :name="selected!"
          :running="running"
          :state="selectedVm.state"
          @close="selected = null"
        />
        <LogPane :name="selected!" :running="running" />
      </template>
      <div v-else class="grid flex-1 place-items-center px-6 text-center">
        <div class="space-y-1">
          <p class="text-sm text-zinc-500">
            {{ store.vms.length ? 'Select a VM to view it' : 'No VMs yet' }}
          </p>
          <p class="text-xs text-zinc-400 dark:text-zinc-600">
            {{ store.vms.length ? '' : 'Create one from the sidebar to get started.' }}
          </p>
        </div>
      </div>
    </main>
  </div>
</template>
