<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { api } from '../../shared/api'
import { useFleet } from '../../stores/fleet'

const props = defineProps<{ name: string }>()
const store = useFleet()

const short = (n: string) => (n.startsWith('mf-') ? n.slice(3) : n)

// Gate tailing on the tart-reported state (stable), same rationale as ScreenTab: logs
// come from the guest over SSH, only reachable while the VM runs.
const vm = computed(() => store.vms.find((v) => short(v.name) === props.name))
const active = computed(() => vm.value?.state === 'running')

// Comp line 714's color map — the real `api.logs` payload is a raw text blob (not
// structured {t, level, msg} records like the comp's mock data), so each line is
// parsed best-effort for one of these tokens; text before/after the token is rendered
// as-is (no fabricated timestamps), and a line with no token renders plain.
const LEVEL_COLORS: Record<string, string> = {
  ERR: '#f0555a',
  WARN: '#f5a623',
  OK: '#4ade80',
  INFO: '#5e9eff',
}

interface ParsedLine {
  prefix: string
  level: string | null
  color: string
  rest: string
}

function parseLine(raw: string): ParsedLine {
  const m = raw.match(/\b(ERR|WARN|OK|INFO)\b/)
  const level = m?.[1]
  if (!m || m.index === undefined || !level)
    return { prefix: '', level: null, color: '', rest: raw }
  // `level` is always one of LEVEL_COLORS' own keys here (the regex only captures those
  // 4 literals) — `noUncheckedIndexedAccess` just can't see that, so the `?? ''`
  // fallback can't actually be reached.
  /* istanbul ignore next */
  const color = LEVEL_COLORS[level] ?? ''
  return {
    prefix: raw.slice(0, m.index),
    level,
    color,
    rest: raw.slice(m.index + level.length),
  }
}

const text = ref('')
const paused = ref(false)
const logLines = computed(() =>
  text.value
    .split('\n')
    .filter((l) => l.length > 0)
    .map(parseLine),
)

let timer: ReturnType<typeof setInterval> | null = null

async function poll(): Promise<void> {
  if (paused.value || !active.value) return
  try {
    text.value = (await api.logs(props.name)).lines
  } catch (e) {
    text.value = String(e)
  }
}
function restart(): void {
  if (timer) clearInterval(timer)
  timer = null
  text.value = ''
  if (!active.value) return
  poll()
  timer = setInterval(poll, 2000)
}
watch(() => props.name, restart, { immediate: true })
watch(active, restart)
onBeforeUnmount(() => timer && clearInterval(timer))

function togglePause(): void {
  paused.value = !paused.value
}

const scrollEl = ref<HTMLElement | null>(null)
async function scrollToBottom(): Promise<void> {
  await nextTick()
  const el = scrollEl.value
  // Guards a post-unmount race: this `flush: 'post'` watcher's callback can already be
  // queued when the component unmounts, in which case `el` is null by the time this
  // resumes after `nextTick()` — see the "post-unmount" test in LogsTab.test.ts.
  if (el) el.scrollTop = el.scrollHeight
}
watch(logLines, scrollToBottom, { flush: 'post' })
</script>

<template>
  <div class="mx-auto flex h-full max-w-[920px] flex-col">
    <div class="mb-2.5 flex items-center justify-between">
      <div class="flex items-center gap-2 text-xs text-[var(--text-dim)]">
        <span class="h-[7px] w-[7px] rounded-full bg-[var(--emerald)] animate-[mfdot_1.4s_infinite]" />
        tailing
        <span class="font-mono text-[var(--text)]">/var/log/guest.log</span>
      </div>
      <button
        type="button"
        data-test="pause-btn"
        class="flex h-[30px] items-center gap-[5px] rounded-lg border border-[var(--border)] bg-[var(--bg-elev2)] px-[11px] text-xs text-[var(--text-dim)]"
        @click="togglePause"
      >
        {{ paused ? '▶ Resume' : '⏸ Pause' }}
      </button>
    </div>
    <div
      ref="scrollEl"
      data-test="logscroll"
      class="min-h-0 flex-1 overflow-auto rounded-[11px] border border-[var(--border)] bg-black px-[15px] py-3 font-mono text-[11.5px] leading-[1.7]"
    >
      <div v-if="!active" data-test="not-running" class="text-[#6c6c76]">VM not running</div>
      <div v-else-if="logLines.length === 0" class="text-[#6c6c76]">waiting for logs…</div>
      <template v-else>
        <div v-for="(ln, i) in logLines" :key="i" data-test="log-line" class="flex gap-2.5">
          <span v-if="ln.prefix" class="shrink-0 text-[#4a5568]">{{ ln.prefix }}</span>
          <span
            v-if="ln.level"
            data-test="log-level"
            class="w-11 shrink-0"
            :style="{ color: ln.color }"
            >{{ ln.level }}</span
          >
          <span class="whitespace-pre-wrap text-[#cbd5e0]">{{ ln.rest }}</span>
        </div>
      </template>
    </div>
  </div>
</template>
