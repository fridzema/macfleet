<script setup lang="ts">
import { type Component, computed, nextTick, ref, watch } from 'vue'
import { vmStatus } from '../shared/api'
import { type Tab, useFleet } from '../stores/fleet'
import { useUi } from '../stores/ui'
import ConnectTab from './vmtabs/ConnectTab.vue'
import LogsTab from './vmtabs/LogsTab.vue'
import ResourcesTab from './vmtabs/ResourcesTab.vue'
import ScreenTab from './vmtabs/ScreenTab.vue'
import TerminalTab from './vmtabs/TerminalTab.vue'

const props = defineProps<{ name: string; state: string; healthy: boolean }>()
const store = useFleet()
const ui = useUi()

// 'suspended'/'error' aren't states the current backend reports (see FleetSidebar's
// `rowStatus` comment) but are carried straight through from `state`; everything else
// goes through the shared `vmStatus` helper, same as the sidebar row.
const status = computed(() => {
  if (props.state === 'suspended' || props.state === 'error') return props.state
  return vmStatus({ state: props.state, healthy: props.healthy })
})

// Comp `meta()` (design source line 492) plus the header's larger dot/badge treatment
// (lines 662–666).
const STATUS_META: Record<string, { label: string; dotClass: string; badgeClass: string }> = {
  running: {
    label: 'Running',
    dotClass: 'bg-[var(--emerald)] shadow-[0_0_10px_var(--emerald)]',
    badgeClass: 'text-[var(--emerald)] bg-[color-mix(in_oklch,var(--emerald)_14%,transparent)]',
  },
  booting: {
    label: 'Booting',
    dotClass: 'bg-[var(--amber)] animate-[mfpulse_1.4s_ease-in-out_infinite]',
    badgeClass: 'text-[var(--amber)] bg-[color-mix(in_oklch,var(--amber)_14%,transparent)]',
  },
  suspended: {
    label: 'Suspended',
    dotClass: 'bg-[var(--violet)] opacity-[.55]',
    badgeClass: 'text-[var(--violet)] bg-[color-mix(in_oklch,var(--violet)_14%,transparent)]',
  },
  stopped: {
    label: 'Stopped',
    dotClass: 'bg-[var(--idle)]',
    badgeClass: 'text-[var(--idle)] bg-[color-mix(in_oklch,var(--idle)_14%,transparent)]',
  },
  error: {
    label: 'Unhealthy',
    dotClass: 'bg-[var(--red)]',
    badgeClass: 'text-[var(--red)] bg-[color-mix(in_oklch,var(--red)_14%,transparent)]',
  },
}
const statusMeta = computed(
  () =>
    STATUS_META[status.value] ?? {
      label: status.value,
      dotClass: 'bg-[var(--idle)]',
      badgeClass: 'text-[var(--idle)] bg-[color-mix(in_oklch,var(--idle)_14%,transparent)]',
    },
)

// Resource chips (vCPU/RAM/disk): fetched into the fleet store's `resources` cache so
// the Resources tab (Task 11) can reuse the same data instead of a second round trip.
watch(
  () => props.name,
  (name) => store.fetchResources(name),
  { immediate: true },
)
const resources = computed(() => store.resources[props.name])

// Defense-in-depth against a wrong-VM rename/delete. `ui.renaming`/`ui.confirmDeleteVm`
// are global flags: `ui.selectVm` resets them on every selection change, and HomePage
// keys this component to `selectedVm` so it remounts fresh — but if this instance is
// ever reused for a different VM via a bare `name` swap, an armed confirm on the old VM
// must not carry over to the new one. NOT immediate: a palette arm-then-mount (which
// sets the flag *before* this instance exists) must survive its first render.
watch(
  () => props.name,
  () => {
    ui.cancelRename()
    ui.cancelDeleteVm()
  },
)

const TABS: { id: Tab; label: string }[] = [
  { id: 'screen', label: 'Screen' },
  { id: 'terminal', label: 'Terminal' },
  { id: 'logs', label: 'Logs' },
  { id: 'resources', label: 'Resources' },
  { id: 'connect', label: 'Connect' },
]
const TAB_COMPONENTS: Record<Tab, Component> = {
  screen: ScreenTab,
  terminal: TerminalTab,
  logs: LogsTab,
  resources: ResourcesTab,
  connect: ConnectTab,
}
const activeTab = computed(() => TAB_COMPONENTS[store.selectedTab])

const suspendLabel = computed(() => (props.state === 'running' ? '⏸ Suspend' : '▶ Resume'))
function suspendResume(): void {
  if (props.state === 'running') store.suspend(props.name)
  else store.resume(props.name)
}
function snapshot(): void {
  store.snapshotVM(props.name, `${props.name}-snap`)
}
function duplicate(): void {
  store.duplicate(props.name)
}
function connect(): void {
  store.selectedTab = 'connect'
}

// Inline rename (comp `startRename`/`commitRename`, lines 577–578) — the palette only
// arms `ui.renaming`; committing/cancelling happens here.
const renameInput = ref<HTMLInputElement | null>(null)
watch(
  () => ui.renaming,
  async (renaming) => {
    if (!renaming) return
    await nextTick()
    renameInput.value?.focus()
    renameInput.value?.select()
  },
)
function commitRename(): void {
  const next = ui.renameValue.trim().replace(/\s+/g, '-')
  if (next) store.rename(props.name, next)
  ui.cancelRename()
}
function onRenameKey(e: KeyboardEvent): void {
  if (e.key === 'Enter') commitRename()
  if (e.key === 'Escape') ui.cancelRename()
}

