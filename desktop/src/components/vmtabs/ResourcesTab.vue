<script setup lang="ts">
import { useDocumentVisibility } from '@vueuse/core'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { api, type Metrics } from '../../shared/api'
import { useFleet } from '../../stores/fleet'

const props = defineProps<{ name: string }>()
const store = useFleet()

const short = (n: string) => (n.startsWith('mf-') ? n.slice(3) : n)

// Same raw-state gating as the other tabs (ScreenTab/LogsTab): today the backend only
// ever reports 'running' or 'stopped' (see FleetSidebar's `rowStatus` comment), so
// "not stopped" already covers running + booting. Unknown (VM not found yet) defaults
// to locked — the safe direction, since editing during an ambiguous state risks a 409.
const vm = computed(() => store.vms.find((v) => short(v.name) === props.name))
const stopped = computed(() => vm.value?.state === 'stopped')
const locked = computed(() => !stopped.value)

const resources = computed(() => store.resources[props.name])

watch(
  () => props.name,
  (name) => {
    if (!store.resources[name]) store.fetchResources(name)
  },
  { immediate: true },
)

// Live CPU/memory only exist while the guest is actually up — gated on the raw state
// (not the coarser `locked` above, which also covers booting/suspended). Mirrors
// ScreenTab/LogsTab's poll: restart on VM switch, clear on unmount, never fabricate a
// number when it isn't running or the fetch fails.
const active = computed(() => vm.value?.state === 'running')
const visibility = useDocumentVisibility()
const pollActive = computed(() => active.value && visibility.value === 'visible')
const metrics = ref<Metrics | null>(null)
let timer: ReturnType<typeof setInterval> | null = null
// Bumped on every restart() so a poll() in flight when the VM is switched (or flips to
// stopped) can tell its response is stale once the await resolves, and skip the write —
// otherwise a late response for the OLD vm/state could land after the new poll cycle
// has already started, overwriting the new card's numbers or reviving a stopped VM's bar.
let generation = 0
// A metrics fetch is a guest round-trip that can outlast the 3s interval under load; guard so
// the interval doesn't stack overlapping requests (mirrors ScreenTab/LogsTab).
let inFlight = false

async function poll(): Promise<void> {
  if (!pollActive.value || inFlight) return
  inFlight = true
  const myGen = generation
  const name = props.name
  try {
    const result = await api.metrics(name).catch(() => null)
    if (myGen !== generation || !active.value || props.name !== name) return
    metrics.value = result
  } finally {
    inFlight = false
  }
}
function restart(): void {
  generation++
  // Abandon any in-flight request's slot: its response is now stale (generation bumped) and
  // must not block the fresh poll below for the newly-selected VM.
  inFlight = false
  if (timer) clearInterval(timer)
  timer = null
  metrics.value = null
  if (!pollActive.value) return
  poll()
  timer = setInterval(poll, 3000)
}
watch(() => props.name, restart, { immediate: true })
watch(active, restart)
watch(visibility, restart)
onBeforeUnmount(() => timer && clearInterval(timer))

const cpuBarWidth = computed(() => (metrics.value ? `${metrics.value.cpu_pct}%` : '100%'))
const cpuCaption = computed(() => (metrics.value ? `${metrics.value.cpu_pct}% load` : 'configured'))
const memBarWidth = computed(() => {
  const m = metrics.value
  if (!m || m.mem_total_mb <= 0) return '100%'
  return `${(m.mem_used_mb / m.mem_total_mb) * 100}%`
})
const memCaption = computed(() => {
  const m = metrics.value
  if (!m) return 'configured'
  return `${Math.round(m.mem_used_mb / 1024)} / ${Math.round(m.mem_total_mb / 1024)} GB used`
})

