import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ScreenTab from '../../src/components/vmtabs/ScreenTab.vue'
import { setToastScheduler, useToasts } from '../../src/composables/useToasts'
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
  // Toasts default to a real setTimeout — swap in a no-op so nothing dangles.
  setToastScheduler(() => {})
  useToasts().toasts.value = []
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('ScreenTab — live view', () => {
  it('renders the polled screenshot as a data URI', async () => {
    const store = useFleet()
    store.vms = [vm()]
    vi.spyOn(api, 'screenshot').mockResolvedValue({ png_b64: 'QUJD' })
    const wrapper = mount(ScreenTab, { props: { name: 'web' } })
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="shot"]').attributes('src')).toBe(
        'data:image/png;base64,QUJD',
      )
    })
    wrapper.unmount()
  })

  it('keeps the last good frame on a transient screenshot error', async () => {
    vi.useFakeTimers()
    const store = useFleet()
    store.vms = [vm()]
    const shot = vi.spyOn(api, 'screenshot').mockResolvedValueOnce({ png_b64: 'QUJD' })
    const wrapper = mount(ScreenTab, { props: { name: 'web' } })
    await flushPromises()
    expect(wrapper.find('[data-test="shot"]').attributes('src')).toBe('data:image/png;base64,QUJD')

    shot.mockRejectedValueOnce(new Error('guest busy'))
    await vi.advanceTimersByTimeAsync(1000)
    expect(wrapper.find('[data-test="shot"]').attributes('src')).toBe('data:image/png;base64,QUJD')
    wrapper.unmount()
  })

  it('does not poll while the VM is stopped', async () => {
    const store = useFleet()
    store.vms = [vm({ state: 'stopped', healthy: false })]
    const shot = vi.spyOn(api, 'screenshot').mockResolvedValue({ png_b64: 'QUJD' })
    const wrapper = mount(ScreenTab, { props: { name: 'web' } })
    await flushPromises()
    expect(shot).not.toHaveBeenCalled()
    expect(wrapper.find('[data-test="shot"]').exists()).toBe(false)
    wrapper.unmount()
  })
})