// Two-step delete confirm (comp `askDelete`/`doDelete`, lines 223–232/579–580) — the
// palette only arms `ui.confirmDeleteVm`; the actual delete happens here.
function confirmDelete(): void {
  store.nuke(props.name)
  ui.cancelDeleteVm()
}
</script>

<template>
  <section class="flex min-h-0 flex-1 flex-col">
    <header
      class="flex flex-wrap items-center gap-3 border-b border-[var(--border)] px-[18px] py-[14px]"
    >
      <div class="flex min-w-0 items-center gap-[11px]">
        <span class="h-[11px] w-[11px] shrink-0 rounded-full" :class="statusMeta.dotClass" />
        <input
          v-if="ui.renaming"
          ref="renameInput"
          v-model="ui.renameValue"
          data-test="rename-input"
          class="w-[220px] rounded-[7px] border border-[var(--emerald)] bg-[var(--bg-elev2)] px-2 py-[3px] font-mono text-[16px] font-semibold text-[var(--text)] outline-none"
          @keydown="onRenameKey"
        />
        <div
          v-else
          title="Click to rename"
          data-test="rename-display"
          class="cursor-text font-mono text-[16px] font-semibold tracking-[-0.01em] text-[var(--text)]"
          @click="ui.startRename(name)"
        >
          {{ name }}
        </div>
        <span
          data-test="status-badge"
          class="inline-flex h-[22px] items-center rounded-[7px] px-[9px] text-[11px] font-semibold"
          :class="statusMeta.badgeClass"
        >
          {{ statusMeta.label }}
        </span>
      </div>

      <div class="flex gap-[6px] font-mono text-[11px] text-[var(--text-dim)]">
        <span
          data-test="chip-cpu"
          class="rounded-md border border-[var(--border)] bg-[var(--bg-elev2)] px-2 py-[3px]"
          >{{ resources?.cpu ?? '—' }} vCPU</span
        >
        <span
          data-test="chip-ram"
          class="rounded-md border border-[var(--border)] bg-[var(--bg-elev2)] px-2 py-[3px]"
          >{{ resources ? Math.round(resources.memory_mb / 1024) : '—' }} GB</span
        >
        <span
          data-test="chip-disk"
          class="rounded-md border border-[var(--border)] bg-[var(--bg-elev2)] px-2 py-[3px]"
          >{{ resources?.disk_gb ?? '—' }} GB</span
        >
      </div>

      <div class="flex-1" />

      <div class="flex items-center gap-[6px]">
        <button
          type="button"
          data-test="suspend-resume-btn"
          class="flex h-[30px] items-center gap-[5px] rounded-lg border border-[var(--border)] bg-[var(--bg-elev2)] px-[11px] text-xs text-[var(--text-dim)]"
          @click="suspendResume"
        >
          {{ suspendLabel }}
        </button>
        <button
          type="button"
          data-test="snapshot-btn"
          class="flex h-[30px] items-center gap-[5px] rounded-lg border border-[var(--border)] bg-[var(--bg-elev2)] px-[11px] text-xs text-[var(--text-dim)]"
          @click="snapshot"
        >
          ◈ Snapshot
        </button>
        <button
          type="button"
          data-test="duplicate-btn"
          class="flex h-[30px] items-center gap-[5px] rounded-lg border border-[var(--border)] bg-[var(--bg-elev2)] px-[11px] text-xs text-[var(--text-dim)]"
          @click="duplicate"
        >
          ⧉ Duplicate
        </button>
        <button
          type="button"
          data-test="connect-btn"
          class="flex h-[30px] items-center gap-[5px] rounded-lg bg-[var(--emerald)] px-[13px] text-xs font-semibold text-[#04130d]"
          @click="connect"
        >
          ↔ Connect
        </button>
        <button
          v-if="!ui.confirmDeleteVm"
          type="button"
          title="Delete"
          data-test="delete-btn"
          class="flex h-[30px] w-[30px] items-center justify-center rounded-lg bg-[var(--red-soft)] text-[13px] text-[var(--red)]"
          @click="ui.askDeleteVm(name)"
        >
          🗑
        </button>
        <div
          v-else
          class="flex h-[30px] items-center gap-[5px] rounded-lg bg-[var(--red-soft)] py-0 pr-1 pl-[10px]"
        >
          <span class="text-[11.5px] font-medium text-[var(--red)]">Delete?</span>
          <button
            type="button"
            data-test="delete-yes"
            class="h-[22px] rounded-md bg-[var(--red)] px-[9px] text-[11px] font-semibold text-white"
            @click="confirmDelete"
          >
            Yes
          </button>
          <button
            type="button"
            data-test="delete-no"
            class="h-[22px] rounded-md px-2 text-[11px] text-[var(--text-dim)]"
            @click="ui.cancelDeleteVm()"
          >
            No
          </button>
        </div>
      </div>
    </header>

    <div class="flex gap-0.5 border-b border-[var(--border)] px-[14px]">
      <button
        v-for="tab in TABS"
        :key="tab.id"
        type="button"
        :data-test="`tab-${tab.id}`"
        class="-mb-px h-[38px] border-b-2 px-[13px] text-[12.5px]"
        :class="
          store.selectedTab === tab.id
            ? 'border-[var(--emerald)] font-semibold text-[var(--text)]'
            : 'border-transparent font-medium text-[var(--text-faint)]'
        "
        @click="store.selectedTab = tab.id"
      >
        {{ tab.label }}
      </button>
    </div>

    <div class="min-h-0 flex-1 overflow-auto p-[18px]">
      <component :is="activeTab" :name="name" />
    </div>
  </section>
</template>
