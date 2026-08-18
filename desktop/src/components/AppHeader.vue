<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useDarkMode } from '../composables/useDarkMode'
import { useHotkeys } from '../composables/useHotkeys'
import { useFleet } from '../stores/fleet'
import { useSettings } from '../stores/settings'
import { useUi } from '../stores/ui'
import AgentIndicator from './AgentIndicator.vue'

const fleet = useFleet()
const ui = useUi()
const router = useRouter()
const { isDark, toggleDark } = useDarkMode()

const themeIcon = computed(() => (isDark.value ? '☾' : '☀'))

// Comp line 80 sums per-VM RAM. `list_vms` now carries `memory_mb` (Task 9), so show the
// real Σ used / host total once at least one running VM reports it. Suspended VMs have
// freed their RAM, so they're excluded from both the running count and the sum — only
// 'stopped' isn't "running" here (there's no separate 'booting' state on the wire).
const runningVms = computed(() => fleet.vms.filter((v) => v.state === 'running'))
const runningCount = computed(() => runningVms.value.length)
const usedGb = computed(() => {
  const total = runningVms.value.reduce((sum, v) => sum + (v.memory_mb ?? 0), 0)
  return Math.round(total / 1024)
})
const hasMemoryData = computed(() => runningVms.value.some((v) => v.memory_mb != null))
const capacityLabel = computed(() => {
  const running = `${runningCount.value} running`
  if (!fleet.host) return running
  if (hasMemoryData.value) return `${usedGb.value} / ${fleet.host.total_mem_gb} GB`
  return `${running} · ${fleet.host.total_mem_gb} GB`
})

useHotkeys(
  () => ui.openPalette(),
  () => router.push('/settings'),
)

onMounted(() => {
  fleet.fetchHost()
  // The create form's default size comes from the engine; fetch it before the user can pick.
  useSettings().load()
})
</script>

<template>
  <header
    class="relative z-[5] flex h-[52px] shrink-0 items-center gap-3.5 border-b border-[var(--border)] bg-[var(--bg-elev)] px-3.5"
  >
    <button
      type="button"
      title="Back to the fleet"
      aria-label="Back to the fleet"
      data-test="brand-home"
      class="flex shrink-0 items-center gap-[9px]"
      @click="router.push('/')"
    >
      <!-- Brand mark: the app icon's stacked-window glyph, redrawn for 26px. The ghost
           cards use currentColor so they invert with the theme; the front card keeps the
           logo's violet identity and its emerald status dot. Decorative — the button
           already carries the accessible name, and pointer-events-none keeps the SVG
           from ever becoming the click target. -->
      <svg
        data-test="brand-mark"
        class="pointer-events-none shrink-0"
        width="26"
        height="26"
        viewBox="0 0 26 26"
        fill="none"
        aria-hidden="true"
        focusable="false"
      >
        <g stroke="currentColor" stroke-width="1.5" stroke-linejoin="round">
          <rect x="2" y="3.5" width="15" height="12" rx="2.5" opacity="0.28" />
          <rect x="5.5" y="7" width="15" height="12" rx="2.5" opacity="0.5" />
        </g>
        <!-- Opaque knockout so the ghost strokes don't muddy the front card's wash.
             Matches the header's own bg-[var(--bg-elev)]. -->
        <rect x="9" y="10.5" width="15" height="12" rx="2.5" fill="var(--bg-elev)" />
        <rect
          x="9"
          y="10.5"
          width="15"
          height="12"
          rx="2.5"
          fill="var(--violet)"
          fill-opacity="0.18"
          stroke="var(--violet)"
          stroke-width="1.5"
          stroke-linejoin="round"
        />
        <path d="M9 14.25h15" stroke="var(--violet)" stroke-width="1.25" />
        <circle cx="11.9" cy="12.4" r="1.15" fill="var(--emerald)" />
      </svg>
      <div class="text-[14px] font-semibold tracking-[-0.02em]">macfleet</div>
    </button>

    <div class="relative max-w-[400px] flex-1">
      <span
        class="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-[12px] text-[var(--text-faint)]"
      >
        ⌕
      </span>
      <input
        v-model="ui.search"
        type="text"
        placeholder="Search fleet, snapshots, actions…"
        class="h-8 w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] pr-2.5 pl-7 text-[12.5px] text-[var(--text)] outline-none"
      />
    </div>

    <button
      type="button"
      data-test="palette-trigger"
      class="flex h-8 items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--bg)] py-0 pr-2 pl-3 text-[12px] text-[var(--text-dim)]"
      @click="ui.openPalette()"
    >
      <span>Command palette</span>
      <kbd
        class="rounded-[5px] border border-[var(--border)] bg-[var(--bg-elev2)] px-[5px] py-0.5 font-mono text-[11px] text-[var(--text-dim)]"
        >⌘K</kbd
      >
    </button>

    <div class="flex-1" />

    <div
      title="Host capacity"
      data-test="capacity-chip"
      class="flex h-[30px] items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-[11px] font-mono text-[11.5px] text-[var(--text-dim)] tabular-nums"
    >
      <span class="h-1.5 w-1.5 rounded-full bg-[var(--emerald)]" />
      {{ capacityLabel }}
    </div>

    <AgentIndicator />

    <button
      type="button"
      title="Settings (⌘,)"
      aria-label="Settings"
      data-test="settings-button"
      class="flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--bg)] text-[14px] text-[var(--text-dim)]"
      @click="router.push('/settings')"
    >
      ⚙
    </button>

    <button
      type="button"
      title="Toggle theme"
      :aria-label="isDark ? 'Switch to light mode' : 'Switch to dark mode'"
      class="flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--bg)] text-[14px] text-[var(--text-dim)]"
      @click="toggleDark()"
    >
      {{ themeIcon }}
    </button>
  </header>
</template>
