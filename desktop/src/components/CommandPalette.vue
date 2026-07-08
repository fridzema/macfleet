<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { useUi } from '../stores/ui'

const ui = useUi()

// Autofocus the input on open, same pattern as VmDetail's rename input (watch + nextTick,
// not the native `autofocus` attribute — jsdom doesn't honor it, and this app already
// relies on the explicit-focus convention elsewhere).
const queryInput = ref<HTMLInputElement | null>(null)
watch(
  () => ui.open,
  async (open) => {
    if (!open) return
    await nextTick()
    queryInput.value?.focus()
  },
)

function moveDown(): void {
  const max = ui.paletteItems.length - 1
  if (max < 0) return
  ui.index = Math.min(max, ui.index + 1)
}
function moveUp(): void {
  if (ui.paletteItems.length === 0) return
  ui.index = Math.max(0, ui.index - 1)
}
function runActive(): void {
  ui.paletteItems[ui.index]?.run()
}
function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    moveDown()
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    moveUp()
  } else if (e.key === 'Enter') {
    e.preventDefault()
    runActive()
  } else if (e.key === 'Escape') {
    e.preventDefault()
    ui.closePalette()
  }
}
</script>

<template>
  <div
    v-if="ui.open"
    data-test="palette-backdrop"
    class="fixed inset-0 z-50 flex justify-center pt-[12vh] backdrop-blur-[3px]"
    style="background: rgba(0, 0, 0, 0.5)"
    @click="ui.closePalette()"
  >
    <div
      data-test="palette-modal"
      class="flex max-h-[60vh] w-[min(600px,92vw)] flex-col overflow-hidden rounded-[14px] border border-[var(--border-strong)] bg-[var(--bg-elev)] shadow-[0_20px_70px_-10px_rgba(0,0,0,.6)] animate-[mfin_0.14s_ease]"
      @click.stop
    >
      <div class="flex items-center gap-2.5 border-b border-[var(--border)] px-4 py-3.5">
        <span class="text-[15px] text-[var(--text-faint)]">⌘</span>
        <input
          ref="queryInput"
          v-model="ui.query"
          type="text"
          data-test="palette-input"
          placeholder="Type a command or search…"
          class="flex-1 border-none bg-transparent text-[15px] text-[var(--text)] outline-none"
          @keydown="onKeydown"
        />
        <kbd
          class="rounded-[5px] border border-[var(--border)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--text-faint)]"
          >esc</kbd
        >
      </div>
      <div class="flex-1 overflow-y-auto p-1.5">
        <button
          v-for="(item, i) in ui.paletteItems"
          :key="item.id"
          type="button"
          data-test="palette-item"
          class="flex w-full items-center gap-3 rounded-[9px] border-none px-[11px] py-2.5 text-left text-[13px]"
          :class="i === ui.index ? 'bg-[var(--bg-elev2)]' : 'bg-transparent'"
          @click="item.run()"
          @mouseenter="ui.index = i"
        >
          <span
            class="w-[52px] flex-none text-left text-[10.5px] tracking-[.04em] text-[var(--text-faint)] uppercase"
            >{{ item.group }}</span
          >
          <span class="flex-1 text-left text-[var(--text)]">{{ item.label }}</span>
          <kbd v-if="i === ui.index" class="font-mono text-[11px] text-[var(--text-faint)]"
            >↵</kbd
          >
        </button>
        <div
          v-if="ui.paletteItems.length === 0"
          data-test="palette-empty"
          class="p-[22px] text-center text-[13px] text-[var(--text-faint)]"
        >
          No matching commands
        </div>
      </div>
    </div>
  </div>
</template>
