<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue'
import { type Vm, vmStatus } from '../shared/api'
import { useFleet } from '../stores/fleet'
import { useUi } from '../stores/ui'

const store = useFleet()
const ui = useUi()
// `selected` stays for HomePage's own (pre-migration) selection state — see the
// `select` emit below. Row highlighting itself now reads `ui.selectedVm`.
defineProps<{ selected: string | null }>()
const emit = defineEmits<(e: 'select', name: string) => void>()

const short = (n: string) => (n.startsWith('mf-') ? n.slice(3) : n)

// Comp `meta()` (design source line 492) — label + dot styling per state. `error` and
// `suspended` aren't states the current backend reports (tart only ever says
// running/stopped — see macfleet/vm.py), but `Vm.state` is a plain string, so a mocked
// or future VM in either state renders correctly rather than falling through as unknown.
const STATUS_META: Record<string, { label: string; dotClass: string }> = {
  running: { label: 'Running', dotClass: 'bg-[var(--emerald)] shadow-[0_0_8px_var(--emerald)]' },
  booting: {
    label: 'Booting',
    dotClass: 'bg-[var(--amber)] animate-[mfpulse_1.4s_ease-in-out_infinite]',
  },
  creating: { label: 'Creating', dotClass: 'bg-[var(--amber)]' },
  suspended: { label: 'Suspended', dotClass: 'bg-[var(--violet)] opacity-[.55]' },
  stopped: { label: 'Stopped', dotClass: 'bg-[var(--idle)]' },
  error: { label: 'Unhealthy', dotClass: 'bg-[var(--red)]' },
}
function meta(status: string): { label: string; dotClass: string } {
  return STATUS_META[status] ?? { label: status, dotClass: 'bg-[var(--idle)]' }
}

// 'suspended'/'error' are carried straight through from `vm.state`; everything else
// (running/stopped, healthy vs not) goes through the shared `vmStatus` helper so this
// stays consistent with VmDetail's status badge.
function rowStatus(vm: Vm, creating: boolean): string {
  if (creating) return 'creating'
  if (vm.state === 'suspended' || vm.state === 'error') return vm.state
  return vmStatus(vm)
}

// Comp `fmtTtl` (design source line 723).
function fmtTtl(sec: number | undefined): string {
  if (sec == null) return ''
  const m = Math.floor(sec / 60)
  const ss = sec % 60
  return m > 0 ? `${m}m ${ss}s` : `${ss}s`
}

interface Row {
  key: string
  name: string
  status: string
  hasTtl: boolean
  ttlText: string
}

// Merge optimistic "creating" entries with the polled fleet so a new VM shows up the
// instant it's requested. A pending VM stays "creating" until it's actually running —
// including the brief window where it exists but is still stopped/cloning — so it never
// flickers to a grey "stopped" state mid-creation. TTL, when the VM was created with a
// lease, comes from `store.leases` (keyed by short name) and survives the pending ->
// running handoff since only `tickTtl` clears it.
const rows = computed<Row[]>(() => {
  const pending = new Set(store.pending)
  const real = store.vms.map((v) => {
    const name = short(v.name)
    const creating = pending.has(name) && v.state !== 'running'
    return {
      key: v.name,
      name,
      status: rowStatus(v, creating),
      hasTtl: name in store.leases,
      ttlText: fmtTtl(store.leases[name]),
    }
  })
  const realNames = new Set(real.map((r) => r.name))
  const onlyPending = store.pending
    .filter((n) => !realNames.has(n))
    .map((n) => ({
      key: `pending-${n}`,
      name: n,
      status: 'creating',
      hasTtl: n in store.leases,
      ttlText: fmtTtl(store.leases[n]),
    }))
  return [...onlyPending, ...real]
})

// Comp line 609 filters the fleet list with a plain lowercase `.includes`; the brief
// extends the same filter to snapshots (the comp itself never filters `snapsView`).
const filteredRows = computed(() => {
  const q = ui.search.trim().toLowerCase()
  return q ? rows.value.filter((r) => r.name.toLowerCase().includes(q)) : rows.value
})
const filteredSnaps = computed(() => {
  const q = ui.search.trim().toLowerCase()
  if (!q) return store.snapshots
  return store.snapshots.filter(
    (s) => s.label.toLowerCase().includes(q) || s.vm.toLowerCase().includes(q),
  )
})

