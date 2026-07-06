<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { api, vmStatus } from '../shared/api'
import { useFleet } from '../stores/fleet'

const props = defineProps<{ name: string; running: boolean; state: string }>()
const emit = defineEmits<(e: 'close') => void>()
const store = useFleet()

const shot = ref<string | null>(null)
const paused = ref(false)
const typed = ref('')
const err = ref<string | null>(null)
const armNuke = ref(false)
let timer: ReturnType<typeof setInterval> | null = null

const status = computed(() => vmStatus({ state: props.state, healthy: props.running }))
const BADGE: Record<string, string> = {
  running: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  booting: 'bg-amber-400/10 text-amber-600 dark:text-amber-400',
  stopped: 'bg-zinc-500/10 text-zinc-500',
}

async function poll() {
  if (paused.value || !props.running) return
  try {
    const { png_b64 } = await api.screenshot(props.name)
    shot.value = `data:image/png;base64,${png_b64}`
    err.value = null
  } catch (e) {
    err.value = String(e)
  }
}

function start() {
  stop()
  shot.value = null
  if (!props.running) return
  poll()
  // 1s balances live feel against the ~2-3MB PNG per frame. Gated on the VM running
  // and the `pause` toggle; no visibility gate so it never silently blanks.
  timer = setInterval(poll, 1000)
}
function stop() {
  if (timer) clearInterval(timer)
  timer = null
}

watch(() => [props.name, props.running], start, { immediate: true })
onBeforeUnmount(stop)

// Control actions can 409 (control disabled / VM not ready); surface on `err`.
async function onImgClick(ev: MouseEvent) {
  const el = ev.target as HTMLImageElement
  const rect = el.getBoundingClientRect()
  const x = Math.round(((ev.clientX - rect.left) * el.naturalWidth) / rect.width)
  const y = Math.round(((ev.clientY - rect.top) * el.naturalHeight) / rect.height)
  try {
    await api.click(props.name, x, y)
    err.value = null
  } catch (e) {
    err.value = String(e)
  }
}

async function sendType() {
  if (!props.running || !typed.value) return
  try {
    await api.typeText(props.name, typed.value)
    typed.value = ''
    err.value = null
  } catch (e) {
    err.value = String(e)
  }
}

function stopVm() {
  store.down(props.name)
}
function nukeVm() {
  // Two-click guard — deleting a VM is irreversible and there's no dialog.
  if (!armNuke.value) {
    armNuke.value = true
    return
  }
  armNuke.value = false
  store.nuke(props.name)
  emit('close')
}
</script>

<template>
  <section class="flex min-h-0 flex-1 flex-col gap-3 p-4">
    <header class="flex items-center gap-2.5">
      <h2 class="font-mono text-sm font-semibold">{{ name }}</h2>
      <span class="rounded px-1.5 py-0.5 text-[11px] font-medium" :class="BADGE[status]">
        {{ status }}
      </span>
      <span v-if="err" class="truncate text-xs text-red-500">{{ err }}</span>

      <div class="ml-auto flex items-center gap-1.5">
        <button
          v-if="running"
          class="rounded-md border border-zinc-300 px-2 py-1 text-xs text-zinc-600 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          @click="paused = !paused"
        >
          {{ paused ? 'resume' : 'pause' }}
        </button>
        <button
          v-if="state === 'running'"
          class="rounded-md border border-zinc-300 px-2 py-1 text-xs text-zinc-600 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          @click="stopVm"
        >
          stop
        </button>
        <button
          class="rounded-md border px-2 py-1 text-xs transition-colors"
          :class="
            armNuke
              ? 'border-red-500 bg-red-500 text-white'
              : 'border-zinc-300 text-red-600 hover:bg-red-50 dark:border-zinc-700 dark:text-red-400 dark:hover:bg-red-950/40'
          "
          @click="nukeVm"
          @blur="armNuke = false"
        >
          {{ armNuke ? 'confirm delete' : 'delete' }}
        </button>
      </div>
    </header>

    <div
      class="grid min-h-0 flex-1 place-items-center overflow-hidden rounded-lg border border-zinc-200 bg-zinc-100/50 dark:border-zinc-800 dark:bg-zinc-900/50"
    >
      <img
        v-if="shot"
        data-test="shot"
        :src="shot"
        class="max-h-full max-w-full cursor-crosshair object-contain"
        @click="onImgClick"
      />
      <div v-else class="flex flex-col items-center gap-2 p-8 text-center text-sm text-zinc-400 dark:text-zinc-600">
        <span
          v-if="status === 'booting'"
          class="size-4 animate-spin rounded-full border-2 border-amber-400 border-t-transparent"
        />
        <p v-if="status === 'booting'">Booting — waiting for the guest…</p>
        <p v-else-if="status === 'stopped'">VM is stopped</p>
        <p v-else>No screenshot (control disabled)</p>
      </div>
    </div>

    <form class="flex gap-1.5" @submit.prevent="sendType">
      <input
        v-model="typed"
        :disabled="!running"
        :placeholder="running ? 'type into the VM…' : 'VM not running'"
        class="min-w-0 flex-1 rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-sm placeholder:text-zinc-400 focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 focus:outline-none disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900"
      />
      <button
        type="submit"
        :disabled="!running"
        class="rounded-md border border-zinc-300 px-3 py-1.5 text-sm transition-colors hover:bg-zinc-100 disabled:opacity-40 dark:border-zinc-700 dark:hover:bg-zinc-800"
      >
        send
      </button>
    </form>
  </section>
</template>
