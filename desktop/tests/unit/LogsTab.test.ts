import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import LogsTab from '../../src/components/vmtabs/LogsTab.vue'
import { api, type Vm } from '../../src/shared/api'
import { useFleet } from '../../src/stores/fleet'

const vm = (overrides: Partial<Vm> = {}): Vm => ({
  name: 'mf-web',
  state: 'running',
  source: 'local',
  healthy: true,
  ...overrides,
})

beforeEach(() => {
  setActivePinia(createPinia())
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('LogsTab — tailing', () => {
  it('polls api.logs and renders the lines while the VM is running', async () => {
    const store = useFleet()
    store.vms = [vm()]
    vi.spyOn(api, 'logs').mockResolvedValue({ lines: 'boot ok\nserver up' })
    const wrapper = mount(LogsTab, { props: { name: 'web' } })
    await vi.waitFor(() =>
      expect(wrapper.find('[data-test="logscroll"]').text()).toContain('server up'),
    )
    wrapper.unmount()
  })

  it('re-polls on the tail interval and picks up new lines', async () => {
    vi.useFakeTimers()
    const store = useFleet()
    store.vms = [vm()]
    const logs = vi.spyOn(api, 'logs').mockResolvedValue({ lines: 'line one' })
    const wrapper = mount(LogsTab, { props: { name: 'web' } })
    await flushPromises()
    expect(logs).toHaveBeenCalledWith('web')

    logs.mockResolvedValueOnce({ lines: 'line one\nline two' })
    await vi.advanceTimersByTimeAsync(2000)
    await flushPromises()
    expect(wrapper.find('[data-test="logscroll"]').text()).toContain('line two')
    wrapper.unmount()
  })

  it('shows "VM not running" and does not poll when the VM is stopped', async () => {
    const store = useFleet()
    store.vms = [vm({ state: 'stopped', healthy: false })]
    const logs = vi.spyOn(api, 'logs').mockResolvedValue({ lines: 'x' })
    const wrapper = mount(LogsTab, { props: { name: 'web' } })
    await flushPromises()
    expect(logs).not.toHaveBeenCalled()
    expect(wrapper.find('[data-test="not-running"]').text()).toBe('VM not running')
    wrapper.unmount()
  })
})

describe('LogsTab — pause', () => {
  it('pause toggle stops polling until resumed', async () => {
    vi.useFakeTimers()
    const store = useFleet()
    store.vms = [vm()]
    const logs = vi.spyOn(api, 'logs').mockResolvedValue({ lines: 'boot ok' })
    const wrapper = mount(LogsTab, { props: { name: 'web' } })
    await flushPromises()
    const callsBefore = logs.mock.calls.length

    await wrapper.find('[data-test="pause-btn"]').trigger('click')
    await vi.advanceTimersByTimeAsync(4000)
    expect(logs.mock.calls.length).toBe(callsBefore)

    await wrapper.find('[data-test="pause-btn"]').trigger('click')
    await vi.advanceTimersByTimeAsync(2000)
    expect(logs.mock.calls.length).toBeGreaterThan(callsBefore)
    wrapper.unmount()
  })
})

describe('LogsTab — level coloring', () => {
  it('colors a line with a recognized level token and leaves the rest of the line intact', async () => {
    const store = useFleet()
    store.vms = [vm()]
    vi.spyOn(api, 'logs').mockResolvedValue({ lines: '12:00:01 ERR disk write failed' })
    const wrapper = mount(LogsTab, { props: { name: 'web' } })
    await vi.waitFor(() => expect(wrapper.find('[data-test="log-level"]').exists()).toBe(true))

    const level = wrapper.find('[data-test="log-level"]')
    expect(level.text()).toBe('ERR')
    expect(level.attributes('style')).toContain('color: rgb(240, 85, 90)')
    expect(wrapper.find('[data-test="log-line"]').text()).toContain('disk write failed')
    wrapper.unmount()
  })

  it('renders a line with no recognizable level token plain, unmodified', async () => {
    const store = useFleet()
    store.vms = [vm()]
    vi.spyOn(api, 'logs').mockResolvedValue({ lines: 'boot ok' })
    const wrapper = mount(LogsTab, { props: { name: 'web' } })
    await vi.waitFor(() => expect(wrapper.find('[data-test="log-line"]').exists()).toBe(true))

    const line = wrapper.find('[data-test="log-line"]')
    expect(line.text()).toBe('boot ok')
    expect(line.find('[data-test="log-level"]').exists()).toBe(false)
    wrapper.unmount()
  })
})
