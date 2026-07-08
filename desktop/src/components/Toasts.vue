<script setup lang="ts">
import { useToasts } from '../composables/useToasts'

const { toasts } = useToasts()
</script>

<template>
  <div class="fixed right-4 bottom-4 z-[60] flex flex-col items-end gap-[9px]">
    <div
      v-for="t in toasts"
      :key="t.id"
      data-test="toast"
      class="flex max-w-[320px] items-center gap-[9px] rounded-[10px] border border-[var(--border-strong)] bg-[var(--bg-elev)] px-3.5 py-2.5 text-[12.5px] text-[var(--text)] shadow-[var(--shadow)] animate-[mfin_0.16s_ease]"
    >
      <span class="text-sm">{{ t.icon }}</span>
      <span>{{ t.msg }}</span>
    </div>
  </div>
</template>
