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
  it('renders binary screenshots with revocable object URLs', async () => {
    const previousCreate = URL.createObjectURL
    const previousRevoke = URL.revokeObjectURL
    const create = vi.fn(() => 'blob:frame-1')
    const revoke = vi.fn()
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: create })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke })
    try {
      const store = useFleet()
      store.vms = [vm()]
      vi.spyOn(api, 'screenshot').mockResolvedValue(new Blob(['PNG'], { type: 'image/png' }))
      const wrapper = mount(ScreenTab, { props: { name: 'web' } })
      await vi.waitFor(() =>
        expect(wrapper.find('[data-test="shot"]').attributes('src')).toBe('blob:frame-1'),
      )
      wrapper.unmount()
      expect(create).toHaveBeenCalledOnce()
      expect(revoke).toHaveBeenCalledWith('blob:frame-1')
    } finally {
      Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: previousCreate })
      Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: previousRevoke })
    }
  })

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

  it('resolves a VM name that does not carry the mf- prefix unchanged (defensive passthrough)', async () => {
    const store = useFleet()
    store.vms = [vm({ name: 'standalone' })]
    vi.spyOn(api, 'screenshot').mockResolvedValue({ png_b64: 'QUJD' })
    const wrapper = mount(ScreenTab, { props: { name: 'standalone' } })
    await vi.waitFor(() => expect(wrapper.find('[data-test="shot"]').exists()).toBe(true))
    wrapper.unmount()
  })

  it('restarts polling against the new VM when the name prop changes to another running VM', async () => {
    const store = useFleet()
    store.vms = [vm({ name: 'mf-web' }), vm({ name: 'mf-db' })]
    const shot = vi.spyOn(api, 'screenshot').mockResolvedValue({ png_b64: 'QUJD' })
    const wrapper = mount(ScreenTab, { props: { name: 'web' } })
    await flushPromises()
    expect(shot).toHaveBeenCalledWith('web')

    await wrapper.setProps({ name: 'db' })
    await flushPromises()
    expect(shot).toHaveBeenCalledWith('db')
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

  it('maps a click against the letterboxed image box, not the element box', async () => {
    const store = useFleet()
    store.vms = [vm()]
    vi.spyOn(api, 'screenshot').mockResolvedValue({ png_b64: 'QUJD' })
    const click = vi.spyOn(api, 'click').mockResolvedValue({})
    const wrapper = mount(ScreenTab, { props: { name: 'web' } })
    await vi.waitFor(() => expect(wrapper.find('[data-test="shot"]').exists()).toBe(true))

    const img = wrapper.find('[data-test="shot"]')
    const el = img.element as HTMLImageElement
    // 16:10 element (160x100) showing a square 200x200 guest screenshot: object-contain scales
    // it to a 100x100 box centered horizontally, leaving 30px letterbox bars left and right.
    Object.defineProperty(el, 'getBoundingClientRect', {
      value: () => ({ left: 0, top: 0, width: 160, height: 100 }),
    })
    Object.defineProperty(el, 'naturalWidth', { value: 200 })
    Object.defineProperty(el, 'naturalHeight', { value: 200 })

    // The visual left edge of the image is at element-x 30; it must map to pixel 0, not ~38
    // (the old element-box math). Center-y 0 maps to pixel 0.
    await img.trigger('click', { clientX: 30, clientY: 0 })
    expect(click).toHaveBeenCalledWith('web', 0, 0)

    // A click inside the left letterbox bar (element-x 10) is outside the image — ignored.
    click.mockClear()
    await img.trigger('click', { clientX: 10, clientY: 0 })
    expect(click).not.toHaveBeenCalled()
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

  it('does not send when the typed text is blank', async () => {
    const store = useFleet()
    store.vms = [vm()]
    vi.spyOn(api, 'screenshot').mockResolvedValue({ png_b64: 'QUJD' })
    const typeText = vi.spyOn(api, 'typeText').mockResolvedValue({})
    const wrapper = mount(ScreenTab, { props: { name: 'web' } })
    await flushPromises()
    await wrapper.find('[data-test="send-btn"]').trigger('click')
    expect(typeText).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('sending a second time before the first flash expires clears and resets the flash timer', async () => {
    vi.useFakeTimers()
    const store = useFleet()
    store.vms = [vm()]
    vi.spyOn(api, 'screenshot').mockResolvedValue({ png_b64: 'QUJD' })
    vi.spyOn(api, 'typeText').mockResolvedValue({})
    const wrapper = mount(ScreenTab, { props: { name: 'web' } })
    await flushPromises()

    await wrapper.find('[data-test="type-input"]').setValue('hello')
    await wrapper.find('[data-test="send-btn"]').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('⌨ hello')

    await wrapper.find('[data-test="type-input"]').setValue('world')
    await wrapper.find('[data-test="send-btn"]').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('⌨ world')
    expect(wrapper.text()).not.toContain('⌨ hello')

    await vi.advanceTimersByTimeAsync(2200)
    expect(wrapper.text()).not.toContain('⌨ world')
    wrapper.unmount()
  })

  it('toasts a failure instead of rejecting when api.typeText fails', async () => {
    const store = useFleet()
    store.vms = [vm()]
    vi.spyOn(api, 'screenshot').mockResolvedValue({ png_b64: 'QUJD' })
    vi.spyOn(api, 'typeText').mockRejectedValue(new Error('POST /vms/web/type -> 500'))
    const wrapper = mount(ScreenTab, { props: { name: 'web' } })
    await flushPromises()

    await wrapper.find('[data-test="type-input"]').setValue('hello')
    await wrapper.find('[data-test="send-btn"]').trigger('click')
    await flushPromises()

    expect(useToasts().toasts.value.map((t) => t.msg)).toContain('Failed to send keystrokes')
    wrapper.unmount()
  })

  it('calls the real requestFullscreen when available, toasting on failure', async () => {
    const store = useFleet()
    store.vms = [vm()]
    vi.spyOn(api, 'screenshot').mockResolvedValue({ png_b64: 'QUJD' })
    const wrapper = mount(ScreenTab, { props: { name: 'web' } })
    await flushPromises()

    const frame = wrapper.find('[data-test="screen-frame"]').element as HTMLElement & {
      requestFullscreen?: () => Promise<void>
    }
    const requestFullscreen = vi.fn().mockRejectedValue(new Error('denied'))
    Object.defineProperty(frame, 'requestFullscreen', {
      value: requestFullscreen,
      configurable: true,
    })

    await wrapper.find('[data-test="fullscreen-btn"]').trigger('click')
    await flushPromises()

    expect(requestFullscreen).toHaveBeenCalled()
    expect(useToasts().toasts.value.some((t) => t.msg === 'Fullscreen failed')).toBe(true)
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

  it('defaults to "Stopped" when the VM is not found in store.vms at all', async () => {
    const store = useFleet()
    store.vms = []
    const wrapper = mount(ScreenTab, { props: { name: 'ghost' } })
    await flushPromises()
    expect(wrapper.find('[data-test="overlay-msg"]').text()).toBe('Stopped')
    wrapper.unmount()
  })

  it('falls back to the "Stopped" overlay for an unrecognized raw state', async () => {
    const store = useFleet()
    store.vms = [vm({ state: 'zombie', healthy: false })]
    const wrapper = mount(ScreenTab, { props: { name: 'web' } })
    await flushPromises()
    expect(wrapper.find('[data-test="overlay-msg"]').text()).toBe('Stopped')
    expect(wrapper.find('[data-test="resume-btn"]').exists()).toBe(true)
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

describe('ScreenTab — booting-aware polling', () => {
  it('a tart-running but never-healthy VM shows the Booting overlay and does NOT poll the guest', async () => {
    const store = useFleet()
    store.vms = [vm({ state: 'running', healthy: false })]
    const shot = vi.spyOn(api, 'screenshot').mockResolvedValue({ png_b64: 'QUJD' })
    const wrapper = mount(ScreenTab, { props: { name: 'web' } })
    await flushPromises()
    // No screenshot flood while the guest is unreachable during macOS boot.
    expect(shot).not.toHaveBeenCalled()
    // The informative booting overlay renders (not the generic "Connecting…").
    expect(wrapper.find('[data-test="overlay-msg"]').text()).toBe('Booting — waiting for guest')
    expect(wrapper.find('[data-test="shot"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('starts polling once the guest reports healthy', async () => {
    const store = useFleet()
    store.vms = [vm({ state: 'running', healthy: false })]
    const shot = vi.spyOn(api, 'screenshot').mockResolvedValue({ png_b64: 'QUJD' })
    const wrapper = mount(ScreenTab, { props: { name: 'web' } })
    await flushPromises()
    expect(shot).not.toHaveBeenCalled()

    // Guest finishes booting → healthy flips true.
    store.vms = [vm({ state: 'running', healthy: true })]
    await flushPromises()
    expect(shot).toHaveBeenCalledWith('web')
    wrapper.unmount()
  })

  it('keeps polling through a health flap once the guest has been healthy (anti-flap sticky)', async () => {
    vi.useFakeTimers()
    const store = useFleet()
    store.vms = [vm({ state: 'running', healthy: true })]
    const shot = vi.spyOn(api, 'screenshot').mockResolvedValue({ png_b64: 'QUJD' })
    const wrapper = mount(ScreenTab, { props: { name: 'web' } })
    await flushPromises()
    const before = shot.mock.calls.length

    // Health flaps false under load — polling must continue (gated on ever-healthy).
    store.vms = [vm({ state: 'running', healthy: false })]
    await vi.advanceTimersByTimeAsync(1000)
    expect(shot.mock.calls.length).toBeGreaterThan(before)
    wrapper.unmount()
  })

  it('re-arms the booting gate when switching from a healthy VM to a still-booting one', async () => {
    const store = useFleet()
    store.vms = [vm({ name: 'mf-web', healthy: true }), vm({ name: 'mf-db', healthy: false })]
    const shot = vi.spyOn(api, 'screenshot').mockResolvedValue({ png_b64: 'QUJD' })
    const wrapper = mount(ScreenTab, { props: { name: 'web' } })
    await flushPromises()
    expect(shot).toHaveBeenCalledWith('web')

    await wrapper.setProps({ name: 'db' })
    await flushPromises()
    // The booting VM must not be screenshot-polled, and shows the booting overlay.
    expect(shot).not.toHaveBeenCalledWith('db')
    expect(wrapper.find('[data-test="overlay-msg"]').text()).toBe('Booting — waiting for guest')
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
