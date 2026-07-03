import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import LogPane from '../../src/components/LogPane.vue'
import { api } from '../../src/shared/api'

afterEach(() => vi.restoreAllMocks())

describe('LogPane', () => {
  it('polls logs and renders them', async () => {
    vi.spyOn(api, 'logs').mockResolvedValue({ lines: 'boot ok\nserver up' })
    const wrapper = mount(LogPane, { props: { name: 'web' } })
    await vi.waitFor(() => expect(wrapper.find('pre').text()).toContain('server up'))
    wrapper.unmount()
  })
})
