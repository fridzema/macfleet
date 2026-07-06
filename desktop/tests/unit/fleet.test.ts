import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../src/shared/api'
import { useFleet } from '../../src/stores/fleet'

beforeEach(() => setActivePinia(createPinia()))

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
})
