<script setup lang="ts">
import { useDocumentVisibility } from '@vueuse/core'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useToasts } from '../../composables/useToasts'
import { api } from '../../shared/api'
import { useFleet } from '../../stores/fleet'

const props = defineProps<{ name: string }>()
const store = useFleet()
const { add: toast } = useToasts()

const short = (n: string) => (n.startsWith('mf-') ? n.slice(3) : n)

// The tart-reported raw state — `running`/`stopped` today, with `booting`/`suspended`/
// `error` carried straight through should the backend ever report them (see
// FleetSidebar's `rowStatus` comment) — folded together with the optimistic `creating`
// state (a `store.pending` entry that hasn't landed as `running` yet), same as the
// sidebar row.
const vm = computed(() => store.vms.find((v) => short(v.name) === props.name))
const rawState = computed(() => {
  if (store.pending.includes(props.name) && vm.value?.state !== 'running') return 'creating'
  return vm.value?.state ?? 'stopped'
})

// A fresh VM is tart-`running` within seconds but macOS keeps cold-booting for ~30-60s
// before the in-guest server answers. `everHealthy` goes sticky-true the first time the
// guest passes a health check: BEFORE that we treat a running VM as still booting (show
// the overlay, don't hammer the unreachable guest with a screenshot every second); AFTER
// that we keep polling on the stable raw state, since the health flag flaps under load
// (the health check competes with screenshots on the guest) and would blank the frame.
const everHealthy = ref(false)
watch(
  () => vm.value?.healthy === true,
  (h) => {
    if (h) everHealthy.value = true
  },
)

const active = computed(() => rawState.value === 'running' && everHealthy.value)
const visibility = useDocumentVisibility()
const streamActive = computed(() => active.value && visibility.value === 'visible')
// A running-but-never-yet-healthy VM surfaces as `booting` so OVERLAY.booting renders.
const displayState = computed(() =>
  rawState.value === 'running' && !everHealthy.value ? 'booting' : rawState.value,
)

// PNG frames are commonly 2–3MB. They now travel as binary blobs; keep a one-fps idle rate to
// bound capture cost, then temporarily boost after interaction for responsive visual feedback.
const SCREEN_POLL_MS = 1000
const INTERACTIVE_POLL_MS = 250
const INTERACTIVE_WINDOW_MS = 4000

const shot = ref<string | null>(null)
const paused = ref(false)
const typed = ref('')
const lastTyped = ref('')
const showTyped = ref(false)
let timer: ReturnType<typeof setInterval> | null = null
let typedTimer: ReturnType<typeof setTimeout> | null = null
// Bumped on every restart() so a poll() in flight when the VM is switched (or flips to
// stopped) can tell its response is stale once the await resolves, and skip the write —
// otherwise a late screenshot for the OLD vm could paint over the newly-selected one, and
// a click on that stale frame would be sent to the current (different) VM.
let generation = 0
// A screenshot is a 2-3MB PNG the guest serves serially; on a loaded guest one can take
// longer than the 1s poll. Without this guard the interval would stack overlapping
// requests, starving the guest's /status healthcheck (which flaps the VM to "booting")
// and compounding load. Skip a tick while one is still in flight.
let inFlight = false
let boostUntil = 0

function revokeShot(): void {
  if (shot.value?.startsWith('blob:')) URL.revokeObjectURL(shot.value)
  shot.value = null
}

function schedule(): void {
  if (timer) clearTimeout(timer)
  timer = null
  if (!streamActive.value || paused.value) return
  const delay = Date.now() < boostUntil ? INTERACTIVE_POLL_MS : SCREEN_POLL_MS
  timer = setTimeout(poll, delay)
}

async function poll() {
  if (paused.value || !streamActive.value || inFlight) return
  inFlight = true
  const myGen = generation
  const name = props.name
  try {
    const png = await api.screenshot(name)
    if (myGen !== generation || !streamActive.value || props.name !== name) return
    // The object branch is a rolling-upgrade fallback for an older engine that still returns
    // base64 JSON; current engines always take the zero-copy Blob path.
    const legacy = png as Blob & { png_b64?: string }
    const next = legacy.png_b64
      ? `data:image/png;base64,${legacy.png_b64}`
      : URL.createObjectURL(png)
    if (shot.value?.startsWith('blob:')) URL.revokeObjectURL(shot.value)
    shot.value = next
  } catch {
    // Transient failure (guest still settling, screenshot busy, etc.) — keep the last
    // good frame rather than blanking the screen on every miss.
  } finally {
    inFlight = false
    schedule()
  }
}

