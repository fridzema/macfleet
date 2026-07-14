<script setup lang="ts">
import { confirm } from '@tauri-apps/plugin-dialog'
import { computed, onMounted } from 'vue'
import type { PresetName } from '../shared/api'
import { useFleet } from '../stores/fleet'
import { useSettings } from '../stores/settings'

const settings = useSettings()
const fleet = useFleet()

const presetList = computed(() =>
  settings.presets
    ? (Object.entries(settings.presets) as [PresetName, { cpu: number; memory_gb: number }][])
    : [],
)

async function choose(name: PresetName): Promise<void> {
  if (name === settings.defaultPreset) return
  await settings.setDefaultPreset(name)
}

async function reset(scope: 'fleet' | 'all'): Promise<void> {
  const message =
    scope === 'all'
      ? 'Delete every VM, snapshot, and setting — including the golden image?\n\nThe golden image needs a full re-bake afterwards, which takes a while. This cannot be undone.'
      : 'Delete every VM, snapshot, and stored macfleet state?\n\nThe golden image is kept, so you can spin up again immediately. This cannot be undone.'
  const ok = await confirm(message, { title: 'macfleet', kind: 'warning' })
  if (!ok) return
  const res = await settings.resetData(scope)
  // The sidebar is still showing VMs that no longer exist.
  if (res) await fleet.refresh()
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

    <section class="flex flex-col gap-3">
      <div>
        <h2 class="text-[13px] font-semibold text-[var(--text)]">Data</h2>
        <p class="mt-0.5 text-[11.5px] text-[var(--text-faint)]">
          Deletes only what macfleet owns. Other VMs in your tart store are untouched.
        </p>
      </div>

      <div class="flex flex-col gap-2">
        <button
          type="button"
          data-test="reset-fleet"
          :disabled="settings.resetting"
          class="flex items-center justify-between rounded-[7px] border border-[var(--border)] bg-[var(--bg-elev)] px-3 py-2.5 text-left hover:bg-[var(--bg-hover)] disabled:opacity-50"
          @click="reset('fleet')"
        >
          <span class="text-[12.5px] text-[var(--text)]">Remove all VMs &amp; data</span>
          <span class="text-[11px] text-[var(--text-faint)]">keeps the golden image</span>
        </button>

        <button
          type="button"
          data-test="reset-all"
          :disabled="settings.resetting"
          class="flex items-center justify-between rounded-[7px] border border-[var(--red)] bg-[var(--bg-elev)] px-3 py-2.5 text-left hover:bg-[var(--bg-hover)] disabled:opacity-50"
          @click="reset('all')"
        >
          <span class="text-[12.5px] text-[var(--red)]">Full reset</span>
          <span class="text-[11px] text-[var(--text-faint)]">golden image needs a re-bake</span>
        </button>
      </div>
    </section>
  </div>
</template>
