<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { Share } from '../../shared/api'
import { useFleet } from '../../stores/fleet'

const props = defineProps<{ name: string }>()
const store = useFleet()
const short = (n: string) => (n.startsWith('mf-') ? n.slice(3) : n)

const list = computed<Share[]>(() => store.shares[props.name] ?? [])
const vm = computed(() => store.vms.find((v) => short(v.name) === props.name))
const running = computed(() => vm.value?.state === 'running')
const newPath = ref('')

watch(
  () => props.name,
  (name) => store.fetchShares(name),
  { immediate: true },
)

function basename(p: string): string {
  return p.replace(/\/+$/, '').split('/').pop() || 'share'
}
function save(next: Share[]): void {
  store.setShares(props.name, next)
}
function add(): void {
  const path = newPath.value.trim()
  if (!path) return
  save([...list.value, { tag: basename(path), host_path: path, read_only: true }])
  newPath.value = ''
}
function remove(tag: string): void {
  save(list.value.filter((s) => s.tag !== tag))
}
function toggleRo(tag: string): void {
  save(list.value.map((s) => (s.tag === tag ? { ...s, read_only: !s.read_only } : s)))
}
async function browse(): Promise<void> {
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const p = await open({ directory: true })
    if (typeof p === 'string') newPath.value = p
  }
}
</script>

<template>
  <div class="mx-auto flex max-w-[640px] flex-col gap-3">
    <div
      v-if="running"
      data-test="folders-restart-banner"
      class="flex items-center justify-between rounded-lg border border-[var(--border)] bg-[var(--bg-elev2)] px-3 py-2 text-[12px] text-[var(--text-dim)]"
    >
      <span>Shared-folder changes apply on the VM's next start.</span>
      <button
        type="button"
        data-test="folders-restart"
        class="h-7 rounded-md bg-[var(--emerald)] px-2.5 text-[11px] font-semibold text-[#04130d]"
        @click="store.restart(name)"
      >
        ↻ Restart
      </button>
    </div>

    <div v-if="!list.length" class="text-[12.5px] text-[var(--text-faint)]">
      No shared folders. Add a host directory to mount it into the guest.
    </div>
    <div
      v-for="s in list"
      :key="s.tag"
      data-test="folders-share-row"
      class="flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--bg-elev2)] px-3 py-2"
    >
      <div class="min-w-0 flex-1">
        <div class="truncate font-mono text-[12.5px] text-[var(--text)]">{{ s.tag }}</div>
        <div class="truncate font-mono text-[11px] text-[var(--text-faint)]">{{ s.host_path }}</div>
        <div class="font-mono text-[11px] text-[var(--text-faint)]">
          guest: /Volumes/My Shared Files/{{ s.tag }}
        </div>
      </div>
      <button
        type="button"
        class="h-7 rounded-md border border-[var(--border)] px-2 text-[11px] text-[var(--text-dim)]"
        @click="toggleRo(s.tag)"
      >
        {{ s.read_only ? 'read-only' : 'read-write' }}
      </button>
      <button
        type="button"
        data-test="folders-remove"
        class="h-7 rounded-md border border-[var(--border)] px-2 text-[11px] text-[var(--red)]"
        @click="remove(s.tag)"
      >
        Remove
      </button>
    </div>

    <div class="flex gap-2">
      <input
        v-model="newPath"
        data-test="folders-add-path"
        placeholder="/Users/you/project"
        class="h-9 min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2.5 font-mono text-[12px] text-[var(--text)] outline-none"
      />
      <button
        type="button"
        data-test="folders-browse"
        class="h-9 rounded-lg border border-[var(--border)] px-3 text-xs text-[var(--text-dim)]"
        @click="browse"
      >
        Browse…
      </button>
      <button
        type="button"
        data-test="folders-add"
        class="h-9 rounded-lg bg-[var(--emerald)] px-3 text-xs font-semibold text-[#04130d]"
        @click="add"
      >
        Add
      </button>
    </div>
    <div class="text-[11px] text-[var(--text-faint)]">
      Folders are read-only by default. Read-write lets guest (agent-driven) code modify host
      files — grant it deliberately.
    </div>
  </div>
</template>
