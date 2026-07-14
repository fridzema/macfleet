<script setup lang="ts">
import { onMounted } from 'vue'
import { useSettings } from '../stores/settings'

const settings = useSettings()

onMounted(() => {
  settings.load()
})
</script>

<template>
  <div data-test="settings-page" class="mx-auto flex max-w-2xl flex-col gap-6 p-6">
    <h1 class="text-[15px] font-semibold text-[var(--text)]">Settings</h1>
  </div>
</template>
