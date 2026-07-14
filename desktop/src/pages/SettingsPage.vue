<script setup lang="ts">
import { computed, onMounted } from 'vue'
import type { PresetName } from '../shared/api'
import { useSettings } from '../stores/settings'

const settings = useSettings()

const presetList = computed(() =>
  settings.presets
    ? (Object.entries(settings.presets) as [PresetName, { cpu: number; memory_gb: number }][])
    : [],
)

async function choose(name: PresetName): Promise<void> {
  if (name === settings.defaultPreset) return
  await settings.setDefaultPreset(name)
}

onMounted(() => {
  settings.load()
})
</script>

<template>
  <div data-test="settings-page" class="mx-auto flex max-w-2xl flex-col gap-8 p-6">
    <h1 class="text-[15px] font-semibold text-[var(--text)]">Settings</h1>

    <section class="flex flex-col gap-3">
      <div>
        <h2 class="text-[13px] font-semibold text-[var(--text)]">Default size</h2>
        <p class="mt-0.5 text-[11.5px] text-[var(--text-faint)]">
          Applied to new VMs, from the CLI and here alike.
        </p>
      </div>

      <div role="radiogroup" class="grid grid-cols-3 gap-2">
        <button
          v-for="[name, p] in presetList"
          :key="name"
          type="button"
          role="radio"
          :data-test="`preset-${name}`"
          :aria-checked="name === settings.defaultPreset ? 'true' : 'false'"
          class="flex flex-col items-start gap-1 rounded-[7px] border px-3 py-2.5 text-left"
          :class="
            name === settings.defaultPreset
              ? 'border-[var(--emerald)] bg-[var(--bg-elev2)]'
              : 'border-[var(--border)] bg-[var(--bg-elev)] hover:bg-[var(--bg-hover)]'
          "
          @click="choose(name)"
        >
          <span class="text-[12.5px] font-semibold capitalize text-[var(--text)]">{{ name }}</span>
          <span class="font-mono text-[11px] tabular-nums text-[var(--text-dim)]">
            {{ p.cpu }} vCPU · {{ p.memory_gb }} GB
          </span>
        </button>
      </div>

      <p class="text-[11px] text-[var(--text-faint)]">
        Disk is not part of a preset — it can only grow, and every VM starts from the golden
        image's disk.
      </p>
    </section>
  </div>
</template>
