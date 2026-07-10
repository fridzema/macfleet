<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue'
import { type ContextMenuItem, useUi } from '../stores/ui'

const ui = useUi()

function choose(item: ContextMenuItem): void {
  ui.closeContextMenu()
  item.run()
}

// Dismiss on any outside interaction. Escape/scroll/resize also close.
function onDocPointer(): void {
  if (ui.contextMenu) ui.closeContextMenu()
}
function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') ui.closeContextMenu()
}
onMounted(() => {
  window.addEventListener('pointerdown', onDocPointer, true)
  window.addEventListener('scroll', onDocPointer, true)
  window.addEventListener('resize', onDocPointer)
  window.addEventListener('keydown', onKey)
})
onBeforeUnmount(() => {
  window.removeEventListener('pointerdown', onDocPointer, true)
  window.removeEventListener('scroll', onDocPointer, true)
  window.removeEventListener('resize', onDocPointer)
  window.removeEventListener('keydown', onKey)
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="ui.contextMenu"
      data-test="context-menu"
      class="fixed z-50 min-w-[168px] rounded-lg border border-[var(--border)] bg-[var(--bg-elev)] py-1 shadow-[var(--shadow)]"
      :style="{ left: `${ui.contextMenu.x}px`, top: `${ui.contextMenu.y}px` }"
      @contextmenu.prevent
    >
      <button
        v-for="item in ui.contextMenu.items"
        :key="item.label"
        type="button"
        data-test="ctx-item"
        class="block w-full px-3 py-1.5 text-left text-xs hover:bg-[var(--bg-hover)]"
        :class="item.danger ? 'text-[var(--red)]' : 'text-[var(--text-dim)]'"
        @click="choose(item)"
      >
        {{ item.label }}
      </button>
    </div>
  </Teleport>
</template>