// Local edit buffer, reset from the fetched/refetched resources whenever they change
// (including right after a successful save, once the store re-fetches).
const cpu = ref(0)
const memoryGb = ref(0)
const disk = ref(0)
const display = ref('')
watch(
  resources,
  (r) => {
    if (!r) return
    cpu.value = r.cpu
    memoryGb.value = Math.round(r.memory_mb / 1024)
    disk.value = r.disk_gb
    display.value = r.display
  },
  { immediate: true },
)

// Disk is grow-only — snap any attempt to shrink straight back to the current size
// rather than merely hinting via the input's `min` (which HTML doesn't enforce on its
// own; nothing stops a lower value from being typed in).
watch(disk, (v) => {
  const min = resources.value?.disk_gb
  if (min != null && v < min) disk.value = min
})

function save(): void {
  const r = resources.value
  // The save button (template, `v-if="!locked"` inside `v-else` for `!resources`) only
  // ever renders once `resources` is loaded, so this can't actually be reached — it's a
  // type narrowing guard for `resources.value`'s `Resources | undefined` type, not a
  // real runtime possibility.
  /* istanbul ignore if */
  if (!r) return
  const patch: Parameters<typeof store.setResources>[1] = {}
  if (cpu.value !== r.cpu) patch.cpu = cpu.value
  // Diff in GB (the unit the user actually edits) — NOT reconstructed MB. `memory_mb`
  // from `tart get` isn't guaranteed to be a clean multiple of 1024 (e.g. 6000), so
  // comparing `memoryGb*1024` against it would flag an untouched field as changed and
  // silently rewrite memory the user never touched.
  if (memoryGb.value !== Math.round(r.memory_mb / 1024)) patch.memory = memoryGb.value * 1024
  if (disk.value > r.disk_gb) patch.disk_size = disk.value
  if (display.value !== r.display) patch.display = display.value
  if (Object.keys(patch).length === 0) return
  store.setResources(props.name, patch)
}
</script>

