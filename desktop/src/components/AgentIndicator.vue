<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { type AgentActivity, api } from '../shared/api'
import { relativeTime } from '../shared/time'

const open = ref(false)
const feed = ref<AgentActivity[]>([])

const distinctAgentCount = computed(() => new Set(feed.value.map((a) => a.who)).size)

function toggle(): void {
  open.value = !open.value
}

function onKey(e: KeyboardEvent): void {
  if (open.value && e.key === 'Escape') open.value = false
}

// Best-effort poll, same as the fleet store's snapshot refresh (stores/fleet.ts): a
// transient /agents/activity failure keeps the last-known feed rather than blanking it
// back to the honest empty state.
async function load(): Promise<void> {
  try {
    feed.value = await api.agentsActivity(20)
  } catch {
    // ignored — see above
  }
}

let timer: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  window.addEventListener('keydown', onKey)
  load()
  timer = setInterval(load, 5000)
})
onUnmounted(() => {
  window.removeEventListener('keydown', onKey)
  // `timer` is unconditionally set in onMounted above, which always runs before this can
  // fire — same rationale as FleetSidebar's timer teardown; the null-guard only exists to
  // satisfy the `| null` type.
  /* istanbul ignore else */
  if (timer) clearInterval(timer)
})
</script>

<template>
  <div class="relative">
    <button
      type="button"
      data-test="agent-trigger"
      class="flex h-[30px] items-center gap-2 rounded-lg border border-transparent bg-[var(--emerald-soft)] px-[11px] text-[12px] font-medium text-[var(--emerald)]"
      @click="toggle"
    >
      <span class="relative inline-flex">
        <span class="h-[7px] w-[7px] rounded-full bg-[var(--emerald)]" />
        <span
          v-if="feed.length"
          class="absolute -inset-[3px] animate-[mfdot_1.6s_ease-in-out_infinite] rounded-full bg-[var(--emerald)] opacity-30"
        />
      </span>
      <span v-if="feed.length" data-test="agent-count">{{ distinctAgentCount }}</span>
      AI agents
    </button>
    <!-- Transparent full-screen backdrop closes the popover on an outside click, same
         pattern as CommandPalette's backdrop — just invisible, since this is a small
         header dropdown rather than a modal. -->
    <div v-if="open" data-test="agent-backdrop" class="fixed inset-0 z-10" @click="open = false" />
    <div
      v-if="open"
      data-test="agent-popover"
      class="absolute top-[38px] right-0 z-20 w-[300px] animate-[mfin_0.14s_ease] rounded-xl border border-[var(--border-strong)] bg-[var(--bg-elev)] p-1.5 shadow-[var(--shadow)]"
    >
      <div
        class="px-2.5 pt-2 pb-1.5 text-[11px] font-semibold tracking-[.06em] text-[var(--text-faint)] uppercase"
      >
        Agent activity
      </div>
      <p v-if="!feed.length" class="px-2.5 pb-2 text-[12.5px] text-[var(--text-dim)]">
        No agent activity yet — connect an agent over MCP.
      </p>
      <div
        v-for="(a, i) in feed"
        :key="`${a.who}-${a.ts}-${i}`"
        data-test="agent-row"
        class="flex items-start gap-[9px] rounded-lg px-2.5 py-2"
      >
        <span class="mt-[3px] h-[6px] w-[6px] shrink-0 rounded-full bg-[var(--emerald)]" />
        <div class="min-w-0 flex-1 text-[12.5px] text-[var(--text-dim)]">
          <span class="font-mono text-[var(--text)]">{{ a.who }}</span>
          · {{ a.action }} · {{ a.target }} · {{ relativeTime(a.ts) }}
        </div>
      </div>
    </div>
  </div>
</template>
