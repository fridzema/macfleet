import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { useDarkMode } from '../../src/composables/useDarkMode'
import { setToastScheduler, useToasts } from '../../src/composables/useToasts'
import HomePage from '../../src/pages/HomePage.vue'
import { api } from '../../src/shared/api'
import { useFleet } from '../../src/stores/fleet'
import { useUi } from '../../src/stores/ui'

vi.mock('../../src/composables/useDarkMode', () => ({
  useDarkMode: vi.fn(() => ({ isDark: ref(false), toggleDark: vi.fn() })),
}))

beforeEach(() => {
  setActivePinia(createPinia())
  setToastScheduler(() => {})
  useToasts().toasts.value = []
  vi.spyOn(api, 'listSnapshots').mockResolvedValue([])
  vi.spyOn(api, 'resources').mockResolvedValue({
    cpu: 4,
    memory_mb: 8192,
    disk_gb: 50,
    display: '1920x1080',
    state: 'running',
  })
})

afterEach(() => vi.restoreAllMocks())

describe('HomePage — empty states', () => {
  it('shows "No VMs yet" with a create action when the fleet is empty', async () => {
    vi.spyOn(api, 'listVms').mockResolvedValue([])
    const wrapper = mount(HomePage)
    await flushPromises()
    expect(wrapper.text()).toContain('No VMs yet')
    expect(wrapper.find('[data-test="empty-create"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('"Spin up your first VM" calls store.create', async () => {
    vi.spyOn(api, 'listVms').mockResolvedValue([])
    const store = useFleet()
    const create = vi.spyOn(store, 'create').mockResolvedValue()
    const wrapper = mount(HomePage)
    await flushPromises()
    await wrapper.find('[data-test="empty-create"]').trigger('click')
    expect(create).toHaveBeenCalled()
    wrapper.unmount()
  })

  it('shows "Select a VM to view it" with no create action when VMs exist but none is selected', async () => {
    vi.spyOn(api, 'listVms').mockResolvedValue([
      { name: 'mf-web', state: 'running', source: 'local', healthy: true },
    ])
    const wrapper = mount(HomePage)
    await flushPromises()
    expect(wrapper.text()).toContain('Select a VM to view it')
    expect(wrapper.find('[data-test="empty-create"]').exists()).toBe(false)
    wrapper.unmount()
  })
})

describe('HomePage — selection', () => {
  it('renders VmDetail for ui.selectedVm resolved against the live fleet', async () => {
    vi.spyOn(api, 'listVms').mockResolvedValue([
      { name: 'mf-web', state: 'running', source: 'local', healthy: true },
    ])
    const wrapper = mount(HomePage)
    const ui = useUi()
    await flushPromises()
    ui.selectVm('web')
    await flushPromises()
    expect(wrapper.find('[data-test="rename-display"]').text()).toBe('web')
    wrapper.unmount()
  })

  it('resolves a VM name that does not carry the mf- prefix unchanged (defensive passthrough)', async () => {
    vi.spyOn(api, 'listVms').mockResolvedValue([])
    const wrapper = mount(HomePage)
    const store = useFleet()
    const ui = useUi()
    await flushPromises()
    // store.refresh()'s own filter only keeps mf- names — set store.vms directly to
    // exercise the defensive passthrough for a name that never goes through it.
    store.vms = [{ name: 'standalone', state: 'running', source: 'local', healthy: true }]
    ui.selectVm('standalone')
    await flushPromises()
    expect(wrapper.find('[data-test="rename-display"]').text()).toBe('standalone')
    wrapper.unmount()
  })

  it('clears the selection once the selected VM disappears from the fleet', async () => {
    vi.spyOn(api, 'listVms').mockResolvedValue([
      { name: 'mf-web', state: 'running', source: 'local', healthy: true },
    ])
    const wrapper = mount(HomePage)
    const ui = useUi()
    const store = useFleet()
    await flushPromises()
    ui.selectVm('web')
    await flushPromises()
    expect(wrapper.find('[data-test="rename-display"]').exists()).toBe(true)

    store.vms = []
    await flushPromises()
    expect(ui.selectedVm).toBeNull()
    expect(wrapper.text()).toContain('No VMs yet')
    wrapper.unmount()
  })
})
