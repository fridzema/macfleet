import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import VmProvisioning from '../../src/components/VmProvisioning.vue'
import { setToastScheduler, useToasts } from '../../src/composables/useToasts'
import { api, type ProvisionRecord } from '../../src/shared/api'
import { useFleet } from '../../src/stores/fleet'
import { useUi } from '../../src/stores/ui'

vi.mock('../../src/composables/useDarkMode', () => ({
  useDarkMode: vi.fn(() => ({ isDark: ref(false), toggleDark: vi.fn() })),
}))

const record = (over: Partial<ProvisionRecord> = {}): ProvisionRecord => ({
  name: 'web',
  steps: [
    { key: 'clone', label: 'Clone image', status: 'done' },
    { key: 'configure', label: 'Apply resources', status: 'done' },
    { key: 'boot', label: 'Boot guest', status: 'active' },
    { key: 'health', label: 'Guest health check', status: 'pending' },
  ],
  done: false,
  error: null,
  ...over,
})

beforeEach(() => {
  setActivePinia(createPinia())
  setToastScheduler(() => {})
  useToasts().toasts.value = []
})

afterEach(() => vi.restoreAllMocks())

describe('VmProvisioning', () => {
  it('renders every step from the store record with its status', async () => {
    const store = useFleet()
    store.provisioning = { web: record() }
    const wrapper = mount(VmProvisioning, { props: { name: 'web' } })
    await flushPromises()
    const steps = wrapper.findAll('[data-test="provision-step"]')
    expect(steps).toHaveLength(4)
    expect(steps.map((s) => s.attributes('data-status'))).toEqual([
      'done',
      'done',
      'active',
      'pending',
    ])
    expect(wrapper.text()).toContain('Provisioning web…')
    wrapper.unmount()
  })

  it('fetches the record once on mount when the store has none yet', async () => {
    const provision = vi.spyOn(api, 'provision').mockResolvedValue(record())
    const wrapper = mount(VmProvisioning, { props: { name: 'web' } })
    await flushPromises()
    expect(provision).toHaveBeenCalledWith('web')
    expect(wrapper.findAll('[data-test="provision-step"]')).toHaveLength(4)
    wrapper.unmount()
  })

  it('shows a fallback stepper (no crash) when neither store nor fetch has a record', async () => {
    vi.spyOn(api, 'provision').mockResolvedValue(null)
    const wrapper = mount(VmProvisioning, { props: { name: 'web' } })
    await flushPromises()
    expect(wrapper.findAll('[data-test="provision-step"]')).toHaveLength(4)
    wrapper.unmount()
  })

  it('renders the error state with a dismiss that clears the selection', async () => {
    const store = useFleet()
    const ui = useUi()
    ui.selectVm('web')
    store.provisioning = {
      web: record({
        steps: [{ key: 'clone', label: 'Clone image', status: 'error' }],
        error: 'clone failed',
      }),
    }
    const wrapper = mount(VmProvisioning, { props: { name: 'web' } })
    await flushPromises()
    expect(wrapper.find('[data-test="provision-error"]').text()).toContain('clone failed')
    await wrapper.find('[data-test="provision-dismiss"]').trigger('click')
    expect(ui.selectedVm).toBeNull()
    wrapper.unmount()
  })
})
