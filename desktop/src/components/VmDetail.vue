<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { api } from '../shared/api'

const props = defineProps<{ name: string }>()

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
  poll()
  timer = setInterval(poll, 750)
}
function stop() {
  if (timer) clearInterval(timer)
  timer = null
}

watch(() => props.name, start, { immediate: true })
onBeforeUnmount(stop)

async function onImgClick(ev: MouseEvent) {
  const el = ev.target as HTMLImageElement
  const rect = el.getBoundingClientRect()
  const sx = el.naturalWidth / rect.width
  const sy = el.naturalHeight / rect.height
  const x = Math.round((ev.clientX - rect.left) * sx)
  const y = Math.round((ev.clientY - rect.top) * sy)
  await api.click(props.name, x, y)
}

async function sendType() {
  if (typed.value) {
    await api.typeText(props.name, typed.value)
    typed.value = ''
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
        placeholder="type into VM…"
        class="flex-1 rounded border border-neutral-700 bg-transparent px-2 py-1"
      />
      <button class="rounded border border-neutral-700 px-2 py-1" type="submit">send</button>
    </form>
  </section>
</template>
