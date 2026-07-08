<script setup lang="ts">
import { computed, ref, watch } from 'vue'
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
            <div class="h-full w-full rounded bg-[var(--emerald)]" />
          </div>
          <div class="mt-1.5 font-mono text-[11px] text-[var(--text-faint)]">configured</div>
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
            <div class="h-full w-full rounded bg-[var(--emerald)]" />
          </div>
          <div class="mt-1.5 font-mono text-[11px] text-[var(--text-faint)]">configured</div>
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
