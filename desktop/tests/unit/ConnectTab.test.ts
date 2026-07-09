import { writeText as tauriWriteText } from '@tauri-apps/plugin-clipboard-manager'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ConnectTab from '../../src/components/vmtabs/ConnectTab.vue'
import { setToastScheduler, useToasts } from '../../src/composables/useToasts'
import { api, type ConnectionInfo, type Vm } from '../../src/shared/api'
import { useFleet } from '../../src/stores/fleet'

const vmRec = (overrides: Partial<Vm> = {}): Vm => ({
  name: 'mf-web',
  state: 'running',
  source: 'local',
  healthy: true,
  ...overrides,
})

vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({
  writeText: vi.fn(),
}))

type TauriWindow = Window & { __TAURI_INTERNALS__?: unknown; __TAURI__?: unknown }

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

  it('does not confirm the copy when the Clipboard API throws synchronously', async () => {
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
    expect(wrapper.findAll('[data-test="copy-btn"]')[0]?.text()).toBe('Copy')
    expect(useToasts().toasts.value.map((t) => t.msg)).not.toContain('Copied to clipboard')
    expect(useToasts().toasts.value.some((t) => t.msg.includes('Failed to copy'))).toBe(true)
    wrapper.unmount()
  })

  it('does not confirm the copy when the Clipboard API rejects asynchronously (real WKWebView permission denial)', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockRejectedValue(new Error('permission denied')) },
      configurable: true,
    })
    vi.spyOn(api, 'connection').mockResolvedValue(connection())
    const wrapper = mount(ConnectTab, { props: { name: 'web' } })
    await flushPromises()

    await wrapper.findAll('[data-test="copy-btn"]')[0]?.trigger('click')
    await flushPromises()
    expect(wrapper.findAll('[data-test="copy-btn"]')[0]?.text()).toBe('Copy')
    expect(useToasts().toasts.value.map((t) => t.msg)).not.toContain('Copied to clipboard')
    expect(useToasts().toasts.value.some((t) => t.msg.includes('Failed to copy'))).toBe(true)
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

describe('ConnectTab — copy via Tauri clipboard', () => {
  afterEach(() => {
    const win = window as TauriWindow
    delete win.__TAURI_INTERNALS__
    delete win.__TAURI__
    vi.mocked(tauriWriteText).mockReset()
  })

  it('uses the Tauri clipboard plugin instead of navigator.clipboard when running inside Tauri', async () => {
    ;(window as TauriWindow).__TAURI_INTERNALS__ = {}
    vi.mocked(tauriWriteText).mockResolvedValue(undefined)
    vi.spyOn(api, 'connection').mockResolvedValue(connection())
    const wrapper = mount(ConnectTab, { props: { name: 'web' } })
    await flushPromises()

    await wrapper.findAll('[data-test="copy-btn"]')[0]?.trigger('click')
    await flushPromises()

    expect(tauriWriteText).toHaveBeenCalledWith('192.168.64.12')
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled()
    expect(wrapper.findAll('[data-test="copy-btn"]')[0]?.text()).toBe('✓ Copied')
    expect(useToasts().toasts.value.map((t) => t.msg)).toContain('Copied to clipboard')
    wrapper.unmount()
  })

  it('falls back to navigator.clipboard when the Tauri plugin import/write fails', async () => {
    ;(window as TauriWindow).__TAURI_INTERNALS__ = {}
    vi.mocked(tauriWriteText).mockRejectedValue(new Error('plugin unavailable'))
    vi.spyOn(api, 'connection').mockResolvedValue(connection())
    const wrapper = mount(ConnectTab, { props: { name: 'web' } })
    await flushPromises()

    await wrapper.findAll('[data-test="copy-btn"]')[0]?.trigger('click')
    await flushPromises()

    expect(tauriWriteText).toHaveBeenCalledWith('192.168.64.12')
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('192.168.64.12')
    expect(wrapper.findAll('[data-test="copy-btn"]')[0]?.text()).toBe('✓ Copied')
    expect(useToasts().toasts.value.map((t) => t.msg)).toContain('Copied to clipboard')
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

describe('ConnectTab — booting-aware', () => {
  it('shows a booting hint (not the generic unavailable) when a running VM has no IP yet', async () => {
    const store = useFleet()
    store.vms = [vmRec({ state: 'running', healthy: false })]
    vi.spyOn(api, 'connection').mockRejectedValue(new Error('GET /vms/web/connection -> 409'))
    const wrapper = mount(ConnectTab, { props: { name: 'web' } })
    await flushPromises()
    expect(wrapper.find('[data-test="booting"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="unavailable"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('resolves a VM name that does not carry the mf- prefix unchanged (defensive passthrough)', async () => {
    const store = useFleet()
    store.vms = [vmRec({ name: 'standalone', state: 'running', healthy: false })]
    vi.spyOn(api, 'connection').mockRejectedValue(new Error('no ip'))
    const wrapper = mount(ConnectTab, { props: { name: 'standalone' } })
    await flushPromises()
    // Found the running VM via the passthrough → booting hint, not the stopped unavailable.
    expect(wrapper.find('[data-test="booting"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('re-fetches and shows the cards once the guest becomes healthy', async () => {
    const store = useFleet()
    store.vms = [vmRec({ state: 'running', healthy: false })]
    const fetch = vi
      .spyOn(api, 'connection')
      .mockRejectedValueOnce(new Error('GET /vms/web/connection -> 409'))
      .mockResolvedValue(connection())
    const wrapper = mount(ConnectTab, { props: { name: 'web' } })
    await flushPromises()
    expect(wrapper.findAll('[data-test="connect-item"]')).toHaveLength(0)

    // Guest finishes booting → healthy flips true → connection re-fetched.
    store.vms = [vmRec({ state: 'running', healthy: true })]
    await flushPromises()
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(wrapper.findAll('[data-test="connect-item"]')).toHaveLength(4)

    // A later health flap to false must NOT trigger another fetch (only healthy→true does).
    store.vms = [vmRec({ state: 'running', healthy: false })]
    await flushPromises()
    expect(fetch).toHaveBeenCalledTimes(2)
    wrapper.unmount()
  })
})
