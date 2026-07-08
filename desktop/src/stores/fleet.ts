import { defineStore } from 'pinia'
import { ref } from 'vue'
import { useToasts } from '../composables/useToasts'
import { api, type HostInfo, type Snapshot, type Vm } from '../shared/api'

const short = (n: string) => (n.startsWith('mf-') ? n.slice(3) : n)

export type Tab = 'screen' | 'terminal' | 'logs' | 'resources' | 'connect'
export type Preset = 'light' | 'standard' | 'heavy'

export interface CreateOptions {
  name: string
  // 'golden' clones the read-only template; anything else is a snapshot id.
  source: 'golden' | string
  preset: Preset
  ttl: boolean
  advancedOpen: boolean
}

// cpu / RAM (GB) / disk (GB) — matches the design comp's presets verbatim.
const PRESETS: Record<Preset, { cpu: number; memoryGb: number; disk: number }> = {
  light: { cpu: 2, memoryGb: 4, disk: 40 },
  standard: { cpu: 4, memoryGb: 8, disk: 50 },
  heavy: { cpu: 8, memoryGb: 16, disk: 80 },
}

const LEASE_TTL_SECONDS = 600

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
  const { add: toast } = useToasts()

  const vms = ref<Vm[]>([])
  const snapshots = ref<Snapshot[]>([])
  const host = ref<HostInfo | null>(null)
  const error = ref<string | null>(null)
  const smooth = healthSmoother()
  // false until the first successful list — lets the UI show "connecting" during
  // the sidecar cold-start instead of flashing a scary error.
  const loaded = ref(false)
  // Short names of VMs being created. Rendered as "creating" rows for instant
  // feedback and pruned once the VM shows up running in the polled list.
  const pending = ref<string[]>([])

  const selectedTab = ref<Tab>('screen')
  const createOptions = ref<CreateOptions>({
    name: '',
    source: 'golden',
    preset: 'standard',
    ttl: false,
    advancedOpen: false,
  })

  // Client-side countdown (seconds remaining) for VMs created with a TTL lease, keyed
  // by short name. The server is the one that actually reaps expired leases (see
  // `Fleet.reap`) — this just reflects/announces that locally between polls.
  const leases = ref<Record<string, number>>({})

  async function refresh(): Promise<void> {
    try {
      const [rawVms, rawSnapshots] = await Promise.all([api.listVms(), api.listSnapshots()])
      // Only mf- fleet VMs are operable; base/OCI images can't be controlled, and
      // mf-golden is the read-only clone template, not a work VM.
      vms.value = rawVms
        .filter((v) => v.name.startsWith('mf-') && v.name !== 'mf-golden')
        .map(smooth)
      snapshots.value = rawSnapshots
      error.value = null
      loaded.value = true
      pending.value = pending.value.filter(
        (n) => !vms.value.some((v) => short(v.name) === n && v.state === 'running'),
      )
    } catch (e) {
      error.value = String(e)
    }
  }

  async function fetchHost(): Promise<void> {
    if (host.value) return
    try {
      host.value = await api.host()
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
  // handler (which Vue reports as an unhandled error). `errorToast`, when given, is
  // shown to the user too — used by mutations the user directly triggered.
  async function run(fn: () => Promise<unknown>, errorToast?: string): Promise<void> {
    try {
      await fn()
      await refresh()
    } catch (e) {
      error.value = String(e)
      if (errorToast) toast(errorToast, '⚠')
    }
  }
  const down = (name: string) => run(() => api.down(name))
  const nuke = (name: string) => run(() => api.nuke(name))
  const suspend = (name: string) => run(() => api.suspend(name), `Failed to suspend ${name}`)
  const resume = (name: string) => run(() => api.resume(name), `Failed to resume ${name}`)
  const rename = (oldName: string, newName: string) =>
    run(() => api.rename(oldName, newName), `Failed to rename ${oldName}`)
  const deleteSnapshot = (id: string) =>
    run(() => api.deleteSnapshot(id), 'Failed to delete snapshot')

  async function snapshotVM(name: string, label: string): Promise<void> {
    toast(`Freezing state of ${name}…`, '◈')
    try {
      await api.snapshot(name, label)
      await refresh()
      toast('Snapshot saved', '✓')
    } catch (e) {
      error.value = String(e)
      toast(`Failed to snapshot ${name}`, '⚠')
    }
  }

  async function duplicate(name: string): Promise<void> {
    const newName = `${name}-copy`
    // Optimistic: show the clone as "creating" immediately, like `up`/`create`. Only a
    // START toast — readiness is conveyed by the pending row flipping to "running" once
    // the polled list catches up, NOT a premature toast (the clone's `tart run` is
    // non-blocking, so the VM is still booting when `api.duplicate` resolves).
    if (!pending.value.includes(newName)) pending.value = [...pending.value, newName]
    toast(`Duplicating ${name}…`, '⧉')
    try {
      await api.duplicate(name, newName)
      await refresh()
    } catch (e) {
      error.value = String(e)
      pending.value = pending.value.filter((n) => n !== newName)
      toast(`Failed to duplicate ${name}`, '⚠')
    }
  }

  async function create(): Promise<void> {
    const opts = createOptions.value
    const name = (opts.name.trim() || `vm-${Math.random().toString(16).slice(2, 6)}`).replace(
      /\s+/g,
      '-',
    )
    const preset = PRESETS[opts.preset]
    const fromSnapshot = opts.source === 'golden' ? undefined : opts.source
    const snap = fromSnapshot ? snapshots.value.find((s) => s.id === fromSnapshot) : undefined

    // Optimistic: a "creating" row (and, if leased, its countdown) the instant the
    // user asks for it — cloning/booting takes real time server-side.
    if (!pending.value.includes(name)) pending.value = [...pending.value, name]
    if (opts.ttl) leases.value = { ...leases.value, [name]: LEASE_TTL_SECONDS }
    toast(snap ? `Cloning from ${snap.label}…` : `Creating ${name}…`, '⚡')

    try {
      await api.create(name, {
        ...(fromSnapshot ? { from_snapshot: fromSnapshot } : {}),
        ...(opts.ttl ? { ttl: LEASE_TTL_SECONDS } : {}),
        cpu: preset.cpu,
        memory: preset.memoryGb * 1024,
        disk: preset.disk,
      })
      createOptions.value = { ...opts, name: '', advancedOpen: false }
      await refresh()
    } catch (e) {
      error.value = String(e)
      pending.value = pending.value.filter((n) => n !== name)
      if (opts.ttl) {
        const nextLeases = { ...leases.value }
        delete nextLeases[name]
        leases.value = nextLeases
      }
      toast(`Failed to create ${name}`, '⚠')
    }
  }

  async function newFromSnapshot(snap: Snapshot): Promise<void> {
    createOptions.value = {
      ...createOptions.value,
      source: snap.id,
      name: `${snap.label.replace(/[^a-z0-9]+/gi, '-')}-${Math.random().toString(16).slice(2, 5)}`,
    }
    await create()
  }

  // Per-second countdown for leased VMs. The store never wires its own `setInterval` —
  // a component calls this on a timer (same pattern as the sidebar's `refresh` poll) so
  // tests can drive it directly without real timers.
  async function tickTtl(): Promise<void> {
    const next: Record<string, number> = {}
    const expired: string[] = []
    for (const [name, remaining] of Object.entries(leases.value)) {
      const n = remaining - 1
      if (n <= 0) expired.push(name)
      else next[name] = n
    }
    leases.value = next
    if (expired.length) {
      for (const name of expired) toast(`Lease expired — ${name}`, '⏱')
      await refresh()
    }
  }

  return {
    vms,
    snapshots,
    host,
    error,
    loaded,
    pending,
    selectedTab,
    createOptions,
    leases,
    refresh,
    fetchHost,
    up,
    down,
    nuke,
    suspend,
    resume,
    snapshotVM,
    duplicate,
    rename,
    deleteSnapshot,
    newFromSnapshot,
    create,
    tickTtl,
  }
})
