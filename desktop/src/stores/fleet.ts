import { defineStore } from 'pinia'
import { ref } from 'vue'
import { api, type Vm } from '../shared/api'

const short = (n: string) => (n.startsWith('mf-') ? n.slice(3) : n)

// Smooth transient health misses: the guest's /status check competes with the 3MB
// screenshot stream and occasionally times out, which would otherwise flap a running
// VM's status to "booting". Hold a previously-healthy VM healthy across a single miss;
// flip only after two consecutive misses. A never-healthy (booting) VM is unaffected.
function healthSmoother() {
  const seen = new Map<string, { healthy: boolean; miss: number }>()
  return (v: Vm): Vm => {
    const prev = seen.get(v.name)
    if (v.healthy) {
      seen.set(v.name, { healthy: true, miss: 0 })
      return v
    }
    const miss = (prev?.miss ?? 0) + 1
    const held = (prev?.healthy ?? false) && miss < 2
    seen.set(v.name, { healthy: held, miss })
    return held ? { ...v, healthy: true } : v
  }
}

export const useFleet = defineStore('fleet', () => {
  const vms = ref<Vm[]>([])
  const error = ref<string | null>(null)
  const smooth = healthSmoother()
  // false until the first successful list — lets the UI show "connecting" during
  // the sidecar cold-start instead of flashing a scary error.
  const loaded = ref(false)
  // Short names of VMs being created. Rendered as "creating" rows for instant
  // feedback and pruned once the VM shows up running in the polled list.
  const pending = ref<string[]>([])

  async function refresh(): Promise<void> {
    try {
      // Only mf- fleet VMs are operable; base/OCI images can't be controlled, and
      // mf-golden is the read-only clone template, not a work VM.
      vms.value = (await api.listVms())
        .filter((v) => v.name.startsWith('mf-') && v.name !== 'mf-golden')
        .map(smooth)
      error.value = null
      loaded.value = true
      pending.value = pending.value.filter(
        (n) => !vms.value.some((v) => short(v.name) === n && v.state === 'running'),
      )
    } catch (e) {
      error.value = String(e)
    }
  }

  async function up(name: string): Promise<void> {
    // Optimistic: show the VM as "creating" the instant the user asks for it.
    if (!pending.value.includes(name)) pending.value = [...pending.value, name]
    try {
      await api.up(name)
      await refresh()
    } catch (e) {
      error.value = String(e)
      pending.value = pending.value.filter((n) => n !== name)
    }
  }

  // Surface API failures on `error` rather than rejecting into the caller's event
  // handler (which Vue reports as an unhandled error).
  async function run(fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn()
      await refresh()
    } catch (e) {
      error.value = String(e)
    }
  }
  const down = (name: string) => run(() => api.down(name))
  const nuke = (name: string) => run(() => api.nuke(name))

  return { vms, error, loaded, pending, refresh, up, down, nuke }
})