function restart() {
  generation++
  if (timer) clearTimeout(timer)
  timer = null
  if (!streamActive.value) {
    if (!active.value) revokeShot()
    return
  }
  poll()
}

// Fresh VM selected: drop the old frame immediately. State toggles (stable) just
// start/stop without a blanking flash.
watch(
  () => props.name,
  () => {
    // Re-arm the booting gate for the newly-selected VM (a switch to a still-booting
    // VM must not inherit the previous VM's ever-healthy state).
    everHealthy.value = vm.value?.healthy === true
    revokeShot()
    restart()
  },
  { immediate: true },
)
watch(active, restart)
watch(visibility, restart)
onBeforeUnmount(() => {
  if (timer) clearTimeout(timer)
  if (typedTimer) clearTimeout(typedTimer)
  revokeShot()
})

async function onImgClick(ev: MouseEvent) {
  const el = ev.currentTarget as HTMLImageElement
  const rect = el.getBoundingClientRect()
  const nW = el.naturalWidth
  const nH = el.naturalHeight
  if (!nW || !nH) return
  // The frame is a fixed 16:10 box, but the screenshot renders with `object-contain`: when the
  // guest's aspect ratio differs it is scaled to fit and letterboxed (bars) inside the element.
  // Map the click against the ACTUAL rendered-image box, not the element box — otherwise every
  // click lands off by the letterbox offset (the old bug). The guest's click space IS the
  // screenshot's pixel space (see the engine's agent.py display_width/height_px), so the mapped
  // coordinate is exactly a screenshot pixel.
  const scale = Math.min(rect.width / nW, rect.height / nH)
  const originX = rect.left + (rect.width - nW * scale) / 2
  const originY = rect.top + (rect.height - nH * scale) / 2
  const x = Math.round((ev.clientX - originX) / scale)
  const y = Math.round((ev.clientY - originY) / scale)
  if (x < 0 || y < 0 || x >= nW || y >= nH) return // click on a letterbox bar — ignore
  try {
    boostUntil = Date.now() + INTERACTIVE_WINDOW_MS
    await api.click(props.name, x, y)
    schedule()
    toast(`click → ${x}, ${y}`, '☉')
  } catch {
    toast('Click failed', '⚠')
  }
}

async function sendType() {
  const text = typed.value.trim()
  if (!active.value || !text) return
  try {
    boostUntil = Date.now() + INTERACTIVE_WINDOW_MS
    await api.typeText(props.name, text)
    schedule()
    typed.value = ''
    lastTyped.value = text
    showTyped.value = true
    if (typedTimer) clearTimeout(typedTimer)
    typedTimer = setTimeout(() => {
      showTyped.value = false
    }, 2200)
    toast('Sent keystrokes', '⌨')
  } catch {
    toast('Failed to send keystrokes', '⚠')
  }
}

function togglePause(): void {
  paused.value = !paused.value
  if (!paused.value) poll()
  else if (timer) clearTimeout(timer)
}

const frameEl = ref<HTMLElement | null>(null)
async function fullscreen(): Promise<void> {
  const el = frameEl.value
  if (!el?.requestFullscreen) {
    toast('Fullscreen not available', '⛶')
    return
  }
  try {
    await el.requestFullscreen()
  } catch {
    toast('Fullscreen failed', '⛶')
  }
}

// Comp state→message map (design source lines 682–689). `resumable` states surface a
// Resume action (`store.resume`); `spin` states show the loading ring.
const OVERLAY: Record<string, { msg: string; sub: string; resumable: boolean; spin: boolean }> = {
  booting: {
    msg: 'Booting — waiting for guest',
    sub: 'The guest agent will connect once macOS finishes booting.',
    resumable: false,
    spin: true,
  },
  creating: {
    msg: 'Creating VM…',
    sub: 'Cloning from source. This takes a couple of seconds.',
    resumable: false,
    spin: true,
  },
  stopped: {
    msg: 'Stopped',
    sub: 'This VM is powered off. Resume it to see the screen.',
    resumable: true,
    spin: false,
  },
  suspended: {
    msg: 'Suspended',
    sub: 'State is frozen on disk. Resume to continue where you left off (~2s).',
    resumable: true,
    spin: false,
  },
  error: {
    msg: 'Unhealthy — control disabled',
    sub: 'The guest failed a healthcheck. Check the logs, then restart or delete.',
    resumable: false,
    spin: false,
  },
}
const overlay = computed(
  () =>
    OVERLAY[displayState.value] ?? {
      msg: 'Stopped',
      sub: 'This VM is powered off. Resume it to see the screen.',
      resumable: true,
      spin: false,
    },
)
</script>

