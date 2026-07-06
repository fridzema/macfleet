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

  it('refresh drops non-fleet VMs (base/OCI images)', async () => {
    vi.spyOn(api, 'listVms').mockResolvedValue([
      { name: 'mf-a', state: 'running', source: 'local', healthy: true },
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
