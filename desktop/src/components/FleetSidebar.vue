<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { type Vm, vmStatus } from '../shared/api'
import { useFleet } from '../stores/fleet'

const store = useFleet()
defineProps<{ selected: string | null }>()
const emit = defineEmits<(e: 'select', name: string) => void>()

const short = (n: string) => (n.startsWith('mf-') ? n.slice(3) : n)

const DOT: Record<string, string> = {
  running: 'bg-emerald-500',
  booting: 'bg-amber-400 animate-pulse',
  stopped: 'bg-zinc-400 dark:bg-zinc-600',
}

// Poll the fleet on an interval: this both survives the sidecar cold-start race and
// keeps health/state dots live (so a freshly-created VM turns green on its own).
let timer: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  store.refresh()
  timer = setInterval(store.refresh, 2000)
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
})

const newName = ref('')
const creating = ref(false)
async function create() {
  const n = newName.value.trim()
  if (!n || creating.value) return
  creating.value = true
  await store.up(n)
  creating.value = false
  newName.value = ''
}
</script>

<template>
  <aside
    class="flex w-60 shrink-0 flex-col border-r border-zinc-200 bg-zinc-100/40 dark:border-zinc-800 dark:bg-zinc-900/40"
  >
    <div
      class="flex items-center justify-between px-3 py-2 text-xs font-medium tracking-wide text-zinc-500 uppercase"
    >
      <span>Fleet</span>
      <span v-if="store.vms.length" class="tabular-nums">{{ store.vms.length }}</span>
    </div>

    <div class="min-h-0 flex-1 overflow-y-auto px-2">
      <!-- connecting / error / empty states -->
      <p v-if="!store.loaded && store.error" class="px-2 py-2 text-xs text-zinc-500">
        Connecting to engine…
      </p>
      <p v-else-if="store.error" class="px-2 py-2 text-xs text-red-500">{{ store.error }}</p>
      <p v-else-if="!store.vms.length" class="px-2 py-6 text-center text-xs text-zinc-400 dark:text-zinc-600">
        No VMs running
      </p>

      <button
        v-for="vm in store.vms"
        :key="vm.name"
        data-test="vm-row"
        class="group flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors"
        :class="
          selected === short(vm.name)
            ? 'bg-white shadow-sm ring-1 ring-zinc-200 dark:bg-zinc-800 dark:ring-zinc-700'
            : 'hover:bg-white/60 dark:hover:bg-zinc-800/50'
        "
        @click="emit('select', short(vm.name))"
      >
        <span class="size-2 shrink-0 rounded-full" :class="DOT[vmStatus(vm)]" />
        <span class="flex-1 truncate font-mono">{{ short(vm.name) }}</span>
        <span class="text-[11px] text-zinc-400 tabular-nums dark:text-zinc-500">
          {{ vmStatus(vm as Vm) }}
        </span>
      </button>
    </div>

    <form
      data-test="up-form"
      class="flex gap-1.5 border-t border-zinc-200 p-2 dark:border-zinc-800"
      @submit.prevent="create"
    >
      <input
        v-model="newName"
        data-test="up-name"
        placeholder="new VM name…"
        :disabled="creating"
        class="min-w-0 flex-1 rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm placeholder:text-zinc-400 focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 focus:outline-none disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900"
      />
      <button
        data-test="up-btn"
        type="submit"
        :disabled="creating || !newName.trim()"
        class="rounded-md bg-emerald-500 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {{ creating ? '…' : 'up' }}
      </button>
    </form>
  </aside>
</template>
