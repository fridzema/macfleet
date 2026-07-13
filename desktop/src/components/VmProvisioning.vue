<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { api, type ProvisionRecord, type ProvisionStatus } from '../shared/api'
import { useFleet } from '../stores/fleet'
import { useUi } from '../stores/ui'

const props = defineProps<{ name: string }>()
const store = useFleet()
const ui = useUi()

// SSE keeps store.provisioning fresh; fetch once on mount so the panel paints before the first
// stream frame (which can be up to ~2s away). Best-effort — the stream fills it in regardless.
const fetched = ref<ProvisionRecord | null>(null)
onMounted(async () => {
  if (!store.provisioning[props.name]) {
    try {
      fetched.value = await api.provision(props.name)
    } catch {
      // ignore — the SSE stream will deliver the record shortly
    }
  }
})

const record = computed<ProvisionRecord | null>(
  () => store.provisioning[props.name] ?? fetched.value,
)

// Until the first record lands (the very first moments of a create) show the phases as pending so
// the panel never flashes empty.
const FALLBACK_STEPS: ProvisionRecord['steps'] = [
  { key: 'clone', label: 'Clone image', status: 'active' },
  { key: 'configure', label: 'Apply resources', status: 'pending' },
  { key: 'boot', label: 'Boot guest', status: 'pending' },
  { key: 'health', label: 'Guest health check', status: 'pending' },
]
const steps = computed(() => record.value?.steps ?? FALLBACK_STEPS)
const errorMsg = computed(() => record.value?.error ?? null)

// Reuses the fleet's status palette (emerald done / amber active / idle pending) so the stepper
// reads the same as the sidebar dots and detail badge.
const STEP_META: Record<ProvisionStatus, { glyph: string; dotClass: string; labelClass: string }> =
  {
    done: { glyph: '●', dotClass: 'text-[var(--emerald)]', labelClass: 'text-[var(--text)]' },
    active: {
      glyph: '◐',
      dotClass: 'text-[var(--amber)] animate-[mfpulse_1.4s_ease-in-out_infinite]',
      labelClass: 'text-[var(--text)] font-[550]',
    },
    pending: {
      glyph: '○',
      dotClass: 'text-[var(--text-faint)]',
      labelClass: 'text-[var(--text-dim)]',
    },
    skipped: {
      glyph: '–',
      dotClass: 'text-[var(--text-faint)] opacity-60',
      labelClass: 'text-[var(--text-faint)]',
    },
    error: { glyph: '✕', dotClass: 'text-[var(--red)]', labelClass: 'text-[var(--red)]' },
  }
function meta(status: ProvisionStatus) {
  return STEP_META[status] ?? STEP_META.pending
}

function dismiss(): void {
  ui.selectVm(null)
}
</script>

<template>
  <div
    data-test="provisioning-panel"
    class="flex flex-1 flex-col items-center justify-center gap-6 p-8"
  >
    <div
      class="flex w-full max-w-[340px] flex-col gap-5 rounded-[14px] border border-[var(--border)] p-6"
    >
      <div class="flex flex-col gap-1">
        <div class="text-[13px] font-semibold text-[var(--text)]">
          {{ errorMsg ? 'Provisioning failed' : `Provisioning ${name}…` }}
        </div>
        <div class="text-[12px] text-[var(--text-faint)]">
          {{
            errorMsg
              ? 'The create did not complete — see the error below.'
              : 'Cloning the golden image, booting the guest, and waiting for it to answer.'
          }}
        </div>
      </div>

      <ol class="flex flex-col gap-3">
        <li
          v-for="step in steps"
          :key="step.key"
          data-test="provision-step"
          :data-status="step.status"
          class="flex items-center gap-3"
        >
          <span class="w-4 text-center text-[13px] leading-none" :class="meta(step.status).dotClass">
            {{ meta(step.status).glyph }}
          </span>
          <span class="text-[12.5px]" :class="meta(step.status).labelClass">{{ step.label }}</span>
        </li>
      </ol>

      <div
        v-if="errorMsg"
        data-test="provision-error"
        class="rounded-lg bg-[var(--red-soft)] px-3 py-2 text-[11.5px] text-[var(--red)]"
      >
        {{ errorMsg }}
      </div>

      <button
        v-if="errorMsg"
        type="button"
        data-test="provision-dismiss"
        class="h-[30px] rounded-lg border border-[var(--border-strong)] text-xs font-semibold text-[var(--text-dim)]"
        @click="dismiss"
      >
        Dismiss
      </button>
    </div>
  </div>
</template>
