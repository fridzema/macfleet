import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import FleetSidebar from '../../src/components/FleetSidebar.vue'
import { useFleet } from '../../src/stores/fleet'
import { api } from '../../src/shared/api'

vi.spyOn(api, 'listVms').mockResolvedValue([])

beforeEach(() => setActivePinia(createPinia()))

describe('FleetSidebar', () => {
  it('renders a row per vm and emits select with short name', async () => {
    const store = useFleet()
    store.vms = [
      { name: 'mf-a', state: 'running', source: 'local', healthy: true },
      { name: 'mf-b', state: 'stopped', source: 'local', healthy: false },
    ]
    const wrapper = mount(FleetSidebar)
    const rows = wrapper.findAll('[data-test="vm-row"]')
    expect(rows).toHaveLength(2)
    await rows[0].trigger('click')
    expect(wrapper.emitted('select')?.[0]).toEqual(['a'])
  })
})
