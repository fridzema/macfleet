import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useToasts } from '../../src/composables/useToasts'
import { api } from '../../src/shared/api'
import { useFleet } from '../../src/stores/fleet'

beforeEach(() => {
  setActivePinia(createPinia())
  // Every refresh() now also lists snapshots — default to empty so tests that only
  // care about vms don't need to mock it explicitly.
  vi.spyOn(api, 'listSnapshots').mockResolvedValue([])
  // Toasts are a module-level singleton (shared across the fleet/ui stores) — clear
  // between tests so assertions don't see toasts left over from a previous test.
  useToasts().toasts.value = []
})

describe('fleet store', () => {
  it('refresh loads vms', async () => {
    vi.spyOn(api, 'listVms').mockResolvedValue([
      { name: 'mf-a', state: 'running', source: 'local', healthy: true },
    ])
    const s = useFleet()
    await s.refresh()
    expect(s.vms).toHaveLength(1)
    expect(s.error).toBeNull()
  })

  it('refresh drops non-fleet VMs (base/OCI images) and the golden template', async () => {
    vi.spyOn(api, 'listVms').mockResolvedValue([
      { name: 'mf-a', state: 'running', source: 'local', healthy: true },
      { name: 'mf-golden', state: 'stopped', source: 'local', healthy: false },
      { name: 'cua-tahoe', state: 'stopped', source: 'local', healthy: false },
      {
        name: 'ghcr.io/cirruslabs/macos-tahoe-base:latest',
        state: 'stopped',
        source: 'OCI',
        healthy: false,
      },
    ])
    const s = useFleet()
    await s.refresh()
    expect(s.vms).toHaveLength(1)
    expect(s.vms[0].name).toBe('mf-a')
  })

  it('up calls api then refreshes', async () => {
    const up = vi.spyOn(api, 'up').mockResolvedValue({})
    vi.spyOn(api, 'listVms').mockResolvedValue([])
    const s = useFleet()
    await s.up('web')
    expect(up).toHaveBeenCalledWith('web')
  })

  it('marks a VM pending immediately, before the up call resolves', async () => {
    let release = () => {}
    vi.spyOn(api, 'up').mockImplementation(
      () =>
        new Promise((r) => {
          release = () => r({})
        }),
    )
    vi.spyOn(api, 'listVms').mockResolvedValue([])
    const s = useFleet()
    const p = s.up('web')
    // pending is set synchronously so the sidebar shows a "creating" row at once
    expect(s.pending).toContain('web')
    release()
    await p
  })

  it('prunes pending once the VM shows up running', async () => {
    vi.spyOn(api, 'up').mockResolvedValue({})
    vi.spyOn(api, 'listVms').mockResolvedValue([
      { name: 'mf-web', state: 'running', source: 'local', healthy: false },
    ])
    const s = useFleet()
    await s.up('web')
    expect(s.pending).not.toContain('web')
    expect(s.vms.map((v) => v.name)).toContain('mf-web')
  })

  it('keeps pending while the VM is not yet running', async () => {
    vi.spyOn(api, 'up').mockResolvedValue({})
    vi.spyOn(api, 'listVms').mockResolvedValue([
      { name: 'mf-web', state: 'stopped', source: 'local', healthy: false },
    ])
    const s = useFleet()
    await s.up('web')
    expect(s.pending).toContain('web')
  })

  it('drops pending when up fails', async () => {
    vi.spyOn(api, 'up').mockRejectedValue(new Error('boom'))
    vi.spyOn(api, 'listVms').mockResolvedValue([])
    const s = useFleet()
    await s.up('web')
    expect(s.pending).not.toContain('web')
    expect(s.error).toContain('boom')
  })

  it('holds a running VM healthy across a single health miss', async () => {
    const vm = (healthy: boolean) => [{ name: 'mf-a', state: 'running', source: 'local', healthy }]
    const list = vi.spyOn(api, 'listVms')
    const s = useFleet()
    list.mockResolvedValue(vm(true))
    await s.refresh()
    expect(s.vms[0].healthy).toBe(true)
    list.mockResolvedValue(vm(false))
    await s.refresh()
    expect(s.vms[0].healthy).toBe(true) // single miss is smoothed over
    await s.refresh()
    expect(s.vms[0].healthy).toBe(false) // two consecutive misses -> unhealthy
  })

  it('does not fabricate health for a never-healthy (booting) VM', async () => {
    vi.spyOn(api, 'listVms').mockResolvedValue([
      { name: 'mf-a', state: 'running', source: 'local', healthy: false },
    ])
    const s = useFleet()
    await s.refresh()
    expect(s.vms[0].healthy).toBe(false)
  })

  it('up surfaces API errors on error instead of rejecting', async () => {
    vi.spyOn(api, 'up').mockRejectedValue(new Error('409'))
    const refresh = vi.spyOn(api, 'listVms').mockResolvedValue([])
    refresh.mockClear() // call count accumulates across this file's shared spy
    const s = useFleet()
    await expect(s.up('test')).resolves.toBeUndefined()
    expect(s.error).toContain('409')
    // a failed up must not clear the error via a follow-up refresh
    expect(refresh).not.toHaveBeenCalled()
  })

  it('refresh records errors', async () => {
    vi.spyOn(api, 'listVms').mockRejectedValue(new Error('boom'))
    const s = useFleet()
    await s.refresh()
    expect(s.error).toContain('boom')
  })

  it('refresh also loads snapshots', async () => {
    vi.spyOn(api, 'listVms').mockResolvedValue([])
    vi.spyOn(api, 'listSnapshots').mockResolvedValue([
      { id: 'web-golden', vm: 'web', label: 'golden', size: 12.5 },
    ])
    const s = useFleet()
    await s.refresh()
    expect(s.snapshots).toEqual([{ id: 'web-golden', vm: 'web', label: 'golden', size: 12.5 }])
  })
})

