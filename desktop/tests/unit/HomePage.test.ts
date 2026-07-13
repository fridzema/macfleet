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
  it('shows the engine-booting state (and no create action) until the engine connects', async () => {
    vi.spyOn(api, 'listVms').mockRejectedValue(new Error('connection refused'))
    const wrapper = mount(HomePage)
    await flushPromises()
    expect(wrapper.find('[data-test="engine-booting"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="empty-create"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('Starting engine')
    wrapper.unmount()
  })

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

  it('shows the provisioning stepper (not the detail pane) for a just-created VM still spinning up', async () => {
    vi.spyOn(api, 'listVms').mockResolvedValue([])
    vi.spyOn(api, 'provision').mockResolvedValue(null)
    const wrapper = mount(HomePage)
    const store = useFleet()
    const ui = useUi()
    await flushPromises()
    store.provisioning = {
      web: {
        name: 'web',
        steps: [{ key: 'boot', label: 'Boot guest', status: 'active' }],
        done: false,
        error: null,
      },
    }
    ui.selectVm('web')
    await flushPromises()
    expect(wrapper.find('[data-test="provisioning-panel"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="rename-display"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('keeps the selection while the new VM is pending even though it is not yet in the fleet list', async () => {
    vi.spyOn(api, 'listVms').mockResolvedValue([])
    vi.spyOn(api, 'provision').mockResolvedValue(null)
    const wrapper = mount(HomePage)
    const store = useFleet()
    const ui = useUi()
    await flushPromises()
    store.pending = ['web']
    ui.selectVm('web')
    await flushPromises()
    // a fleet update lands without the new VM — selection must survive
    store.vms = [{ name: 'mf-other', state: 'running', source: 'local', healthy: true }]
    await flushPromises()
    expect(ui.selectedVm).toBe('web')
    expect(wrapper.find('[data-test="provisioning-panel"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('swaps from the stepper to VmDetail once provisioning is done and the VM is live', async () => {
    vi.spyOn(api, 'listVms').mockResolvedValue([
      { name: 'mf-web', state: 'running', source: 'local', healthy: true },
    ])
    const wrapper = mount(HomePage)
    const store = useFleet()
    const ui = useUi()
    await flushPromises()
    store.provisioning = {
      web: {
        name: 'web',
        steps: [{ key: 'health', label: 'Guest health check', status: 'done' }],
        done: true,
        error: null,
      },
    }
    ui.selectVm('web')
    await flushPromises()
    expect(wrapper.find('[data-test="provisioning-panel"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="rename-display"]').text()).toBe('web')
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