<template>
  <div class="mx-auto max-w-[720px]">
    <div
      v-if="locked"
      data-test="locked-banner"
      class="mb-4 flex items-center gap-[9px] rounded-[9px] bg-[var(--amber-soft)] px-[13px] py-2.5 text-[12.5px] text-[var(--amber)]"
    >
      ⚠ Stop the VM to change vCPU, RAM or display. Disk can only grow, and only while stopped.
    </div>
    <div
      v-else
      data-test="editable-banner"
      class="mb-4 flex items-center gap-[9px] rounded-[9px] bg-[var(--emerald-soft)] px-[13px] py-2.5 text-[12.5px] text-[var(--emerald)]"
    >
      ✎ VM is stopped — resources are editable. Disk can only grow.
    </div>

    <div v-if="!resources" class="text-sm text-[var(--text-faint)]">Loading resources…</div>
    <template v-else>
      <div class="grid grid-cols-2 gap-3">
        <div data-test="card-cpu" class="rounded-xl border border-[var(--border)] bg-[var(--bg-elev)] p-4">
          <div class="text-[11px] font-semibold tracking-[.05em] text-[var(--text-faint)] uppercase">
            CPU
          </div>
          <div class="mt-1.5 font-mono text-[26px] font-semibold [font-variant-numeric:tabular-nums]">
            {{ resources.cpu }} <span class="text-[13px] text-[var(--text-faint)]">vCPU</span>
          </div>
          <div class="mt-3 h-1.5 overflow-hidden rounded bg-[var(--bg)]">
            <div
              data-test="cpu-bar"
              class="h-full w-full rounded bg-[var(--emerald)]"
              :style="{ width: cpuBarWidth }"
            />
          </div>
          <div class="mt-1.5 font-mono text-[11px] text-[var(--text-faint)]">{{ cpuCaption }}</div>
          <input
            v-if="!locked"
            v-model.number="cpu"
            type="number"
            min="1"
            data-test="cpu-input"
            class="mt-3 h-[30px] w-full rounded-lg border border-[var(--border)] bg-[var(--bg-elev2)] px-2 font-mono text-[12.5px] text-[var(--text)] outline-none"
          />
        </div>

        <div data-test="card-memory" class="rounded-xl border border-[var(--border)] bg-[var(--bg-elev)] p-4">
          <div class="text-[11px] font-semibold tracking-[.05em] text-[var(--text-faint)] uppercase">
            Memory
          </div>
          <div class="mt-1.5 font-mono text-[26px] font-semibold [font-variant-numeric:tabular-nums]">
            {{ Math.round(resources.memory_mb / 1024) }}
            <span class="text-[13px] text-[var(--text-faint)]">GB</span>
          </div>
          <div class="mt-3 h-1.5 overflow-hidden rounded bg-[var(--bg)]">
            <div
              data-test="memory-bar"
              class="h-full w-full rounded bg-[var(--emerald)]"
              :style="{ width: memBarWidth }"
            />
          </div>
          <div class="mt-1.5 font-mono text-[11px] text-[var(--text-faint)]">{{ memCaption }}</div>
          <input
            v-if="!locked"
            v-model.number="memoryGb"
            type="number"
            min="1"
            data-test="memory-input"
            class="mt-3 h-[30px] w-full rounded-lg border border-[var(--border)] bg-[var(--bg-elev2)] px-2 font-mono text-[12.5px] text-[var(--text)] outline-none"
          />
        </div>

        <div data-test="card-disk" class="rounded-xl border border-[var(--border)] bg-[var(--bg-elev)] p-4">
          <div class="text-[11px] font-semibold tracking-[.05em] text-[var(--text-faint)] uppercase">
            Disk
          </div>
          <div class="mt-1.5 font-mono text-[26px] font-semibold [font-variant-numeric:tabular-nums]">
            {{ resources.disk_gb }} <span class="text-[13px] text-[var(--text-faint)]">GB</span>
          </div>
          <div class="mt-3 h-1.5 overflow-hidden rounded bg-[var(--bg)]">
            <div class="h-full w-full rounded bg-[var(--violet)]" />
          </div>
          <div class="mt-1.5 font-mono text-[11px] text-[var(--text-faint)]">configured</div>
          <template v-if="!locked">
            <input
              v-model.number="disk"
              type="number"
              :min="resources.disk_gb"
              data-test="disk-input"
              class="mt-3 h-[30px] w-full rounded-lg border border-[var(--border)] bg-[var(--bg-elev2)] px-2 font-mono text-[12.5px] text-[var(--text)] outline-none"
            />
            <div class="mt-1 text-[10.5px] text-[var(--text-faint)]">grow-only, min {{ resources.disk_gb }} GB</div>
          </template>
        </div>

        <div data-test="card-display" class="rounded-xl border border-[var(--border)] bg-[var(--bg-elev)] p-4">
          <div class="text-[11px] font-semibold tracking-[.05em] text-[var(--text-faint)] uppercase">
            Display
          </div>
          <div class="mt-1.5 font-mono text-[26px] font-semibold [font-variant-numeric:tabular-nums]">
            {{ resources.display }}
          </div>
          <div class="mt-[26px] font-mono text-[11px] text-[var(--text-faint)]">configured</div>
          <input
            v-if="!locked"
            v-model="display"
            type="text"
            data-test="display-input"
            class="mt-3 h-[30px] w-full rounded-lg border border-[var(--border)] bg-[var(--bg-elev2)] px-2 font-mono text-[12.5px] text-[var(--text)] outline-none"
          />
        </div>
      </div>

      <div v-if="!locked" class="mt-4 flex justify-end">
        <button
          type="button"
          data-test="save-btn"
          class="flex h-[30px] items-center gap-[5px] rounded-lg bg-[var(--emerald)] px-[13px] text-xs font-semibold text-[#04130d]"
          @click="save"
        >
          Save changes
        </button>
      </div>
    </template>
  </div>
</template>