function isActive(name: string, status: string): boolean {
  return ui.selectedVm === name && status !== 'creating'
}

function selectRow(name: string): void {
  ui.selectVm(name)
  // HomePage still owns its own `selected` ref and drives VmDetail/LogPane off it (it
  // migrates to `ui.selectedVm` directly in a later task) — keep emitting so that
  // continues to work.
  emit('select', name)
}

// Poll the fleet on an interval: this both survives the sidecar cold-start race and
// keeps health/state dots live (so a freshly-created VM turns green on its own). TTL
// countdown is driven the same way — the store never wires its own timer (see
// `tickTtl`'s comment in stores/fleet.ts) so a component has to call it periodically.
let refreshTimer: ReturnType<typeof setInterval> | null = null
let ttlTimer: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  store.refresh()
  refreshTimer = setInterval(store.refresh, 2000)
  ttlTimer = setInterval(store.tickTtl, 1000)
})
onUnmounted(() => {
  if (refreshTimer) clearInterval(refreshTimer)
  if (ttlTimer) clearInterval(ttlTimer)
})
</script>

<template>
  <aside
    class="flex w-[288px] shrink-0 flex-col border-r border-[var(--border)] bg-[var(--bg-elev)]"
  >
    <div class="min-h-0 flex-1 overflow-y-auto px-2.5 pt-3 pb-2">
      <div class="flex items-center justify-between px-1.5 pt-0.5 pb-2">
        <span
          class="text-[11px] font-semibold tracking-[.07em] text-[var(--text-faint)] uppercase"
          >Fleet</span
        >
        <span class="font-mono text-[11px] text-[var(--text-faint)]">{{ rows.length }}</span>
      </div>

      <p v-if="!store.loaded && store.error" class="px-2 py-2 text-xs text-[var(--text-faint)]">
        Connecting to engine…
      </p>
      <p v-else-if="!rows.length && store.error" class="px-2 py-2 text-xs text-[var(--red)]">
        {{ store.error }}
      </p>
      <p
        v-else-if="!rows.length"
        class="px-2 py-6 text-center text-xs text-[var(--text-faint)]"
      >
        No VMs running
      </p>
      <p
        v-else-if="!filteredRows.length"
        class="px-2 py-4 text-center text-xs text-[var(--text-faint)]"
      >
        No matches
      </p>

      <button
        v-for="row in filteredRows"
        :key="row.key"
        type="button"
        data-test="vm-row"
        :disabled="row.status === 'creating'"
        class="mb-0.5 flex w-full items-center gap-2.5 rounded-[9px] border px-[9px] py-2 text-left transition-colors"
        :class="[
          isActive(row.name, row.status)
            ? 'border-[var(--border-strong)] bg-[var(--bg-elev2)]'
            : 'border-transparent hover:bg-[var(--bg-hover)]',
          isActive(row.name, row.status) && row.status === 'running'
            ? 'animate-[mfglow_2.6s_ease-in-out_infinite]'
            : '',
        ]"
        @click="selectRow(row.name)"
      >
        <span class="h-[9px] w-[9px] shrink-0 rounded-full" :class="meta(row.status).dotClass" />
        <span class="min-w-0 flex-1 text-left">
          <span class="block truncate font-mono text-[12.5px] text-[var(--text)]">{{
            row.name
          }}</span>
          <span class="mt-px block text-[11px] text-[var(--text-faint)]">{{
            meta(row.status).label
          }}</span>
        </span>
        <span
          v-if="row.hasTtl"
          class="rounded-md bg-[var(--amber-soft)] px-1.5 py-0.5 font-mono text-[10.5px] whitespace-nowrap text-[var(--amber)] tabular-nums"
        >
          ⏱ {{ row.ttlText }}
        </span>
        <span
          v-if="row.status === 'creating'"
          class="h-[13px] w-[13px] shrink-0 rounded-full border-2 border-[var(--border-strong)] border-t-[var(--amber)] animate-[mfspin_0.7s_linear_infinite]"
        />
      </button>

      <div class="flex items-center justify-between px-1.5 pt-4 pb-2">
        <span
          class="text-[11px] font-semibold tracking-[.07em] text-[var(--text-faint)] uppercase"
          >Snapshots</span
        >
        <span class="font-mono text-[11px] text-[var(--text-faint)]">{{
          store.snapshots.length
        }}</span>
      </div>

      <div
        v-for="sn in filteredSnaps"
        :key="sn.id"
        data-test="snap-row"
        class="mb-1.5 flex items-center gap-2 rounded-[9px] border border-[var(--border)] bg-[var(--bg-elev2)] py-2 pr-2 pl-2.5"
      >
        <div class="min-w-0 flex-1">
          <div class="truncate font-mono text-xs text-[var(--text)]">◈ {{ sn.label }}</div>
          <div class="mt-0.5 font-mono text-[10.5px] text-[var(--text-faint)]">
            {{ sn.vm }} · {{ sn.size }} GB
          </div>
        </div>
        <button
          type="button"
          data-test="snap-new"
          title="New VM from this snapshot"
          class="h-[26px] shrink-0 rounded-[7px] bg-[var(--emerald-soft)] px-[9px] text-[11px] font-semibold whitespace-nowrap text-[var(--emerald)]"
          @click="store.newFromSnapshot(sn)"
        >
          ＋ VM
        </button>
      </div>
    </div>

    <div class="shrink-0 border-t border-[var(--border)] bg-[var(--bg-elev)] px-3 py-[11px]">
      <form data-test="up-form" class="flex gap-[7px]" @submit.prevent="store.create()">
        <input
          v-model="store.createOptions.name"
          data-test="up-name"
          placeholder="new-vm-name"
          class="h-[34px] min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2.5 font-mono text-[12.5px] text-[var(--text)] outline-none"
        />
        <button
          type="submit"
          data-test="up-btn"
          class="flex h-[34px] shrink-0 items-center gap-1.5 rounded-lg bg-[var(--emerald)] px-3.5 text-[12.5px] font-semibold text-[#04130d]"
        >
          ⚡ Spin up
        </button>
      </form>

      <div class="mt-2 flex items-center justify-between">
        <button
          type="button"
          data-test="create-advanced-toggle"
          class="flex items-center gap-[5px] py-0.5 text-[11.5px] text-[var(--text-dim)]"
          @click="store.createOptions.advancedOpen = !store.createOptions.advancedOpen"
        >
          {{ store.createOptions.advancedOpen ? '▾' : '▸' }} Advanced options
        </button>
        <span class="text-[11px] text-[var(--text-faint)]">resumes in ~2s</span>
      </div>

      <div
        v-if="store.createOptions.advancedOpen"
        class="mt-[9px] flex flex-col gap-[9px] animate-[mfin_0.14s_ease]"
      >
        <label class="flex flex-col gap-1">
          <span
            class="text-[10.5px] font-semibold tracking-[.05em] text-[var(--text-faint)] uppercase"
            >Source</span
          >
          <select
            v-model="store.createOptions.source"
            data-test="create-source"
            class="h-8 rounded-[7px] border border-[var(--border)] bg-[var(--bg)] px-2 font-mono text-xs text-[var(--text)]"
          >
            <option value="golden">Golden image (macOS 14.5)</option>
            <option v-for="sn in store.snapshots" :key="sn.id" :value="sn.id">
              Snapshot · {{ sn.label }}
            </option>
          </select>
        </label>
        <label class="flex flex-col gap-1">
          <span
            class="text-[10.5px] font-semibold tracking-[.05em] text-[var(--text-faint)] uppercase"
            >Resources</span
          >
          <select
            v-model="store.createOptions.preset"
            data-test="create-preset"
            class="h-8 rounded-[7px] border border-[var(--border)] bg-[var(--bg)] px-2 font-mono text-xs text-[var(--text)]"
          >
            <option value="light">Light · 2 vCPU · 4 GB</option>
            <option value="standard">Standard · 4 vCPU · 8 GB</option>
            <option value="heavy">Heavy · 8 vCPU · 16 GB</option>
          </select>
        </label>
        <label class="flex cursor-pointer items-center gap-2">
          <input
            v-model="store.createOptions.ttl"
            type="checkbox"
            data-test="create-ttl"
            class="h-[15px] w-[15px] accent-[var(--emerald)]"
          />
          <span class="text-xs text-[var(--text-dim)]"
            >Auto-delete after <span class="font-mono text-[var(--text)]">10m</span> (TTL
            lease)</span
          >
        </label>
      </div>
    </div>
  </aside>
</template>
