import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import FleetSidebar from '../../src/components/FleetSidebar.vue'
import { api } from '../../src/shared/api'
import { useFleet } from '../../src/stores/fleet'

beforeEach(() => setActivePinia(createPinia()))

describe('FleetSidebar', () => {
  it('lists polled VMs and emits select with the short name', async () => {
    vi.spyOn(api, 'listVms').mockResolvedValue([
      { name: 'mf-a', state: 'running', source: 'local', healthy: true },
      { name: 'mf-b', state: 'stopped', source: 'local', healthy: false },
    ])
    const wrapper = mount(FleetSidebar, { props: { selected: null } })
    await flushPromises()
    const rows = wrapper.findAll('[data-test="vm-row"]')
    expect(rows).toHaveLength(2)
    await rows[0].trigger('click')
    expect(wrapper.emitted('select')?.[0]).toEqual(['a'])
    wrapper.unmount()
  })

  it('up form submits store.up with the entered name', async () => {
    vi.spyOn(api, 'listVms').mockResolvedValue([])
    const store = useFleet()
    const up = vi.spyOn(store, 'up').mockResolvedValue()
    const wrapper = mount(FleetSidebar, { props: { selected: null } })
    await wrapper.find('[data-test="up-name"]').setValue('web')
    await wrapper.find('[data-test="up-form"]').trigger('submit')
    expect(up).toHaveBeenCalledWith('web')
    wrapper.unmount()
  })
})
