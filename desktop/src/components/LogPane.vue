<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { api } from '../shared/api'

const props = defineProps<{ name: string }>()
const text = ref('')
let timer: ReturnType<typeof setInterval> | null = null

async function poll() {
  try {
    text.value = (await api.logs(props.name)).lines
  } catch (e) {
    text.value = String(e)
  }
}
function start() {
  if (timer) clearInterval(timer)
  poll()
  timer = setInterval(poll, 2000)
}
watch(() => props.name, start, { immediate: true })
onBeforeUnmount(() => timer && clearInterval(timer))
</script>

<template>
  <pre class="h-40 overflow-auto rounded border border-neutral-800 bg-black/30 p-2 text-xs">{{ text }}</pre>
</template>