<template>
  <div class="mx-auto max-w-[920px]">
    <div
      ref="frameEl"
      data-test="screen-frame"
      class="relative aspect-[16/10] w-full overflow-hidden rounded-[14px] border border-[var(--border-strong)] shadow-[var(--shadow)]"
      :class="active ? 'cursor-crosshair' : 'cursor-default'"
    >
      <template v-if="active">
        <img
          v-if="shot"
          data-test="shot"
          :src="shot"
          draggable="false"
          class="absolute inset-0 h-full w-full bg-[var(--bg-elev)] object-contain select-none"
          @click="onImgClick"
        />
        <div
          v-else
          class="absolute inset-0 flex items-center justify-center bg-[var(--bg-elev)] text-sm text-[var(--text-faint)]"
        >
          Connecting…
        </div>
        <div
          v-if="showTyped"
          class="absolute top-[44%] left-1/2 -translate-x-1/2 animate-[mfin_.12s_ease] rounded-[9px] border border-white/20 bg-black/70 px-3.5 py-2 font-mono text-[13px] text-white"
        >
          ⌨ {{ lastTyped }}
        </div>
      </template>
      <div
        v-else
        data-test="overlay"
        class="absolute inset-0 flex flex-col items-center justify-center gap-3.5 bg-[var(--bg-elev)] text-[var(--text-dim)]"
      >
        <div
          v-if="overlay.spin"
          class="h-[30px] w-[30px] rounded-full border-[3px] border-[var(--border-strong)] border-t-[var(--amber)] animate-[mfspin_.8s_linear_infinite]"
        />
        <div data-test="overlay-msg" class="text-sm font-[550] text-[var(--text)]">
          {{ overlay.msg }}
        </div>
        <div
          data-test="overlay-sub"
          class="max-w-[320px] text-center text-[12.5px] text-[var(--text-faint)]"
        >
          {{ overlay.sub }}
        </div>
        <button
          v-if="overlay.resumable"
          type="button"
          data-test="resume-btn"
          class="flex h-[30px] items-center gap-[5px] rounded-lg bg-[var(--emerald)] px-[13px] text-xs font-semibold text-[#04130d]"
          @click="store.resume(name)"
        >
          ▶ Resume
        </button>
      </div>
    </div>

    <div class="mt-3 flex items-center gap-[9px]">
      <input
        v-model="typed"
        :disabled="!active"
        data-test="type-input"
        placeholder="Type into VM — text is sent as keystrokes…"
        class="h-9 min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--bg-elev)] px-3 font-mono text-[12.5px] text-[var(--text)] outline-none disabled:opacity-50"
        @keydown.enter="sendType"
      />
      <button
        type="button"
        :disabled="!active"
        data-test="send-btn"
        class="flex h-[30px] items-center gap-[5px] rounded-lg border border-[var(--border)] bg-[var(--bg-elev2)] px-[11px] text-xs text-[var(--text-dim)] disabled:opacity-50"
        @click="sendType"
      >
        ⏎ Send
      </button>
      <button
        type="button"
        title="Pause stream"
        data-test="pause-btn"
        class="flex h-[30px] items-center gap-[5px] rounded-lg border border-[var(--border)] bg-[var(--bg-elev2)] px-[11px] text-xs text-[var(--text-dim)]"
        @click="togglePause"
      >
        {{ paused ? '▶ Resume' : '⏸ Pause' }}
      </button>
      <button
        type="button"
        title="Fullscreen"
        data-test="fullscreen-btn"
        class="flex h-[30px] items-center gap-[5px] rounded-lg border border-[var(--border)] bg-[var(--bg-elev2)] px-[11px] text-xs text-[var(--text-dim)]"
        @click="fullscreen"
      >
        ⛶
      </button>
    </div>
    <div class="mt-[9px] text-[11.5px] text-[var(--text-faint)]">
      Click anywhere on the screen to move &amp; click the VM cursor. No SSH keys needed —
      control runs through the guest agent.
    </div>
  </div>
</template>
