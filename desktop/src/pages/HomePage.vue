<script setup lang="ts">
import { computed, watch } from 'vue'
import BulkPanel from '../components/BulkPanel.vue'
import FleetSidebar from '../components/FleetSidebar.vue'
import VmDetail from '../components/VmDetail.vue'
import VmProvisioning from '../components/VmProvisioning.vue'
import { useFleet } from '../stores/fleet'
import { useUi } from '../stores/ui'

const store = useFleet()
const ui = useUi()
const short = (n: string) => (n.startsWith('mf-') ? n.slice(3) : n)

// Resolve the selection against the live (polled) list so the detail pane tracks
// state changes — a booting VM starts streaming once healthy; a stopped one stops.
const selectedVm = computed(() => store.vms.find((v) => short(v.name) === ui.selectedVm) ?? null)

// Provisioning record for the current selection, if the engine is still spinning it up.
const provision = computed(() =>
  ui.selectedVm ? (store.provisioning[ui.selectedVm] ?? null) : null,
)

// Show the provisioning stepper (instead of the detail pane) while a just-created VM isn't ready
// yet. "Ready" = the engine marked the record done, or — before any record lands — the VM is
// already healthy. Scoped to just-created VMs (a live record, or a still-pending name) so
// selecting an already-booting existing VM opens VmDetail, not the stepper.
const showProvisioning = computed(() => {
  const name = ui.selectedVm
  if (!name) return false
  const justCreated = provision.value !== null || store.pending.includes(name)
  if (!justCreated) return false
  const ready = provision.value ? provision.value.done : (selectedVm.value?.healthy ?? false)
  return !ready
})

// Drop the selection if its VM disappears (nuked) — but keep it while the VM is still being
// created (pending / has a provisioning record), where it legitimately isn't in the list yet.
watch(
  () => store.vms,
  () => {
    if (
      ui.selectedVm &&
      !selectedVm.value &&
      !store.pending.includes(ui.selectedVm) &&
      !(ui.selectedVm in store.provisioning)
    ) {
      ui.selectVm(null)
    }
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
      <!-- Until the engine's first successful list, gate the entire pane on a booting state so no
           create/spin-up action is reachable against an unstarted sidecar. -->
      <div
        v-if="!store.loaded"
        data-test="engine-booting"
        class="flex flex-1 flex-col items-center justify-center gap-4 text-[var(--text-faint)]"
      >
        <div
          class="h-[30px] w-[30px] rounded-full border-[3px] border-[var(--border-strong)] border-t-[var(--amber)] animate-[mfspin_.8s_linear_infinite]"
        />
        <div class="text-[15px] font-[550] text-[var(--text-dim)]">Starting engine…</div>
        <div class="max-w-[280px] text-center text-[12.5px]">
          Booting the macfleet engine — this only takes a couple of seconds.
        </div>
        <div
          v-if="store.error"
          data-test="engine-startup-error"
          class="max-w-[420px] rounded-lg border border-[var(--red)]/40 bg-[var(--red)]/10 px-3 py-2 text-center font-mono text-[11px] text-[var(--red)]"
        >
          {{ store.error }}
        </div>
        <button
          v-if="store.error"
          type="button"
          data-test="engine-retry"
          class="h-[30px] rounded-lg border border-[var(--border)] bg-[var(--bg-elev2)] px-3 text-xs text-[var(--text-dim)]"
          @click="store.refresh()"
        >
          Retry connection
        </button>
      </div>
      <template v-else>
      <BulkPanel v-if="ui.selectionCount >= 2" />
      <VmProvisioning v-else-if="showProvisioning" :key="ui.selectedVm!" :name="ui.selectedVm!" />
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
      </template>
    </main>
  </div>
</template>