describe('ScreenTab — click & type control', () => {
  it('maps an image click to pixel coords, calls api.click, and toasts', async () => {
    const store = useFleet()
    store.vms = [vm()]
    vi.spyOn(api, 'screenshot').mockResolvedValue({ png_b64: 'QUJD' })
    const click = vi.spyOn(api, 'click').mockResolvedValue({})
    const wrapper = mount(ScreenTab, { props: { name: 'web' } })
    await vi.waitFor(() => expect(wrapper.find('[data-test="shot"]').exists()).toBe(true))

    const img = wrapper.find('[data-test="shot"]')
    const el = img.element as HTMLImageElement
    Object.defineProperty(el, 'getBoundingClientRect', {
      value: () => ({ left: 0, top: 0, width: 100, height: 100 }),
    })
    Object.defineProperty(el, 'naturalWidth', { value: 200 })
    Object.defineProperty(el, 'naturalHeight', { value: 200 })
    await img.trigger('click', { clientX: 10, clientY: 20 })

    expect(click).toHaveBeenCalledWith('web', 20, 40)
    expect(useToasts().toasts.value.map((t) => t.msg)).toContain('click → 20, 40')
    wrapper.unmount()
  })

  it('toasts a failure instead of rejecting when api.click fails', async () => {
    const store = useFleet()
    store.vms = [vm()]
    vi.spyOn(api, 'screenshot').mockResolvedValue({ png_b64: 'QUJD' })
    vi.spyOn(api, 'click').mockRejectedValue(new Error('POST /vms/web/click -> 409'))
    const wrapper = mount(ScreenTab, { props: { name: 'web' } })
    await vi.waitFor(() => expect(wrapper.find('[data-test="shot"]').exists()).toBe(true))

    const img = wrapper.find('[data-test="shot"]')
    const el = img.element as HTMLImageElement
    Object.defineProperty(el, 'getBoundingClientRect', {
      value: () => ({ left: 0, top: 0, width: 100, height: 100 }),
    })
    Object.defineProperty(el, 'naturalWidth', { value: 200 })
    Object.defineProperty(el, 'naturalHeight', { value: 200 })
    await img.trigger('click', { clientX: 10, clientY: 20 })

    expect(useToasts().toasts.value.map((t) => t.msg)).toContain('Click failed')
    wrapper.unmount()
  })

  it('sends typed text via api.typeText, clears the input, and toasts', async () => {
    const store = useFleet()
    store.vms = [vm()]
    vi.spyOn(api, 'screenshot').mockResolvedValue({ png_b64: 'QUJD' })
    const typeText = vi.spyOn(api, 'typeText').mockResolvedValue({})
    const wrapper = mount(ScreenTab, { props: { name: 'web' } })
    await flushPromises()

    await wrapper.find('[data-test="type-input"]').setValue('hello')
    await wrapper.find('[data-test="send-btn"]').trigger('click')

    expect(typeText).toHaveBeenCalledWith('web', 'hello')
    expect((wrapper.find('[data-test="type-input"]').element as HTMLInputElement).value).toBe('')
    expect(useToasts().toasts.value.map((t) => t.msg)).toContain('Sent keystrokes')
    wrapper.unmount()
  })

  it('does not type into a VM that is not running', async () => {
    const store = useFleet()
    store.vms = [vm({ state: 'stopped', healthy: false })]
    const typeText = vi.spyOn(api, 'typeText').mockResolvedValue({})
    const wrapper = mount(ScreenTab, { props: { name: 'web' } })
    await flushPromises()
    expect(wrapper.find('[data-test="type-input"]').attributes('disabled')).toBeDefined()
    await wrapper.find('[data-test="send-btn"]').trigger('click')
    expect(typeText).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})

describe('ScreenTab — non-running overlays', () => {
  it.each([
    ['booting', 'Booting — waiting for guest'],
    ['stopped', 'Stopped'],
    ['suspended', 'Suspended'],
    ['error', 'Unhealthy — control disabled'],
  ])('shows the %s overlay', async (state, msg) => {
    const store = useFleet()
    store.vms = [vm({ state, healthy: false })]
    const wrapper = mount(ScreenTab, { props: { name: 'web' } })
    await flushPromises()
    expect(wrapper.find('[data-test="overlay-msg"]').text()).toBe(msg)
    wrapper.unmount()
  })

  it('shows the creating overlay for a pending VM not yet running', async () => {
    const store = useFleet()
    store.pending = ['web']
    store.vms = [vm({ state: 'stopped', healthy: false })]
    const wrapper = mount(ScreenTab, { props: { name: 'web' } })
    await flushPromises()
    expect(wrapper.find('[data-test="overlay-msg"]').text()).toBe('Creating VM…')
    wrapper.unmount()
  })

  it('Resume action calls store.resume for a stopped VM', async () => {
    const store = useFleet()
    const resume = vi.spyOn(store, 'resume').mockResolvedValue()
    store.vms = [vm({ state: 'stopped', healthy: false })]
    const wrapper = mount(ScreenTab, { props: { name: 'web' } })
    await flushPromises()
    await wrapper.find('[data-test="resume-btn"]').trigger('click')
    expect(resume).toHaveBeenCalledWith('web')
    wrapper.unmount()
  })

  it('Resume action calls store.resume for a suspended VM', async () => {
    const store = useFleet()
    const resume = vi.spyOn(store, 'resume').mockResolvedValue()
    store.vms = [vm({ state: 'suspended', healthy: false })]
    const wrapper = mount(ScreenTab, { props: { name: 'web' } })
    await flushPromises()
    await wrapper.find('[data-test="resume-btn"]').trigger('click')
    expect(resume).toHaveBeenCalledWith('web')
    wrapper.unmount()
  })

  it('does not offer Resume for booting/error states', async () => {
    const store = useFleet()
    store.vms = [vm({ state: 'error', healthy: false })]
    const wrapper = mount(ScreenTab, { props: { name: 'web' } })
    await flushPromises()
    expect(wrapper.find('[data-test="resume-btn"]').exists()).toBe(false)
    wrapper.unmount()
  })
})

describe('ScreenTab — pause & fullscreen', () => {
  it('pause toggle stops polling until resumed', async () => {
    vi.useFakeTimers()
    const store = useFleet()
    store.vms = [vm()]
    const shot = vi.spyOn(api, 'screenshot').mockResolvedValue({ png_b64: 'QUJD' })
    const wrapper = mount(ScreenTab, { props: { name: 'web' } })
    await flushPromises()
    const callsBefore = shot.mock.calls.length

    await wrapper.find('[data-test="pause-btn"]').trigger('click')
    await vi.advanceTimersByTimeAsync(2000)
    expect(shot.mock.calls.length).toBe(callsBefore)
    wrapper.unmount()
  })

  it('toasts when the Fullscreen API is unavailable (best-effort)', async () => {
    const store = useFleet()
    store.vms = [vm()]
    vi.spyOn(api, 'screenshot').mockResolvedValue({ png_b64: 'QUJD' })
    const wrapper = mount(ScreenTab, { props: { name: 'web' } })
    await flushPromises()
    await wrapper.find('[data-test="fullscreen-btn"]').trigger('click')
    expect(useToasts().toasts.value.some((t) => t.msg.includes('Fullscreen'))).toBe(true)
    wrapper.unmount()
  })
})
