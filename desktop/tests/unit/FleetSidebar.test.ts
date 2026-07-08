import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import FleetSidebar from '../../src/components/FleetSidebar.vue'
import { api } from '../../src/shared/api'
import { useFleet } from '../../src/stores/fleet'

beforeEach(() => {
  setActivePinia(createPinia())
  // refresh() also lists snapshots now — default to empty for these VM-focused tests.
  vi.spyOn(api, 'listSnapshots').mockResolvedValue([])
})

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

  it('shows a disabled "creating" row for a pending VM', async () => {
    vi.spyOn(api, 'listVms').mockResolvedValue([])
    const store = useFleet()
    const wrapper = mount(FleetSidebar, { props: { selected: null } })
    await flushPromises()
    store.pending = ['building']
    await flushPromises()
    const rows = wrapper.findAll('[data-test="vm-row"]')
    expect(rows).toHaveLength(1)
    expect(rows[0].text()).toContain('building')
    expect(rows[0].text()).toContain('creating')
    expect(rows[0].attributes('disabled')).toBeDefined()
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
