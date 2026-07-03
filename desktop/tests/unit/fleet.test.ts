import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useFleet } from '../../src/stores/fleet'
import { api } from '../../src/shared/api'

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

  it('up calls api then refreshes', async () => {
    const up = vi.spyOn(api, 'up').mockResolvedValue({})
    vi.spyOn(api, 'listVms').mockResolvedValue([])
    const s = useFleet()
    await s.up('web')
    expect(up).toHaveBeenCalledWith('web')
  })

  it('refresh records errors', async () => {
    vi.spyOn(api, 'listVms').mockRejectedValue(new Error('boom'))
    const s = useFleet()
    await s.refresh()
    expect(s.error).toContain('boom')
  })
})
