<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'

// Phase 2: replace the empty state below with a live feed of agent activity (who /
// action / target / timestamp), sourced from an MCP session log once agents actually
// connect. Comp lines 83–102 show the fabricated version (agentCount + agents list) —
// deliberately not ported: `list_vms` has no agent-activity source yet, so a real count
// or feed here would just be invented data.

const open = ref(false)

function toggle(): void {
  open.value = !open.value
}

function onKey(e: KeyboardEvent): void {
  if (open.value && e.key === 'Escape') open.value = false
}
onMounted(() => window.addEventListener('keydown', onKey))
onUnmounted(() => window.removeEventListener('keydown', onKey))
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
          class="absolute -inset-[3px] animate-[mfdot_1.6s_ease-in-out_infinite] rounded-full bg-[var(--emerald)] opacity-30"
        />
      </span>
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
      <p class="px-2.5 pb-2 text-[12.5px] text-[var(--text-dim)]">
        No agent activity yet — connect an agent over MCP.
      </p>
    </div>
  </div>
</template>
