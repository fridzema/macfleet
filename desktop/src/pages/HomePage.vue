<script setup lang="ts">
import { computed, watch } from 'vue'
import BulkPanel from '../components/BulkPanel.vue'
import FleetSidebar from '../components/FleetSidebar.vue'
import VmDetail from '../components/VmDetail.vue'
import { useFleet } from '../stores/fleet'
import { useUi } from '../stores/ui'

const store = useFleet()
const ui = useUi()
const short = (n: string) => (n.startsWith('mf-') ? n.slice(3) : n)

// Resolve the selection against the live (polled) list so the detail pane tracks
// state changes — a booting VM starts streaming once healthy; a stopped one stops.
const selectedVm = computed(() => store.vms.find((v) => short(v.name) === ui.selectedVm) ?? null)

// Drop the selection if its VM disappears (nuked).
watch(
  () => store.vms,
  () => {
    if (ui.selectedVm && !selectedVm.value) ui.selectVm(null)
  },
)

const fleetTotallyEmpty = computed(() => store.vms.length === 0)
// Comp `emptyTitle`/`emptySub` (design source lines 658–659).
const emptyTitle = computed(() =>
  fleetTotallyEmpty.value ? 'No VMs yet' : 'Select a VM to view it',
)
const emptySub = computed(() =>
  fleetTotallyEmpty.value
    ? 'Spin one up to get started — clones from the golden image in a couple of seconds.'
    : 'Pick a machine from the fleet on the left.',
)
</script>

<template>
  <div class="flex h-full">
    <FleetSidebar />
    <main class="flex min-w-0 flex-1 flex-col">
      <BulkPanel v-if="ui.selectionCount >= 2" />
      <VmDetail
        v-else-if="selectedVm"
        :key="ui.selectedVm!"
        :name="ui.selectedVm!"
        :state="selectedVm.state"
        :healthy="selectedVm.healthy"
      />
      <div
        v-else
        class="flex flex-1 flex-col items-center justify-center gap-4 text-[var(--text-faint)]"
      >
        <div
          class="flex h-[52px] w-[52px] items-center justify-center rounded-[13px] border border-[var(--border-strong)] text-[22px] opacity-70"
        >
          ◱
        </div>
        <div class="text-[15px] font-[550] text-[var(--text-dim)]">{{ emptyTitle }}</div>
        <div class="max-w-[280px] text-center text-[12.5px]">{{ emptySub }}</div>
        <button
          v-if="fleetTotallyEmpty"
          type="button"
          data-test="empty-create"
          class="flex h-[30px] items-center gap-[5px] rounded-lg bg-[var(--emerald)] px-[13px] text-xs font-semibold text-[#04130d]"
          @click="store.create()"
        >
          ⚡ Spin up your first VM
        </button>
      </div>
    </main>
  </div>
</template>
