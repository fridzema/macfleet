import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import VmDetail from '../../src/components/VmDetail.vue'
import { api } from '../../src/shared/api'

beforeEach(() => setActivePinia(createPinia()))
afterEach(() => vi.restoreAllMocks())

const running = { name: 'web', state: 'running', healthy: true }
const stopped = { name: 'web', state: 'stopped', healthy: false }

describe('VmDetail', () => {
  it('renders the polled screenshot as a data URI', async () => {
    vi.spyOn(api, 'screenshot').mockResolvedValue({ png_b64: 'QUJD' })
    const wrapper = mount(VmDetail, { props: running })
    await vi.waitFor(() => {
      const src = wrapper.find('[data-test="shot"]').attributes('src')
      expect(src).toBe('data:image/png;base64,QUJD')
    })
    wrapper.unmount()
  })

  it('does not poll a screenshot when the VM is not running', async () => {
    const shot = vi.spyOn(api, 'screenshot').mockResolvedValue({ png_b64: 'QUJD' })
    const wrapper = mount(VmDetail, { props: stopped })
    await Promise.resolve()
    expect(shot).not.toHaveBeenCalled()
    expect(wrapper.find('[data-test="shot"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('does not type into a VM that is not running', async () => {
    const type = vi.spyOn(api, 'typeText').mockResolvedValue({})
    const wrapper = mount(VmDetail, { props: stopped })
    await wrapper.find('input').setValue('hello')
    await wrapper.find('form').trigger('submit')
    expect(type).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('surfaces a failed control action on err instead of rejecting', async () => {
    vi.spyOn(api, 'screenshot').mockResolvedValue({ png_b64: 'QUJD' })
    vi.spyOn(api, 'typeText').mockRejectedValue(new Error('POST /vms/web/type -> 409'))
    const wrapper = mount(VmDetail, { props: running })
    await wrapper.find('input').setValue('hi')
    await wrapper.find('form').trigger('submit')
    await vi.waitFor(() => expect(wrapper.text()).toContain('409'))
    wrapper.unmount()
  })

  it('maps an image click to pixel coords and calls api.click', async () => {
    vi.spyOn(api, 'screenshot').mockResolvedValue({ png_b64: 'QUJD' })
    const click = vi.spyOn(api, 'click').mockResolvedValue({})
    const wrapper = mount(VmDetail, { props: running })
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="shot"]').exists()).toBe(true)
    })
    const img = wrapper.find('[data-test="shot"]')
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
