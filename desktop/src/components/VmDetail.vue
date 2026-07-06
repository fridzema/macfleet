<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { api } from '../shared/api'

const props = defineProps<{ name: string; running: boolean }>()

const shot = ref<string | null>(null)
const paused = ref(false)
const typed = ref('')
const err = ref<string | null>(null)
let timer: ReturnType<typeof setInterval> | null = null

async function poll() {
  if (paused.value) return
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
  // Only running+healthy VMs serve screenshots; skip polling otherwise.
  if (!props.running) {
    shot.value = null
    return
  }
  poll()
  timer = setInterval(poll, 750)
}
function stop() {
  if (timer) clearInterval(timer)
  timer = null
}

watch(() => [props.name, props.running], start, { immediate: true })
onBeforeUnmount(stop)

// Control actions can fail (409 when control is disabled or the VM isn't ready).
// Surface it on `err` instead of letting it reject into Vue's error handler.
async function onImgClick(ev: MouseEvent) {
  const el = ev.target as HTMLImageElement
  const rect = el.getBoundingClientRect()
  const sx = el.naturalWidth / rect.width
  const sy = el.naturalHeight / rect.height
  const x = Math.round((ev.clientX - rect.left) * sx)
  const y = Math.round((ev.clientY - rect.top) * sy)
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
</script>

<template>
  <section class="flex flex-1 flex-col gap-2 p-2 text-sm">
    <div class="flex items-center gap-2">
      <strong>{{ name }}</strong>
      <button class="rounded border border-neutral-700 px-2 py-0.5" @click="paused = !paused">
        {{ paused ? 'resume' : 'pause' }}
      </button>
      <span v-if="err" class="text-red-400">{{ err }}</span>
    </div>
    <img
      v-if="shot"
      data-test="shot"
      :src="shot"
      class="max-w-full cursor-crosshair rounded border border-neutral-800"
      @click="onImgClick"
    />
    <div v-else class="rounded border border-dashed border-neutral-700 p-6 text-neutral-500">
      no screenshot (control disabled or VM not ready)
    </div>
    <form class="flex gap-2" @submit.prevent="sendType">
      <input
        v-model="typed"
        :disabled="!running"
        :placeholder="running ? 'type into VM…' : 'VM not running'"
        class="flex-1 rounded border border-neutral-700 bg-transparent px-2 py-1 disabled:opacity-50"
      />
      <button
        :disabled="!running"
        class="rounded border border-neutral-700 px-2 py-1 disabled:opacity-50"
        type="submit"
      >
        send
      </button>
    </form>
  </section>
</template>
