<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { defaultSnapshotLabel, sanitizeLabel } from '../shared/snapshot'
import { useFleet } from '../stores/fleet'
import { useUi } from '../stores/ui'

const ui = useUi()
const fleet = useFleet()
const label = ref('')

const targets = computed(() => ui.snapshotTarget ?? [])
const open = computed(() => targets.value.length > 0)
const clean = computed(() => sanitizeLabel(label.value))
const valid = computed(() => clean.value.length > 0)

watch(open, (isOpen) => {
  if (isOpen) label.value = defaultSnapshotLabel(new Date())
})

async function save(): Promise<void> {
  if (!valid.value) return
  const names = targets.value
  const chosen = clean.value
  ui.closeSnapshot()
  for (const name of names) await fleet.snapshotVM(name, chosen)
}
</script>

<template>
  <div
    v-if="open"
    data-test="snapshot-dialog"
    class="fixed inset-0 z-40 flex items-center justify-center bg-black/40"
    @click.self="ui.closeSnapshot()"
  >
    <div class="w-[320px] rounded-xl border border-[var(--border)] bg-[var(--bg-elev)] p-4">
      <div class="mb-2 text-sm font-semibold text-[var(--text)]">
        Snapshot {{ targets.join(', ') }}
      </div>
      <input
        v-model="label"
        data-test="snapshot-label"
        class="h-9 w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2.5 font-mono text-[12.5px] text-[var(--text)] outline-none"
        @keydown.enter="save"
        @keydown.escape="ui.closeSnapshot()"
      />
      <div class="mt-1 font-mono text-[11px] text-[var(--text-faint)]">
        id: mfsnap-…-{{ clean || '?' }}
      </div>
      <div class="mt-3 flex justify-end gap-2">
        <button
          type="button"
          data-test="snapshot-cancel"
          class="h-8 rounded-lg border border-[var(--border)] px-3 text-xs text-[var(--text-dim)]"
          @click="ui.closeSnapshot()"
        >
          Cancel
        </button>
        <button
          type="button"
          data-test="snapshot-save"
          :disabled="!valid"
          class="h-8 rounded-lg bg-[var(--emerald)] px-3 text-xs font-semibold text-[#04130d] disabled:opacity-50"
          @click="save"
        >
          Save
        </button>
      </div>
    </div>
  </div>
</template>
