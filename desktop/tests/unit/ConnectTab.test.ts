import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ConnectTab from '../../src/components/vmtabs/ConnectTab.vue'
import { setToastScheduler, useToasts } from '../../src/composables/useToasts'
import { api, type ConnectionInfo } from '../../src/shared/api'

const connection = (overrides: Partial<ConnectionInfo> = {}): ConnectionInfo => ({
  ip: '192.168.64.12',
  ssh: 'ssh admin@192.168.64.12',
  vnc: 'open vnc://192.168.64.12',
  guest_server: 'http://192.168.64.12:8000',
  exec: true,
  ...overrides,
})

beforeEach(() => {
  setActivePinia(createPinia())
  setToastScheduler(() => {})
  useToasts().toasts.value = []
  // jsdom has no navigator.clipboard — stub it so copyField's writeText call has
  // something to hit (and something for tests to spy on). The real API always returns a
  // Promise, so the stub does too (a bare `vi.fn()` returning `undefined` would make
  // `.catch()` throw synchronously, masking whether that call is wired correctly).
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    configurable: true,
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('ConnectTab — connection cards', () => {
  it('renders IP / SSH / VNC / guest server cards from api.connection', async () => {
    vi.spyOn(api, 'connection').mockResolvedValue(connection())
    const wrapper = mount(ConnectTab, { props: { name: 'web' } })
    await flushPromises()

    const cards = wrapper.findAll('[data-test="connect-item"]')
    expect(cards).toHaveLength(4)
    expect(cards[0]?.text()).toContain('IP address')
    expect(cards[0]?.text()).toContain('192.168.64.12')
    expect(cards[1]?.text()).toContain('SSH')
    expect(cards[1]?.text()).toContain('ssh admin@192.168.64.12')
    expect(cards[2]?.text()).toContain('Screen sharing (VNC)')
    expect(cards[2]?.text()).toContain('open vnc://192.168.64.12')
    expect(cards[3]?.text()).toContain('Guest server URL')
    expect(cards[3]?.text()).toContain('http://192.168.64.12:8000')
    wrapper.unmount()
  })

  it('shows an intro line naming the VM and mentioning in-guest exec', async () => {
    vi.spyOn(api, 'connection').mockResolvedValue(connection())
    const wrapper = mount(ConnectTab, { props: { name: 'web' } })
    await flushPromises()
    expect(wrapper.text()).toContain('web')
    expect(wrapper.text()).toContain('exec')
    wrapper.unmount()
  })

  it('re-fetches when the VM name changes', async () => {
    const fetch = vi.spyOn(api, 'connection').mockResolvedValue(connection())
    const wrapper = mount(ConnectTab, { props: { name: 'web' } })
    await flushPromises()
    expect(fetch).toHaveBeenCalledWith('web')

    await wrapper.setProps({ name: 'db' })
    await flushPromises()
    expect(fetch).toHaveBeenCalledWith('db')
    wrapper.unmount()
  })
})

describe('ConnectTab — copy', () => {
  it('copying a field writes the clipboard, flashes ✓ Copied, and toasts', async () => {
    vi.useFakeTimers()
    vi.spyOn(api, 'connection').mockResolvedValue(connection())
    const wrapper = mount(ConnectTab, { props: { name: 'web' } })
    await flushPromises()

    const btn = wrapper.findAll('[data-test="copy-btn"]')[0]
    expect(btn?.text()).toBe('Copy')
    await btn?.trigger('click')

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('192.168.64.12')
    expect(wrapper.findAll('[data-test="copy-btn"]')[0]?.text()).toBe('✓ Copied')
    expect(useToasts().toasts.value.map((t) => t.msg)).toContain('Copied to clipboard')

    await vi.advanceTimersByTimeAsync(1300)
    expect(wrapper.findAll('[data-test="copy-btn"]')[0]?.text()).toBe('Copy')
    wrapper.unmount()
  })

  it('still confirms the copy when the Clipboard API throws', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: () => {
          throw new Error('no clipboard permission')
        },
      },
      configurable: true,
    })
    vi.spyOn(api, 'connection').mockResolvedValue(connection())
    const wrapper = mount(ConnectTab, { props: { name: 'web' } })
    await flushPromises()

    await wrapper.findAll('[data-test="copy-btn"]')[0]?.trigger('click')
    expect(wrapper.findAll('[data-test="copy-btn"]')[0]?.text()).toBe('✓ Copied')
    wrapper.unmount()
  })

  it('still confirms the copy when the Clipboard API rejects asynchronously (real WKWebView permission denial)', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockRejectedValue(new Error('permission denied')) },
      configurable: true,
    })
    vi.spyOn(api, 'connection').mockResolvedValue(connection())
    const wrapper = mount(ConnectTab, { props: { name: 'web' } })
    await flushPromises()

    await wrapper.findAll('[data-test="copy-btn"]')[0]?.trigger('click')
    await flushPromises()
    expect(wrapper.findAll('[data-test="copy-btn"]')[0]?.text()).toBe('✓ Copied')
    wrapper.unmount()
  })

  it('copying a second field before the first flash expires clears the first timer', async () => {
    vi.useFakeTimers()
    vi.spyOn(api, 'connection').mockResolvedValue(connection())
    const wrapper = mount(ConnectTab, { props: { name: 'web' } })
    await flushPromises()

    const buttons = wrapper.findAll('[data-test="copy-btn"]')
    await buttons[0]?.trigger('click')
    expect(buttons[0]?.text()).toBe('✓ Copied')

    await vi.advanceTimersByTimeAsync(600) // well within the first flash's 1300ms window
    await buttons[1]?.trigger('click')
    expect(wrapper.findAll('[data-test="copy-btn"]')[0]?.text()).toBe('Copy')
    expect(wrapper.findAll('[data-test="copy-btn"]')[1]?.text()).toBe('✓ Copied')
    wrapper.unmount()
  })
})

describe('ConnectTab — unavailable state', () => {
  it('shows an unavailable state instead of cards when there is no IP yet', async () => {
    vi.spyOn(api, 'connection').mockResolvedValue(connection({ ip: '—' }))
    const wrapper = mount(ConnectTab, { props: { name: 'web' } })
    await flushPromises()

    expect(wrapper.find('[data-test="unavailable"]').exists()).toBe(true)
    expect(wrapper.findAll('[data-test="connect-item"]')).toHaveLength(0)
    wrapper.unmount()
  })

  it('falls back to the unavailable state when api.connection rejects', async () => {
    vi.spyOn(api, 'connection').mockRejectedValue(new Error('GET /vms/web/connection -> 404'))
    const wrapper = mount(ConnectTab, { props: { name: 'web' } })
    await flushPromises()

    expect(wrapper.find('[data-test="unavailable"]').exists()).toBe(true)
    wrapper.unmount()
  })
})
