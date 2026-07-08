import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ResourcesTab from '../../src/components/vmtabs/ResourcesTab.vue'
import { setToastScheduler, useToasts } from '../../src/composables/useToasts'
import { api, type Metrics, type Resources, type Vm } from '../../src/shared/api'
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

const metrics = (overrides: Partial<Metrics> = {}): Metrics => ({
  cpu_pct: 42,
  mem_used_mb: 4096,
  mem_total_mb: 8192,
  ...overrides,
})

beforeEach(() => {
  setActivePinia(createPinia())
  setToastScheduler(() => {})
  useToasts().toasts.value = []
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
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

describe('ResourcesTab — live metrics', () => {
  it('polls api.metrics while the VM is running and drives the CPU/Memory bar + captions', async () => {
    vi.useFakeTimers()
    const store = useFleet()
    store.vms = [vm({ state: 'running', healthy: true })]
    store.resources = { web: resources({ state: 'running' }) }
    const fetchMetrics = vi.spyOn(api, 'metrics').mockResolvedValue(metrics())
    const wrapper = mount(ResourcesTab, { props: { name: 'web' } })
    await flushPromises()

    expect(fetchMetrics).toHaveBeenCalledWith('web')
    expect(wrapper.find('[data-test="card-cpu"]').text()).toContain('42% load')
    expect((wrapper.find('[data-test="cpu-bar"]').element as HTMLElement).style.width).toBe('42%')
    expect(wrapper.find('[data-test="card-memory"]').text()).toContain('4 / 8 GB used')
    expect((wrapper.find('[data-test="memory-bar"]').element as HTMLElement).style.width).toBe(
      '50%',
    )

    fetchMetrics.mockClear()
    await vi.advanceTimersByTimeAsync(3000)
    expect(fetchMetrics).toHaveBeenCalledWith('web')
    wrapper.unmount()
  })

  it('does not poll metrics when the VM is not running — renders the configured fallback', async () => {
    const store = useFleet()
    store.vms = [vm({ state: 'stopped' })]
    store.resources = { web: resources() }
    const fetchMetrics = vi.spyOn(api, 'metrics')
    const wrapper = mount(ResourcesTab, { props: { name: 'web' } })
    await flushPromises()

    expect(fetchMetrics).not.toHaveBeenCalled()
    expect(wrapper.find('[data-test="card-cpu"]').text()).toContain('configured')
    expect(wrapper.find('[data-test="card-memory"]').text()).toContain('configured')
    wrapper.unmount()
  })

  it('falls back to the configured bars/captions when a metrics fetch rejects', async () => {
    const store = useFleet()
    store.vms = [vm({ state: 'running', healthy: true })]
    store.resources = { web: resources({ state: 'running' }) }
    vi.spyOn(api, 'metrics').mockRejectedValue(new Error('GET /vms/web/metrics -> 500'))
    const wrapper = mount(ResourcesTab, { props: { name: 'web' } })
    await flushPromises()

    expect(wrapper.find('[data-test="card-cpu"]').text()).toContain('configured')
    expect(wrapper.find('[data-test="card-memory"]').text()).toContain('configured')
    expect(wrapper.text()).not.toContain('load')
    wrapper.unmount()
  })

  it('stops polling metrics on unmount', async () => {
    vi.useFakeTimers()
    const store = useFleet()
    store.vms = [vm({ state: 'running', healthy: true })]
    store.resources = { web: resources({ state: 'running' }) }
    const fetchMetrics = vi.spyOn(api, 'metrics').mockResolvedValue(metrics())
    const wrapper = mount(ResourcesTab, { props: { name: 'web' } })
    await flushPromises()
    expect(fetchMetrics).toHaveBeenCalledTimes(1)

    wrapper.unmount()
    fetchMetrics.mockClear()
    await vi.advanceTimersByTimeAsync(10000)
    expect(fetchMetrics).not.toHaveBeenCalled()
  })

  it('restarts polling against the new VM on switch and stops targeting the old one', async () => {
    vi.useFakeTimers()
    const store = useFleet()
    store.vms = [
      vm({ name: 'mf-web', state: 'running', healthy: true }),
      vm({ name: 'mf-db', state: 'running', healthy: true }),
    ]
    store.resources = {
      web: resources({ state: 'running' }),
      db: resources({ state: 'running', cpu: 2 }),
    }
    const fetchMetrics = vi.spyOn(api, 'metrics').mockResolvedValue(metrics())
    const wrapper = mount(ResourcesTab, { props: { name: 'web' } })
    await flushPromises()
    expect(fetchMetrics).toHaveBeenCalledWith('web')

    fetchMetrics.mockClear()
    await wrapper.setProps({ name: 'db' })
    await flushPromises()
    expect(fetchMetrics).toHaveBeenCalledWith('db')

    fetchMetrics.mockClear()
    await vi.advanceTimersByTimeAsync(3000)
    expect(fetchMetrics).toHaveBeenCalledWith('db')
    expect(fetchMetrics).not.toHaveBeenCalledWith('web')
    wrapper.unmount()
  })

  it('discards a stale metrics response that resolves late after switching to another running VM', async () => {
    const store = useFleet()
    store.vms = [
      vm({ name: 'mf-web', state: 'running', healthy: true }),
      vm({ name: 'mf-db', state: 'running', healthy: true }),
    ]
    store.resources = {
      web: resources({ state: 'running' }),
      db: resources({ state: 'running', cpu: 2 }),
    }
    let resolveOld: (v: Metrics) => void = () => {}
    vi.spyOn(api, 'metrics')
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOld = resolve
          }),
      )
      .mockResolvedValue(metrics({ cpu_pct: 7, mem_used_mb: 1024, mem_total_mb: 8192 }))
    const wrapper = mount(ResourcesTab, { props: { name: 'web' } })
    await flushPromises()
    // 'web' poll is now in flight, unresolved.

    await wrapper.setProps({ name: 'db' })
    await flushPromises()
    expect(wrapper.find('[data-test="card-cpu"]').text()).toContain('7% load')

    // The stale 'web' request finally settles — its data must not clobber 'db's card.
    resolveOld(metrics({ cpu_pct: 99, mem_used_mb: 9999, mem_total_mb: 9999 }))
    await flushPromises()

    expect(wrapper.find('[data-test="card-cpu"]').text()).toContain('7% load')
    expect(wrapper.find('[data-test="card-cpu"]').text()).not.toContain('99')
    wrapper.unmount()
  })

  it('discards a stale metrics response that resolves late after the VM has stopped', async () => {
    const store = useFleet()
    store.vms = [vm({ name: 'mf-web', state: 'running', healthy: true })]
    store.resources = { web: resources({ state: 'running' }) }
    let resolveOld: (v: Metrics) => void = () => {}
    vi.spyOn(api, 'metrics').mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve
        }),
    )
    const wrapper = mount(ResourcesTab, { props: { name: 'web' } })
    await flushPromises()
    // Poll is in flight when the VM stops.

    store.vms = [vm({ name: 'mf-web', state: 'stopped' })]
    await flushPromises()
    expect(wrapper.find('[data-test="card-cpu"]').text()).toContain('configured')

    resolveOld(metrics({ cpu_pct: 99, mem_used_mb: 9999, mem_total_mb: 9999 }))
    await flushPromises()

    expect(wrapper.find('[data-test="card-cpu"]').text()).toContain('configured')
    expect(wrapper.find('[data-test="card-cpu"]').text()).not.toContain('99')
    wrapper.unmount()
  })
})
