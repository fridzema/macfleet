import { defineStore } from 'pinia'
import { ref } from 'vue'
import { useToasts } from '../composables/useToasts'
import {
  api,
  type FleetUpdate,
  type HostInfo,
  type ProvisionRecord,
  type Resources,
  type Share,
  type Snapshot,
  type Vm,
} from '../shared/api'
import { useUi } from './ui'

// Its only caller (below, in refresh()) always feeds it a name from `vms.value`, which is
// itself filtered to `mf-`-prefixed names two lines earlier — the pass-through branch is
// unreachable from here (unlike the same helper in the Vue components, which read
// `store.vms` set directly by tests/bypassing that filter).
/* istanbul ignore next */
const short = (n: string) => (n.startsWith('mf-') ? n.slice(3) : n)

export type Tab = 'screen' | 'terminal' | 'logs' | 'resources' | 'connect' | 'folders'
export type Preset = 'light' | 'standard' | 'heavy'

// One in-guest command run in the Terminal tab. `code: null` means the exec call
// itself failed (network/sidecar error) — distinct from a nonzero guest exit, which is
// a normal result (`code` is the actual exit status the guest returned).
export interface ExecEntry {
  cmd: string
  out: string
  code: number | null
}

export interface CreateOptions {
  name: string
  // 'golden' clones the read-only template; anything else is a snapshot id.
  source: 'golden' | string
  preset: Preset
  ttl: boolean
  advancedOpen: boolean
}

// cpu / RAM (GB) — matches the design comp's presets verbatim. No disk: `tart set
// --disk-size` is grow-only and mf-golden already ships an ~80GB base disk, so sending
// a preset disk size (e.g. Light's 40GB) would ask tart to shrink it and fail the clone.
const PRESETS: Record<Preset, { cpu: number; memoryGb: number }> = {
  light: { cpu: 2, memoryGb: 4 },
  standard: { cpu: 4, memoryGb: 8 },
  heavy: { cpu: 8, memoryGb: 16 },
}

const LEASE_TTL_SECONDS = 600

// A create/duplicate clones fast but then cold-boots the guest. If `tart run` fails (disk
// full, resource limits) the VM never reaches `running`, so its optimistic "creating" row
// would otherwise spin forever with no error. Give each pending row a generous deadline —
// well past even a cold ~60s boot — after which it's dropped with a warning toast.
const CREATE_TIMEOUT_MS = 120_000

