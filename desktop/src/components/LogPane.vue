<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { api } from '../shared/api'

const props = defineProps<{ name: string; running: boolean }>()
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
  timer = null
  // Logs come from the guest over SSH; only reachable when the VM is running.
  if (!props.running) {
    text.value = ''
    return
  }
  poll()
  timer = setInterval(poll, 2000)
}
watch(() => [props.name, props.running], start, { immediate: true })
onBeforeUnmount(() => timer && clearInterval(timer))
</script>

<template>
  <pre class="h-40 overflow-auto rounded border border-neutral-800 bg-black/30 p-2 text-xs">{{ text }}</pre>
</template>