describe('fleet store — host', () => {
  it('fetchHost fetches once and caches', async () => {
    const host = vi.spyOn(api, 'host').mockResolvedValue({
      total_mem_gb: 32,
      cpu_count: 8,
      name: 'MacBook',
    })
    const s = useFleet()
    await s.fetchHost()
    await s.fetchHost()
    expect(host).toHaveBeenCalledTimes(1)
    expect(s.host).toEqual({ total_mem_gb: 32, cpu_count: 8, name: 'MacBook' })
  })

  it('fetchHost sets error on failure', async () => {
    vi.spyOn(api, 'host').mockRejectedValue(new Error('unreachable'))
    const s = useFleet()
    await s.fetchHost()
    expect(s.error).toContain('unreachable')
    expect(s.host).toBeNull()
  })
})

describe('fleet store — lifecycle mutations', () => {
  beforeEach(() => {
    vi.spyOn(api, 'listVms').mockResolvedValue([])
  })

  it('down surfaces API errors on error without toasting (no user-facing copy for it)', async () => {
    vi.spyOn(api, 'down').mockRejectedValue(new Error('409'))
    const s = useFleet()
    await s.down('web')
    expect(s.error).toContain('409')
    expect(useToasts().toasts.value).toEqual([])
  })

  it('suspend calls api.suspend then refreshes', async () => {
    const suspend = vi.spyOn(api, 'suspend').mockResolvedValue({})
    const s = useFleet()
    await s.suspend('web')
    expect(suspend).toHaveBeenCalledWith('web')
    expect(s.error).toBeNull()
  })

  it('suspend sets error and toasts on failure', async () => {
    vi.spyOn(api, 'suspend').mockRejectedValue(new Error('409'))
    const s = useFleet()
    await s.suspend('web')
    expect(s.error).toContain('409')
    expect(
      useToasts().toasts.value.some((t) => t.msg.includes('suspend') && t.msg.includes('web')),
    ).toBe(true)
  })

  it('resume calls api.resume then refreshes', async () => {
    const resume = vi.spyOn(api, 'resume').mockResolvedValue({})
    const s = useFleet()
    await s.resume('web')
    expect(resume).toHaveBeenCalledWith('web')
    expect(s.error).toBeNull()
  })

  it('resume sets error and toasts on failure', async () => {
    vi.spyOn(api, 'resume').mockRejectedValue(new Error('409'))
    const s = useFleet()
    await s.resume('web')
    expect(s.error).toContain('409')
    expect(useToasts().toasts.value.some((t) => t.msg.includes('resume'))).toBe(true)
  })

  it('rename calls api.rename(old,new) then refreshes', async () => {
    const rename = vi.spyOn(api, 'rename').mockResolvedValue({})
    const s = useFleet()
    await s.rename('web', 'prod')
    expect(rename).toHaveBeenCalledWith('web', 'prod')
    expect(s.error).toBeNull()
  })

  it('rename sets error and toasts on failure', async () => {
    vi.spyOn(api, 'rename').mockRejectedValue(new Error('409'))
    const s = useFleet()
    await s.rename('web', 'prod')
    expect(s.error).toContain('409')
    expect(useToasts().toasts.value.some((t) => t.msg.includes('rename'))).toBe(true)
  })

  it('deleteSnapshot calls api.deleteSnapshot(id) then refreshes', async () => {
    const del = vi.spyOn(api, 'deleteSnapshot').mockResolvedValue({})
    const s = useFleet()
    await s.deleteSnapshot('web-golden')
    expect(del).toHaveBeenCalledWith('web-golden')
    expect(s.error).toBeNull()
  })

  it('deleteSnapshot sets error and toasts on failure', async () => {
    vi.spyOn(api, 'deleteSnapshot').mockRejectedValue(new Error('409'))
    const s = useFleet()
    await s.deleteSnapshot('web-golden')
    expect(s.error).toContain('409')
    expect(useToasts().toasts.value.some((t) => t.msg.includes('delete snapshot'))).toBe(true)
  })

  it('snapshotVM toasts start + calls api.snapshot + refreshes + toasts success', async () => {
    const snap = vi.spyOn(api, 'snapshot').mockResolvedValue({ snapshot_id: 'web-golden' })
    const s = useFleet()
    await s.snapshotVM('web', 'golden')
    expect(snap).toHaveBeenCalledWith('web', 'golden')
    const msgs = useToasts().toasts.value.map((t) => t.msg)
    expect(msgs).toContain('Freezing state of web…')
    expect(msgs).toContain('Snapshot saved')
    expect(s.error).toBeNull()
  })

  it('snapshotVM sets error and toasts on failure', async () => {
    vi.spyOn(api, 'snapshot').mockRejectedValue(new Error('409'))
    const s = useFleet()
    await s.snapshotVM('web', 'golden')
    expect(s.error).toContain('409')
    expect(useToasts().toasts.value.some((t) => t.msg.includes('Failed to snapshot web'))).toBe(
      true,
    )
  })

  it('duplicate marks the copy pending immediately, then calls api.duplicate + refreshes', async () => {
    let release = () => {}
    vi.spyOn(api, 'duplicate').mockImplementation(
      () =>
        new Promise((r) => {
          release = () => r({})
        }),
    )
    const s = useFleet()
    const p = s.duplicate('web')
    expect(s.pending).toContain('web-copy')
    release()
    await p
    expect(s.error).toBeNull()
    expect(useToasts().toasts.value.some((t) => t.msg === 'web-copy ready')).toBe(true)
  })

  it('duplicate drops the pending copy and toasts on failure', async () => {
    vi.spyOn(api, 'duplicate').mockRejectedValue(new Error('409'))
    const s = useFleet()
    await s.duplicate('web')
    expect(s.pending).not.toContain('web-copy')
    expect(s.error).toContain('409')
    expect(useToasts().toasts.value.some((t) => t.msg.includes('Failed to duplicate web'))).toBe(
      true,
    )
  })
})

