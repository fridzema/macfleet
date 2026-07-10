<script setup lang="ts">
import { ref } from 'vue'
import { useFleet } from '../stores/fleet'
import { useUi } from '../stores/ui'

const store = useFleet()
const ui = useUi()
const armedDelete = ref(false)

function del(): void {
  const names = [...ui.selectedVms]
  if (!armedDelete.value) {
    armedDelete.value = true
    return
  }
  armedDelete.value = false
  store.bulkNuke(names)
  ui.clearSelection()
}
</script>

<template>
  <div class="flex flex-1 flex-col items-center justify-center gap-5 p-6 text-[var(--text-dim)]">
    <div class="text-[15px] font-[550] text-[var(--text)]">{{ ui.selectionCount }} selected</div>
    <div class="flex max-w-[420px] flex-wrap justify-center gap-1.5">
      <span
        v-for="name in ui.selectedVms"
        :key="name"
        class="flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--bg-elev2)] px-2 py-1 font-mono text-[11px]"
      >
        {{ name }}
        <button type="button" class="text-[var(--text-faint)]" @click="ui.toggleSelect(name)">✕</button>
      </span>
    </div>
    <div class="flex flex-wrap justify-center gap-2">
      <button
        type="button"
        data-test="bulk-suspend"
        class="h-9 rounded-lg border border-[var(--border)] bg-[var(--bg-elev2)] px-3 text-xs"
        @click="store.bulkSuspend([...ui.selectedVms])"
      >
        ⏸ Suspend
      </button>
      <button
        type="button"
        data-test="bulk-resume"
        class="h-9 rounded-lg border border-[var(--border)] bg-[var(--bg-elev2)] px-3 text-xs"
        @click="store.bulkResume([...ui.selectedVms])"
      >
        ▶ Resume
      </button>
      <button
        type="button"
        data-test="bulk-stop"
        class="h-9 rounded-lg border border-[var(--border)] bg-[var(--bg-elev2)] px-3 text-xs"
        @click="store.bulkStop([...ui.selectedVms])"
      >
        ■ Stop
      </button>
      <button
        type="button"
        data-test="bulk-snapshot"
        class="h-9 rounded-lg border border-[var(--border)] bg-[var(--bg-elev2)] px-3 text-xs"
        @click="ui.requestSnapshot([...ui.selectedVms])"
      >
        ◈ Snapshot
      </button>
      <button
        type="button"
        data-test="bulk-delete"
        class="h-9 rounded-lg border border-[var(--border)] px-3 text-xs text-[var(--red)]"
        @click="del"
      >
        {{ armedDelete ? 'Confirm delete' : '🗑 Delete' }}
      </button>
    </div>
    <button
      type="button"
      data-test="bulk-clear"
      class="text-[11px] text-[var(--text-faint)]"
      @click="ui.clearSelection()"
    >
      Clear selection
    </button>
  </div>
</template>
