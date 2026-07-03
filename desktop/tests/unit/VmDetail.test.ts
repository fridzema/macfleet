import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import VmDetail from '../../src/components/VmDetail.vue'
import { api } from '../../src/shared/api'

afterEach(() => vi.restoreAllMocks())

describe('VmDetail', () => {
  it('renders the polled screenshot as a data URI', async () => {
    vi.spyOn(api, 'screenshot').mockResolvedValue({ png_b64: 'QUJD' })
    const wrapper = mount(VmDetail, { props: { name: 'web' } })
    await vi.waitFor(() => {
      const src = wrapper.find('[data-test="shot"]').attributes('src')
      expect(src).toBe('data:image/png;base64,QUJD')
    })
    wrapper.unmount()
  })

  it('maps an image click to pixel coords and calls api.click', async () => {
    vi.spyOn(api, 'screenshot').mockResolvedValue({ png_b64: 'QUJD' })
    const click = vi.spyOn(api, 'click').mockResolvedValue({})
    const wrapper = mount(VmDetail, { props: { name: 'web' } })
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="shot"]').exists()).toBe(true)
    })
    const img = wrapper.find('[data-test="shot"]')
    // stub geometry: 100x100 element mapping to a 200x200 natural image => scale 2x
    const el = img.element as HTMLImageElement
    Object.defineProperty(el, 'getBoundingClientRect', {
      value: () => ({ left: 0, top: 0, width: 100, height: 100 }),
    })
    Object.defineProperty(el, 'naturalWidth', { value: 200 })
    Object.defineProperty(el, 'naturalHeight', { value: 200 })
    await img.trigger('click', { clientX: 10, clientY: 20 })
    expect(click).toHaveBeenCalledWith('web', 20, 40)
    wrapper.unmount()
  })
})
