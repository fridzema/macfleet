import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ResourcesTab from '../../src/components/vmtabs/ResourcesTab.vue'
import { setToastScheduler, useToasts } from '../../src/composables/useToasts'
import { api, type Resources, type Vm } from '../../src/shared/api'
import { useFleet } from '../../src/stores/fleet'

const vm = (overrides: Partial<Vm> = {}): Vm => ({
  name: 'mf-web',
  state: 'stopped',
  source: 'local',
  healthy: false,
  ...overrides,
})

const resources = (overrides: Partial<Resources> = {}): Resources => ({
  cpu: 4,
  memory_mb: 8192,
  disk_gb: 50,
  display: '1920x1080',
  state: 'stopped',
  ...overrides,
})

beforeEach(() => {
  setActivePinia(createPinia())
  setToastScheduler(() => {})
  useToasts().toasts.value = []
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ResourcesTab — cards', () => {
  it('renders the four metric cards from the store cache without fetching again', async () => {
    const store = useFleet()
    store.vms = [vm()]
    store.resources = { web: resources() }
    const fetch = vi.spyOn(api, 'resources')
    const wrapper = mount(ResourcesTab, { props: { name: 'web' } })

    expect(wrapper.find('[data-test="card-cpu"]').text()).toContain('4')
    expect(wrapper.find('[data-test="card-cpu"]').text()).toContain('vCPU')
    expect(wrapper.find('[data-test="card-memory"]').text()).toContain('8')
    expect(wrapper.find('[data-test="card-disk"]').text()).toContain('50')
    expect(wrapper.find('[data-test="card-display"]').text()).toContain('1920x1080')
    expect(fetch).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('fetches resources when not already cached', async () => {
    const store = useFleet()
    store.vms = [vm()]
    const fetch = vi.spyOn(api, 'resources').mockResolvedValue(resources())
    const wrapper = mount(ResourcesTab, { props: { name: 'web' } })
    await vi.waitFor(() => expect(wrapper.find('[data-test="card-cpu"]').exists()).toBe(true))
    expect(fetch).toHaveBeenCalledWith('web')
    wrapper.unmount()
  })

  it('does not fabricate a live utilization figure — bars/captions read "configured"', async () => {
    const store = useFleet()
    store.vms = [vm()]
    store.resources = { web: resources() }
    const wrapper = mount(ResourcesTab, { props: { name: 'web' } })

    const text = wrapper.text()
    expect(text).not.toContain('load')
    expect(text).not.toContain('used')
    expect(text).toContain('configured')
    wrapper.unmount()
  })
})

describe('ResourcesTab — running (locked)', () => {
  it('shows the locked banner and no inputs when the VM is running', () => {
    const store = useFleet()
    store.vms = [vm({ state: 'running', healthy: true })]
    store.resources = { web: resources({ state: 'running' }) }
    const wrapper = mount(ResourcesTab, { props: { name: 'web' } })

    expect(wrapper.find('[data-test="locked-banner"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="editable-banner"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="cpu-input"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="save-btn"]').exists()).toBe(false)
    wrapper.unmount()
  })
})

describe('ResourcesTab — stopped (editable)', () => {
  it('shows the editable banner and inputs when the VM is stopped', () => {
    const store = useFleet()
    store.vms = [vm()]
    store.resources = { web: resources() }
    const wrapper = mount(ResourcesTab, { props: { name: 'web' } })

    expect(wrapper.find('[data-test="editable-banner"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="locked-banner"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="cpu-input"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="save-btn"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('Save calls store.setResources with only the changed fields', async () => {
    const store = useFleet()
    store.vms = [vm()]
    store.resources = { web: resources() }
    const setResources = vi.spyOn(api, 'setResources').mockResolvedValue({})
    vi.spyOn(api, 'resources').mockResolvedValue(resources({ cpu: 6 }))
    const wrapper = mount(ResourcesTab, { props: { name: 'web' } })

    await wrapper.find('[data-test="cpu-input"]').setValue(6)
    await wrapper.find('[data-test="save-btn"]').trigger('click')
    await vi.waitFor(() => expect(setResources).toHaveBeenCalled())

    expect(setResources).toHaveBeenCalledWith('web', { cpu: 6 })
    wrapper.unmount()
  })

  it('editing only cpu on a VM whose memory_mb is not a multiple of 1024 does not emit a spurious memory patch', async () => {
    const store = useFleet()
    store.vms = [vm()]
    // 6000 MB rounds to 6 GB but 6*1024 = 6144 !== 6000 — a naive MB diff would flag it.
    store.resources = { web: resources({ memory_mb: 6000 }) }
    const setResources = vi.spyOn(api, 'setResources').mockResolvedValue({})
    vi.spyOn(api, 'resources').mockResolvedValue(resources({ memory_mb: 6000, cpu: 6 }))
    const wrapper = mount(ResourcesTab, { props: { name: 'web' } })

    await wrapper.find('[data-test="cpu-input"]').setValue(6)
    await wrapper.find('[data-test="save-btn"]').trigger('click')
    await vi.waitFor(() => expect(setResources).toHaveBeenCalled())

    expect(setResources).toHaveBeenCalledWith('web', { cpu: 6 })
    const patch = setResources.mock.calls[0]?.[1]
    expect(patch).not.toHaveProperty('memory')
    wrapper.unmount()
  })

  it('a 409 (VM running) surfaces a toast', async () => {
    const store = useFleet()
    store.vms = [vm()]
    store.resources = { web: resources() }
    vi.spyOn(api, 'setResources').mockRejectedValue(new Error('PUT /vms/web/resources -> 409'))
    const wrapper = mount(ResourcesTab, { props: { name: 'web' } })

    await wrapper.find('[data-test="cpu-input"]').setValue(8)
    await wrapper.find('[data-test="save-btn"]').trigger('click')

    await vi.waitFor(() =>
      expect(
        useToasts().toasts.value.some((t) => t.msg === 'Stop the VM to change resources'),
      ).toBe(true),
    )
    wrapper.unmount()
  })

  it('disk is grow-only — an attempt to shrink it snaps back to the current size', async () => {
    const store = useFleet()
    store.vms = [vm()]
    store.resources = { web: resources({ disk_gb: 50 }) }
    const setResources = vi.spyOn(api, 'setResources').mockResolvedValue({})
    const wrapper = mount(ResourcesTab, { props: { name: 'web' } })

    await wrapper.find('[data-test="disk-input"]').setValue(30)
    expect((wrapper.find('[data-test="disk-input"]').element as HTMLInputElement).value).toBe('50')

    await wrapper.find('[data-test="save-btn"]').trigger('click')
    // No other field changed, and disk was clamped back to its current value — nothing to save.
    expect(setResources).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('growing the disk sends disk_size', async () => {
    const store = useFleet()
    store.vms = [vm()]
    store.resources = { web: resources({ disk_gb: 50 }) }
    const setResources = vi.spyOn(api, 'setResources').mockResolvedValue({})
    vi.spyOn(api, 'resources').mockResolvedValue(resources({ disk_gb: 80 }))
    const wrapper = mount(ResourcesTab, { props: { name: 'web' } })

    await wrapper.find('[data-test="disk-input"]').setValue(80)
    await wrapper.find('[data-test="save-btn"]').trigger('click')

    await vi.waitFor(() => expect(setResources).toHaveBeenCalledWith('web', { disk_size: 80 }))
    wrapper.unmount()
  })

  it('editing memory and display sends both in the patch', async () => {
    const store = useFleet()
    store.vms = [vm()]
    store.resources = { web: resources() }
    const setResources = vi.spyOn(api, 'setResources').mockResolvedValue({})
    vi.spyOn(api, 'resources').mockResolvedValue(
      resources({ memory_mb: 16384, display: '2560x1440' }),
    )
    const wrapper = mount(ResourcesTab, { props: { name: 'web' } })

    await wrapper.find('[data-test="memory-input"]').setValue(16)
    await wrapper.find('[data-test="display-input"]').setValue('2560x1440')
    await wrapper.find('[data-test="save-btn"]').trigger('click')

    await vi.waitFor(() => expect(setResources).toHaveBeenCalled())
    expect(setResources).toHaveBeenCalledWith('web', { memory: 16384, display: '2560x1440' })
    wrapper.unmount()
  })

  it('resolves a VM name that does not carry the mf- prefix unchanged (defensive passthrough)', () => {
    const store = useFleet()
    store.vms = [vm({ name: 'standalone' })]
    store.resources = { standalone: resources() }
    const wrapper = mount(ResourcesTab, { props: { name: 'standalone' } })
    // Same rationale as elsewhere: 'stopped' -> editable banner, not locked.
    expect(wrapper.find('[data-test="editable-banner"]').exists()).toBe(true)
    wrapper.unmount()
  })
})
