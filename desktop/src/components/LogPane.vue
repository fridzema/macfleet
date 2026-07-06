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
  text.value = ''
  // Logs come from the guest over SSH; only reachable while the VM runs.
  if (!props.running) return
  poll()
  timer = setInterval(poll, 2000)
}
watch(() => [props.name, props.running], start, { immediate: true })
onBeforeUnmount(() => timer && clearInterval(timer))
</script>

<template>
  <section class="shrink-0 border-t border-zinc-200 dark:border-zinc-800">
    <div class="px-4 pt-2 text-xs font-medium tracking-wide text-zinc-500 uppercase">Logs</div>
    <pre
      class="mx-4 mt-1 mb-4 h-32 overflow-auto rounded-md border border-zinc-200 bg-zinc-100/50 p-2.5 font-mono text-xs leading-relaxed text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-400"
    >{{ running ? text || 'waiting for logs…' : 'VM not running' }}</pre>
  </section>
</template>
