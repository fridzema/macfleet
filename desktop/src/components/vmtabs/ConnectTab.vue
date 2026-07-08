<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useToasts } from '../../composables/useToasts'
import { api, type ConnectionInfo } from '../../shared/api'

const props = defineProps<{ name: string }>()
const { add: toast } = useToasts()

const connection = ref<ConnectionInfo | null>(null)
const loading = ref(true)

// Local fetch, not the fleet store — connection info is only ever read here (comp
// lines 384–400), so there's nothing else to share a cache with.
async function load(name: string): Promise<void> {
  loading.value = true
  try {
    connection.value = await api.connection(name)
  } catch {
    // Not running yet (or the sidecar call failed) — fall through to the
    // unavailable state below rather than fabricating connection details.
    connection.value = null
  } finally {
    loading.value = false
  }
}
watch(() => props.name, load, { immediate: true })

interface ConnectItem {
  key: string
  label: string
  value: string
}

// comp's `connectItems` (design source line 679) — empty until there's a real IP.
const items = computed<ConnectItem[]>(() => {
  const c = connection.value
  if (!c?.ip || c.ip === '—') return []
  return [
    { key: 'ip', label: 'IP address', value: c.ip },
    { key: 'ssh', label: 'SSH', value: c.ssh },
    { key: 'vnc', label: 'Screen sharing (VNC)', value: c.vnc },
    { key: 'url', label: 'Guest server URL', value: c.guest_server },
  ]
})

// comp `copyField` (design source line 582): copy, flash "✓ Copied" for a beat, toast.
const copied = ref('')
let copiedTimer: ReturnType<typeof setTimeout> | null = null
function copyField(key: string, value: string): void {
  try {
    // A real WKWebView can reject this asynchronously (permission denied) — swallow it
    // so that doesn't surface as an unhandled promise rejection; the UI still confirms.
    navigator.clipboard.writeText(value).catch(() => {})
  } catch {
    // Clipboard API unavailable — still confirm, matching the comp.
  }
  copied.value = key
  if (copiedTimer) clearTimeout(copiedTimer)
  copiedTimer = setTimeout(() => {
    copied.value = ''
  }, 1300)
  toast('Copied to clipboard', '✓')
}
onBeforeUnmount(() => {
  if (copiedTimer) clearTimeout(copiedTimer)
})
</script>

<template>
  <div class="mx-auto max-w-[720px]">
    <div class="mb-4 text-[12.5px] text-[var(--text-dim)]">
      Everything you need to reach
      <span class="font-mono text-[var(--text)]">{{ name }}</span>
      . In-guest <span class="font-mono text-[var(--text)]">exec</span> is always available — no
      SSH keys required.
    </div>

    <div v-if="loading" class="text-sm text-[var(--text-faint)]">Loading connection info…</div>
    <div v-else-if="items.length === 0" data-test="unavailable" class="text-sm text-[var(--text-faint)]">
      No connection info yet — start the VM to get an IP address.
    </div>
    <div v-else class="flex flex-col gap-2.5">
      <div
        v-for="item in items"
        :key="item.key"
        data-test="connect-item"
        class="flex items-center gap-3 rounded-[11px] border border-[var(--border)] bg-[var(--bg-elev)] px-[15px] py-[13px]"
      >
        <div class="min-w-0 flex-1">
          <div
            class="text-[11px] font-semibold tracking-[.05em] text-[var(--text-faint)] uppercase"
          >
            {{ item.label }}
          </div>
          <div
            class="mt-[5px] overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[13px] text-[var(--text)]"
          >
            {{ item.value }}
          </div>
        </div>
        <button
          type="button"
          data-test="copy-btn"
          class="h-[30px] shrink-0 rounded-lg border border-[var(--border)] px-3 text-xs font-[550]"
          :class="
            copied === item.key
              ? 'bg-[var(--emerald-soft)] text-[var(--emerald)]'
              : 'bg-[var(--bg-elev2)] text-[var(--text-dim)]'
          "
          @click="copyField(item.key, item.value)"
        >
          {{ copied === item.key ? '✓ Copied' : 'Copy' }}
        </button>
      </div>
    </div>
  </div>
</template>