describe('fleet store — create (options -> api args)', () => {
  beforeEach(() => {
    vi.spyOn(api, 'listVms').mockResolvedValue([])
  })

  it('maps the light preset from golden with no ttl', async () => {
    const create = vi.spyOn(api, 'create').mockResolvedValue({})
    const s = useFleet()
    s.createOptions.name = 'web'
    s.createOptions.preset = 'light'
    s.createOptions.source = 'golden'
    s.createOptions.ttl = false
    await s.create()
    expect(create).toHaveBeenCalledWith('web', {
      from_snapshot: undefined,
      ttl: undefined,
      cpu: 2,
      memory: 4096,
      disk: 40,
    })
  })

  it('maps the standard preset with ttl checked', async () => {
    const create = vi.spyOn(api, 'create').mockResolvedValue({})
    const s = useFleet()
    s.createOptions.name = 'web'
    s.createOptions.preset = 'standard'
    s.createOptions.source = 'golden'
    s.createOptions.ttl = true
    await s.create()
    expect(create).toHaveBeenCalledWith('web', {
      from_snapshot: undefined,
      ttl: 600,
      cpu: 4,
      memory: 8192,
      disk: 50,
    })
    expect(s.leases.web).toBe(600)
  })

  it('maps the heavy preset from a snapshot source, and toasts "Cloning from <label>"', async () => {
    const create = vi.spyOn(api, 'create').mockResolvedValue({})
    const s = useFleet()
    s.snapshots = [{ id: 'web-golden', vm: 'web', label: 'golden', size: 10 }]
    s.createOptions.name = 'web'
    s.createOptions.preset = 'heavy'
    s.createOptions.source = 'web-golden'
    s.createOptions.ttl = false
    await s.create()
    expect(create).toHaveBeenCalledWith('web', {
      from_snapshot: 'web-golden',
      ttl: undefined,
      cpu: 8,
      memory: 16384,
      disk: 80,
    })
    expect(useToasts().toasts.value.some((t) => t.msg === 'Cloning from golden…')).toBe(true)
  })

  it('marks the vm pending immediately and clears createOptions.name on success', async () => {
    let release = () => {}
    vi.spyOn(api, 'create').mockImplementation(
      () =>
        new Promise((r) => {
          release = () => r({})
        }),
    )
    const s = useFleet()
    s.createOptions.name = 'web'
    s.createOptions.advancedOpen = true
    const p = s.create()
    expect(s.pending).toContain('web')
    release()
    await p
    expect(s.createOptions.name).toBe('')
    expect(s.createOptions.advancedOpen).toBe(false)
  })

  it('falls back to a generated name when none is given', async () => {
    const create = vi.spyOn(api, 'create').mockResolvedValue({})
    const s = useFleet()
    s.createOptions.name = ''
    await s.create()
    // The api.create spy accumulates calls across this describe block, so index the
    // last call rather than assuming this is the first.
    expect(create.mock.calls.at(-1)?.[0]).toMatch(/^vm-[0-9a-f]{4}$/)
  })

  it('drops pending + lease and toasts on failure', async () => {
    vi.spyOn(api, 'create').mockRejectedValue(new Error('409'))
    const s = useFleet()
    s.createOptions.name = 'web'
    s.createOptions.ttl = true
    await s.create()
    expect(s.pending).not.toContain('web')
    expect(s.leases.web).toBeUndefined()
    expect(s.error).toContain('409')
    expect(useToasts().toasts.value.some((t) => t.msg.includes('Failed to create web'))).toBe(true)
  })

  it('drops pending and toasts on failure when no ttl was set (no lease to clean up)', async () => {
    vi.spyOn(api, 'create').mockRejectedValue(new Error('409'))
    const s = useFleet()
    s.createOptions.name = 'web'
    s.createOptions.ttl = false
    await s.create()
    expect(s.pending).not.toContain('web')
    expect(s.leases.web).toBeUndefined()
    expect(s.error).toContain('409')
  })

  it('newFromSnapshot sets createOptions.source to the snapshot id and creates', async () => {
    const create = vi.spyOn(api, 'create').mockResolvedValue({})
    const s = useFleet()
    await s.newFromSnapshot({ id: 'web-golden', vm: 'web', label: 'golden', size: 10 })
    expect(s.createOptions.source).toBe('web-golden')
    const [name, opts] = create.mock.calls.at(-1) as [string, unknown]
    expect(name).toMatch(/^golden-[0-9a-f]{3}$/)
    expect(opts).toMatchObject({ from_snapshot: 'web-golden' })
  })
})

describe('fleet store — TTL countdown', () => {
  beforeEach(() => {
    vi.spyOn(api, 'listVms').mockResolvedValue([])
  })

  it('decrements a lease by one per tick', async () => {
    const s = useFleet()
    s.leases.web = 3
    await s.tickTtl()
    expect(s.leases.web).toBe(2)
  })

  it('expires a lease at 0, removes it, toasts, and refreshes', async () => {
    const listVms = vi.spyOn(api, 'listVms').mockResolvedValue([])
    const s = useFleet()
    s.leases.web = 1
    listVms.mockClear() // call count accumulates across this file's shared spy
    await s.tickTtl()
    expect(s.leases.web).toBeUndefined()
    expect(listVms).toHaveBeenCalledTimes(1)
    expect(useToasts().toasts.value.some((t) => t.msg === 'Lease expired — web')).toBe(true)
  })

  it('leaves unrelated leases untouched when one expires', async () => {
    const s = useFleet()
    s.leases.web = 1
    s.leases.db = 5
    await s.tickTtl()
    expect(s.leases.web).toBeUndefined()
    expect(s.leases.db).toBe(4)
  })
})