// Smooth transient health misses: the guest's /status check competes with the 3MB
// screenshot stream and occasionally times out, which would otherwise flap a running
// VM's status to "booting". Hold a previously-healthy VM healthy across a single miss;
// flip only after two consecutive misses. A never-healthy (booting) VM is unaffected.
function healthSmoother() {
  const seen = new Map<string, { healthy: boolean; miss: number }>()
  return {
    apply(v: Vm): Vm {
      const prev = seen.get(v.name)
      if (v.healthy) {
        seen.set(v.name, { healthy: true, miss: 0 })
        return v
      }
      const miss = (prev?.miss ?? 0) + 1
      const held = (prev?.healthy ?? false) && miss < 2
      seen.set(v.name, { healthy: held, miss })
      return held ? { ...v, healthy: true } : v
    },
    // Drop state for VMs no longer in the fleet so the map doesn't grow unbounded as VMs
    // are created and nuked over a long-running session.
    prune(names: Set<string>): void {
      for (const name of seen.keys()) if (!names.has(name)) seen.delete(name)
    },
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
  // Creation deadline (epoch ms) per pending name — drives the boot-failure timeout in
  // `tickTtl` so a VM whose `tart run` silently failed doesn't spin "creating" forever.
  const pendingSince = ref<Record<string, number>>({})
  // Live provisioning steppers for just-created VMs, keyed by short name. Pushed by the engine
  // over the fleet SSE stream (and fetched once on mount by VmProvisioning); drives the
  // provisioning panel until the guest is healthy, after which the record is dropped server-side.
  const provisioning = ref<Record<string, ProvisionRecord>>({})

  function markPending(name: string): void {
    if (!pending.value.includes(name)) pending.value = [...pending.value, name]
    pendingSince.value = { ...pendingSince.value, [name]: Date.now() + CREATE_TIMEOUT_MS }
  }
  function clearPending(names: string[]): void {
    if (!names.length) return
    const drop = new Set(names)
    pending.value = pending.value.filter((n) => !drop.has(n))
    const next = { ...pendingSince.value }
    for (const n of names) delete next[n]
    pendingSince.value = next
  }

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
  // Keep the authoritative expiry identity separately from the display countdown. An expired
  // lease can remain in server frames while reap retries a transient Tart deletion failure; the
  // timestamp lets us announce that failure once without losing the visible zero-second state.
  let leaseExpiries: Record<string, number> = {}
  const announcedLeaseExpiries = new Map<string, number>()

  // Per-VM resources (vCPU/RAM/disk), keyed by short name. Fetched on demand — by the
  // detail header when a VM is selected, and reused by the Resources tab — rather than
  // bundled into the polled `/vms` list, which doesn't carry it.
  const resources = ref<Record<string, Resources>>({})

  // Per-VM shared folders, keyed by short name. Fetched on demand by the Folders tab.
  const shares = ref<Record<string, Share[]>>({})

  // Terminal tab scrollback, keyed by short name — kept in the store (rather than
  // component-local state) so it survives the VmDetail `:key="ui.selectedVm"` remount
  // when switching VMs and back.
  const terminalHistory = ref<Record<string, ExecEntry[]>>({})

  async function execCommand(name: string, cmd: string): Promise<void> {
    let entry: ExecEntry
    try {
      const { stdout, stderr = '', exit_code } = await api.exec(name, cmd)
      const separator = stdout && stderr && !stdout.endsWith('\n') ? '\n' : ''
      entry = { cmd, out: `${stdout}${separator}${stderr}`, code: exit_code }
    } catch (e) {
      entry = { cmd, out: String(e), code: null }
      toast(`Failed to run command on ${name}`, '⚠')
    }
    terminalHistory.value = {
      ...terminalHistory.value,
      [name]: [...(terminalHistory.value[name] ?? []), entry],
    }
  }

  async function fetchShares(name: string): Promise<void> {
    try {
      const { shares: list } = await api.getShares(name)
      shares.value = { ...shares.value, [name]: list }
    } catch (e) {
      error.value = String(e)
    }
  }
  async function setShares(name: string, list: Share[]): Promise<void> {
    try {
      await api.setShares(name, list)
      await fetchShares(name)
      toast('Shared folders saved', '✓')
    } catch (e) {
      error.value = String(e)
      toast(`Failed to save shared folders for ${name}`, '⚠')
    }
  }
  async function restart(name: string): Promise<void> {
    toast(`Restarting ${name}…`, '↻')
    try {
      await api.restartVm(name)
      await refresh()
    } catch (e) {
      error.value = String(e)
      toast(`Failed to restart ${name}`, '⚠')
    }
  }

  async function fetchResources(name: string): Promise<void> {
    try {
      resources.value = { ...resources.value, [name]: await api.resources(name) }
    } catch (e) {
      error.value = String(e)
    }
  }

  // The server 409s if the VM is running (resources can only change while stopped) —
  // surfaced as a specific toast rather than the generic mutation-failed copy, so the
  // user knows exactly what to do. On success, re-fetch just the resources cache
  // (not a full `refresh()` — resources aren't part of the polled `/vms` list).
  async function setResources(
    name: string,
    patch: { cpu?: number; memory?: number; disk_size?: number; display?: string },
  ): Promise<void> {
    try {
      await api.setResources(name, patch)
      await fetchResources(name)
    } catch (e) {
      error.value = String(e)
      toast(
        String(e).includes('409')
          ? 'Stop the VM to change resources'
          : `Failed to update resources for ${name}`,
        '⚠',
      )
    }
  }

  // Monotonic refresh token. refresh() runs both from the 2s poll and directly after every
  // mutation, so two can be in flight at once; stamping each and bailing when a newer one has
  // started keeps a slow/older response from overwriting fresher state (last-writer-wins).
  let refreshSeq = 0

  function applyFleet(rawVms: Vm[]): void {
    const fleetVms = rawVms.filter((v) => v.name.startsWith('mf-') && v.name !== 'mf-golden')
    vms.value = fleetVms.map(smooth.apply)
    smooth.prune(new Set(fleetVms.map((v) => v.name)))
    error.value = null
    loaded.value = true
    // Rebuild the display countdown from the engine's persisted absolute expiry on every fleet
    // frame. This survives desktop restarts and corrects timer drift after sleep/backgrounding.
    // Preserve only optimistic leases for creates that have not appeared in Tart yet.
    const nextLeases: Record<string, number> = {}
    const nextExpiries: Record<string, number> = {}
    for (const name of pending.value) {
      if (!fleetVms.some((v) => short(v.name) === name) && leases.value[name] !== undefined) {
        nextLeases[name] = leases.value[name]
        if (leaseExpiries[name] !== undefined) nextExpiries[name] = leaseExpiries[name]
      }
    }
    const now = Date.now() / 1000
    for (const vm of fleetVms) {
      if (vm.lease_expires_at != null) {
        const name = short(vm.name)
        nextLeases[name] = Math.max(0, Math.ceil(vm.lease_expires_at - now))
        nextExpiries[name] = vm.lease_expires_at
        if (announcedLeaseExpiries.get(name) !== vm.lease_expires_at) {
          announcedLeaseExpiries.delete(name)
        }
      }
    }
    for (const name of announcedLeaseExpiries.keys()) {
      if (nextExpiries[name] === undefined) announcedLeaseExpiries.delete(name)
    }
    leases.value = nextLeases
    leaseExpiries = nextExpiries
    clearPending(
      pending.value.filter((n) =>
        vms.value.some((v) => short(v.name) === n && v.state === 'running'),
      ),
    )
  }

  async function refresh(): Promise<void> {
    const seq = ++refreshSeq
    try {
      const rawVms = await api.listVms()
      if (seq !== refreshSeq) return // a newer refresh superseded this one
      applyFleet(rawVms)
    } catch (e) {
      if (seq !== refreshSeq) return
      error.value = String(e)
      return
    }
  }

  // Snapshots change only after explicit snapshot mutations. Keeping them out of the
  // two-second fleet path removes a second `tart list` subprocess from every idle refresh.
  async function refreshSnapshots(): Promise<void> {
    try {
      snapshots.value = await api.listSnapshots()
    } catch {
      // Best effort: preserve the last-known list on a transient failure.
    }
  }

  function acceptFleetUpdate(update: FleetUpdate): void {
    refreshSeq++ // supersede any slower fallback refresh already in flight
    // Defensive: `watchFleet` normalizes the wire shape, but never let a malformed frame throw
    // here — the throw would fire AFTER the refreshSeq bump above, poisoning the fallback poll.
    applyFleet(update.vms ?? [])
    provisioning.value = update.provisioning ?? {}
  }

  async function fetchHost(): Promise<void> {
    if (host.value) return
    try {
      host.value = await api.host()
    } catch (e) {
      error.value = String(e)
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

  // Fan out a per-VM op with a concurrency cap so a bulk action doesn't spawn a burst of
  // tart subprocesses (the load that made the fleet flap). One refresh + one summary toast.
  async function runBulk(
    names: string[],
    fn: (name: string) => Promise<unknown>,
    verb: string,
  ): Promise<void> {
    const failed: string[] = []
    const queue = [...names]
    async function worker(): Promise<void> {
      while (queue.length) {
        const name = queue.shift() as string
        try {
          await fn(name)
        } catch {
          failed.push(name)
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(3, names.length) }, worker))
    await refresh()
    if (failed.length) {
      error.value = `${verb} failed for ${failed.join(', ')}`
      toast(
        `${verb} ${names.length - failed.length}/${names.length} — ${failed.length} failed`,
        '⚠',
      )
    } else {
      toast(`${verb} ${names.length} VMs`, '✓')
    }
  }
  const bulkSuspend = (names: string[]) => runBulk(names, (n) => api.suspend(n), 'Suspended')
  const bulkStop = (names: string[]) => runBulk(names, (n) => api.down(n), 'Stopped')
  const bulkResume = (names: string[]) => runBulk(names, (n) => api.resume(n), 'Resumed')
  const bulkNuke = (names: string[]) => runBulk(names, (n) => api.nuke(n), 'Deleted')
  const suspend = (name: string) => run(() => api.suspend(name), `Failed to suspend ${name}`)
  const resume = (name: string) => run(() => api.resume(name), `Failed to resume ${name}`)
  const rename = (oldName: string, newName: string) =>
    run(() => api.rename(oldName, newName), `Failed to rename ${oldName}`)
  async function deleteSnapshot(id: string): Promise<void> {
    try {
      await api.deleteSnapshot(id)
      await refreshSnapshots()
    } catch (e) {
      error.value = String(e)
      toast('Failed to delete snapshot', '⚠')
    }
  }

  async function restoreVM(name: string, snapshotId: string): Promise<void> {
    toast(`Restoring ${name}…`, '↺')
    try {
      await api.restore(name, snapshotId)
      await refresh()
      toast('Restored', '✓')
    } catch (e) {
      error.value = String(e)
      toast(`Failed to restore ${name}`, '⚠')
    }
  }

  async function snapshotVM(name: string, label: string): Promise<void> {
    toast(`Freezing state of ${name}…`, '◈')
    try {
      await api.snapshot(name, label)
      await Promise.all([refresh(), refreshSnapshots()])
      toast('Snapshot saved', '✓')
    } catch (e) {
      error.value = String(e)
      toast(`Failed to snapshot ${name}`, '⚠')
    }
  }

  async function duplicate(name: string): Promise<void> {
    const newName = `${name}-copy`
    // Optimistic: show the clone as "creating" immediately, like `create`. Only a
    // START toast — readiness is conveyed by the pending row flipping to "running" once
    // the polled list catches up, NOT a premature toast (the clone's `tart run` is
    // non-blocking, so the VM is still booting when `api.duplicate` resolves).
    markPending(newName)
    toast(`Duplicating ${name}…`, '⧉')
    try {
      await api.duplicate(name, newName)
      await refresh()
    } catch (e) {
      error.value = String(e)
      clearPending([newName])
      toast(`Failed to duplicate ${name}`, '⚠')
    }
  }

  async function create(): Promise<void> {
    // Block spin-up until the engine's first successful list. The UI hides the create affordances
    // until then, but the command palette can still reach create() — no-op with a nudge rather
    // than firing a POST at a sidecar that isn't up yet.
    if (!loaded.value) {
      toast('Engine still starting — hold on a moment', '⏳')
      return
    }
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
    markPending(name)
    // Focus the new VM immediately so the detail pane shows its provisioning stepper. selectOnly
    // collapses any prior multi-selection to just this VM. Cross-store call (ui imports fleet);
    // resolved lazily at call time so the module cycle never breaks.
    useUi().selectOnly(name)
    if (opts.ttl) {
      leases.value = { ...leases.value, [name]: LEASE_TTL_SECONDS }
      leaseExpiries = { ...leaseExpiries, [name]: Date.now() / 1000 + LEASE_TTL_SECONDS }
    }
    toast(snap ? `Cloning from ${snap.label}…` : `Creating ${name}…`, '⚡')

    try {
      await api.create(name, {
        ...(fromSnapshot ? { from_snapshot: fromSnapshot } : {}),
        ...(opts.ttl ? { ttl: LEASE_TTL_SECONDS } : {}),
        cpu: preset.cpu,
        memory: preset.memoryGb * 1024,
      })
      createOptions.value = { ...opts, name: '', source: 'golden', advancedOpen: false }
      await refresh()
    } catch (e) {
      error.value = String(e)
      clearPending([name])
      // Drop the focus we grabbed above unless the engine recorded a provisioning error to show
      // in the panel — otherwise the pane would strand on an empty selection.
      const ui = useUi()
      if (ui.selectedVm === name && !provisioning.value[name]) ui.selectVm(null)
      if (opts.ttl) {
        const nextLeases = { ...leases.value }
        delete nextLeases[name]
        leases.value = nextLeases
        const nextExpiries = { ...leaseExpiries }
        delete nextExpiries[name]
        leaseExpiries = nextExpiries
        announcedLeaseExpiries.delete(name)
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
    // Only reassign when there was something to count down — otherwise every idle tick would
    // hand `leases` a fresh empty object, dirtying the sidebar's `rows`/`filteredRows`
    // computeds (they read `store.leases`) and re-rendering the whole fleet list each second.
    if (Object.keys(leases.value).length > 0) leases.value = next
    if (expired.length) {
      for (const name of expired) {
        const expiry = leaseExpiries[name]
        if (expiry === undefined || announcedLeaseExpiries.get(name) !== expiry) {
          toast(`Lease expired — ${name}`, '⏱')
          if (expiry !== undefined) announcedLeaseExpiries.set(name, expiry)
        }
      }
      await refresh()
    }

    // Drop pending rows whose boot never landed (see CREATE_TIMEOUT_MS) so a failed
    // create surfaces as an error toast instead of spinning "creating" indefinitely.
    const now = Date.now()
    const stuck = Object.entries(pendingSince.value)
      .filter(([, deadline]) => now > deadline)
      .map(([name]) => name)
    if (stuck.length) {
      clearPending(stuck)
      for (const name of stuck) toast(`Creating ${name} timed out — check the logs`, '⚠')
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
    provisioning,
    selectedTab,
    createOptions,
    leases,
    resources,
    terminalHistory,
    execCommand,
    refresh,
    refreshSnapshots,
    acceptFleetUpdate,
    fetchHost,
    fetchResources,
    setResources,
    shares,
    fetchShares,
    setShares,
    restart,
    down,
    nuke,
    bulkSuspend,
    bulkStop,
    bulkResume,
    bulkNuke,
    suspend,
    resume,
    snapshotVM,
    restoreVM,
    duplicate,
    rename,
    deleteSnapshot,
    newFromSnapshot,
    create,
    tickTtl,
  }
})
