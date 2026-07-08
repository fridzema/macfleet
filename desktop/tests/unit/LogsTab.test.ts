import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import LogsTab from '../../src/components/vmtabs/LogsTab.vue'
import { api, type Vm } from '../../src/shared/api'
import { useFleet } from '../../src/stores/fleet'

// Partial-mock 'vue' so we can gate a single `nextTick()` call from inside
// LogsTab's `scrollToBottom` — see the "post-unmount" test below.
vi.mock('vue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue')>()
  return { ...actual, nextTick: vi.fn(actual.nextTick) }
})

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

  it('resolves a VM name that does not carry the mf- prefix unchanged (defensive passthrough)', async () => {
    const store = useFleet()
    store.vms = [vm({ name: 'standalone' })]
    vi.spyOn(api, 'logs').mockResolvedValue({ lines: 'boot ok' })
    const wrapper = mount(LogsTab, { props: { name: 'standalone' } })
    await vi.waitFor(() => expect(wrapper.find('[data-test="not-running"]').exists()).toBe(false))
    wrapper.unmount()
  })

  it('renders the error inline when api.logs rejects while the VM is running', async () => {
    const store = useFleet()
    store.vms = [vm()]
    vi.spyOn(api, 'logs').mockRejectedValue(new Error('GET /vms/web/logs -> 500'))
    const wrapper = mount(LogsTab, { props: { name: 'web' } })
    await vi.waitFor(() => expect(wrapper.find('[data-test="logscroll"]').text()).toContain('500'))
    wrapper.unmount()
  })

  it('re-tails from scratch when the name prop changes to another running VM', async () => {
    const store = useFleet()
    store.vms = [vm({ name: 'mf-web' }), vm({ name: 'mf-db' })]
    const logs = vi.spyOn(api, 'logs').mockResolvedValue({ lines: 'web logs' })
    const wrapper = mount(LogsTab, { props: { name: 'web' } })
    await flushPromises()
    expect(logs).toHaveBeenCalledWith('web')

    logs.mockResolvedValue({ lines: 'db logs' })
    await wrapper.setProps({ name: 'db' })
    await flushPromises()
    expect(logs).toHaveBeenCalledWith('db')
    expect(wrapper.find('[data-test="logscroll"]').text()).toContain('db logs')
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

describe('LogsTab — post-unmount', () => {
  it('scrollToBottom does not throw when its flush:post watcher resumes after unmount', async () => {
    vi.useFakeTimers()
    const store = useFleet()
    store.vms = [vm()]
    const logs = vi.spyOn(api, 'logs').mockResolvedValue({ lines: 'boot ok' })
    const wrapper = mount(LogsTab, { props: { name: 'web' } })
    await vi.advanceTimersByTimeAsync(0)
    expect(wrapper.find('[data-test="logscroll"]').text()).toContain('boot ok')

    // Gate the *next* `nextTick()` call made from inside scrollToBottom so we can unmount
    // the component in the window between its `await nextTick()` and resumption — the
    // exact race the `if (el)` guard protects against.
    let releaseGate!: () => void
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve
    })
    vi.mocked(nextTick).mockImplementationOnce(() => gate as unknown as Promise<void>)

    // Append a log line: text.value changes, logLines changes, the flush:'post' watcher
    // fires and calls scrollToBottom, which suspends on our gated nextTick().
    logs.mockResolvedValueOnce({ lines: 'boot ok\nline two' })
    await vi.advanceTimersByTimeAsync(2000)
    await flushPromises()

    // Unmount while scrollToBottom is still suspended — Vue nulls the template ref.
    wrapper.unmount()
    // Resume scrollToBottom: `el` is now null. No throw means the guard held.
    releaseGate()
    await flushPromises()
  })
})
