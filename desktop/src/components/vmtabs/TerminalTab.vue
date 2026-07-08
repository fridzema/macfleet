<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useFleet } from '../../stores/fleet'

const props = defineProps<{ name: string }>()
const store = useFleet()

const input = ref('')
const scrollEl = ref<HTMLElement | null>(null)

const history = computed(() => store.terminalHistory[props.name] ?? [])

// `code: null` (exec call itself failed) renders the same red as a nonzero guest exit —
// both are failures — but with distinct "exec failed" text instead of an exit number
// (see the template) so a network error is never mistaken for a guest exit code.
function codeClass(code: number | null): string {
  return code === 0 ? 'text-[var(--emerald)]' : 'text-[var(--red)]'
}

async function scrollToBottom(): Promise<void> {
  await nextTick()
  const el = scrollEl.value
  if (el) el.scrollTop = el.scrollHeight
}
watch(history, scrollToBottom, { flush: 'post' })
watch(() => props.name, scrollToBottom, { immediate: true })

async function run(): Promise<void> {
  const cmd = input.value.trim()
  if (!cmd) return
  input.value = ''
  await store.execCommand(props.name, cmd)
}
function onKey(e: KeyboardEvent): void {
  if (e.key === 'Enter') run()
}
</script>

<template>
  <div class="mx-auto flex h-full max-w-[920px] flex-col">
    <div
      ref="scrollEl"
      data-test="scrollback"
      class="min-h-0 flex-1 overflow-auto rounded-[11px] border border-[var(--border)] bg-[var(--bg-elev)] px-4 py-3.5 font-mono text-[12.5px] leading-[1.65]"
    >
      <div class="text-[var(--text-faint)]">macfleet guest-agent · in-guest shell · {{ name }}</div>
      <div v-for="(ln, i) in history" :key="i" data-test="term-entry" class="mt-[9px]">
        <div>
          <span class="text-[var(--emerald)]">admin@{{ name }}</span>
          <span class="text-[var(--text-faint)]"> ~ % </span>
          <span class="text-[var(--text)]">{{ ln.cmd }}</span>
        </div>
        <div class="mt-0.5 whitespace-pre-wrap text-[var(--text-dim)]">{{ ln.out }}</div>
        <div class="mt-0.5 text-[11px]" :class="codeClass(ln.code)" data-test="term-code">
          {{ ln.code === null ? 'exec failed' : `exit ${ln.code}` }}
        </div>
      </div>
    </div>
    <div class="mt-[11px] flex items-center gap-[9px]">
      <span class="font-mono text-[12.5px] text-[var(--emerald)]">admin@{{ name }} ~ %</span>
      <input
        v-model="input"
        data-test="term-input"
        placeholder="run a command…"
        class="h-[34px] min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--bg-elev)] px-2.5 font-mono text-[12.5px] text-[var(--text)] outline-none"
        @keydown="onKey"
      />
      <button
        type="button"
        data-test="run-btn"
        class="flex h-[30px] items-center gap-[5px] rounded-lg bg-[var(--emerald)] px-[13px] text-xs font-semibold text-[#04130d]"
        @click="run"
      >
        Run
      </button>
    </div>
  </div>
</template>
