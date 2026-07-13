<script setup lang="ts">
import { useDocumentVisibility } from '@vueuse/core'
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { api } from '../../shared/api'
import { useFleet } from '../../stores/fleet'

const props = defineProps<{ name: string }>()
const store = useFleet()

const short = (n: string) => (n.startsWith('mf-') ? n.slice(3) : n)

// Logs come from the guest over SSH, which — like the computer-server — only answers
// once macOS has finished cold-booting (~30-60s after tart reports `running`). Gate
// tailing on a sticky `everHealthy` (same rationale as ScreenTab): don't poll a
// still-booting guest, and surface a distinct "booting" hint rather than "not running".
const vm = computed(() => store.vms.find((v) => short(v.name) === props.name))
const everHealthy = ref(false)
watch(
  () => vm.value?.healthy === true,
  (h) => {
    if (h) everHealthy.value = true
  },
)
const booting = computed(() => vm.value?.state === 'running' && !everHealthy.value)
const active = computed(() => vm.value?.state === 'running' && everHealthy.value)
const visibility = useDocumentVisibility()
const pollActive = computed(() => active.value && visibility.value === 'visible')

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
// A log tail is an SSH round-trip that can outlast the 2s interval on a loaded guest; without
// this guard the interval stacks overlapping requests (same failure ScreenTab guards). Skip a
// tick while one is in flight.
let inFlight = false
// Bumped on every restart() so a poll() resolving after the VM was switched (or went inactive)
// can tell its response is stale and skip the write, instead of painting the old VM's logs.
let generation = 0
let cursor: number | undefined

async function poll(): Promise<void> {
  if (paused.value || !pollActive.value || inFlight) return
  inFlight = true
  const myGen = generation
  const name = props.name
  try {
    const chunk = cursor === undefined ? await api.logs(name) : await api.logs(name, 100, cursor)
    if (myGen !== generation || props.name !== name) return
    text.value = cursor === undefined || chunk.reset ? chunk.lines : text.value + chunk.lines
    cursor = chunk.cursor
  } catch (e) {
    if (myGen !== generation || props.name !== name) return
    text.value = String(e)
  } finally {
    inFlight = false
  }
}
function restart(): void {
  generation++
  // Abandon any in-flight request's slot: its response is now stale (generation bumped) and
  // must not block the fresh poll below for the newly-selected VM.
  inFlight = false
  if (timer) clearInterval(timer)
  timer = null
  text.value = ''
  cursor = undefined
  if (!pollActive.value) return
  poll()
  timer = setInterval(poll, 2000)
}
watch(
  () => props.name,
  () => {
    everHealthy.value = vm.value?.healthy === true
    restart()
  },
  { immediate: true },
)
watch(active, restart)
watch(visibility, restart)
onBeforeUnmount(() => timer && clearInterval(timer))

function togglePause(): void {
  paused.value = !paused.value
  if (!paused.value) poll()
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
      <div v-if="booting" data-test="booting" class="text-[#6c6c76]">
        waiting for the guest to finish booting…
      </div>
      <div v-else-if="!active" data-test="not-running" class="text-[#6c6c76]">VM not running</div>
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
