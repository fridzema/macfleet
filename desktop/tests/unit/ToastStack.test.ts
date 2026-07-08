import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ToastStack from '../../src/components/ToastStack.vue'
import { setToastScheduler, useToasts } from '../../src/composables/useToasts'
import { api } from '../../src/shared/api'
import { useFleet } from '../../src/stores/fleet'

beforeEach(() => {
  setActivePinia(createPinia())
  // Toasts are a module-level singleton — swap in a no-op scheduler and clear the list
  // so no real 2600ms timer dangles and no toast bleeds in from a previous test.
  setToastScheduler(() => {})
  useToasts().toasts.value = []
})

describe('ToastStack', () => {
  it('renders nothing when there are no toasts', () => {
    const wrapper = mount(ToastStack)
    expect(wrapper.findAll('[data-test="toast"]')).toHaveLength(0)
  })

  it('renders each toast in the seeded list with its icon and message', () => {
    useToasts().toasts.value = [
      { id: 1, msg: 'Suspended', icon: '⏸' },
      { id: 2, msg: 'Copied to clipboard', icon: '✓' },
    ]
    const wrapper = mount(ToastStack)
    const items = wrapper.findAll('[data-test="toast"]')
    expect(items).toHaveLength(2)
    expect(items[0]?.text()).toContain('⏸')
    expect(items[0]?.text()).toContain('Suspended')
    expect(items[1]?.text()).toContain('✓')
    expect(items[1]?.text()).toContain('Copied to clipboard')
  })

  it('shows a toast added after mount, reactively', async () => {
    const wrapper = mount(ToastStack)
    useToasts().add('Creating vm-1…', '⚡')
    await wrapper.vm.$nextTick()
    const items = wrapper.findAll('[data-test="toast"]')
    expect(items).toHaveLength(1)
    expect(items[0]?.text()).toContain('Creating vm-1…')
  })

  it('is mounted against the shared composable, so a store action toast shows up', async () => {
    // Mirrors how the app really wires this: ToastStack.vue renders the same module-level
    // `useToasts()` list the fleet store pushes to — no mocking of useToasts itself.
    vi.spyOn(api, 'snapshot').mockResolvedValue({})
    vi.spyOn(api, 'listVms').mockResolvedValue([])
    vi.spyOn(api, 'listSnapshots').mockResolvedValue([])
    const wrapper = mount(ToastStack)
    const fleet = useFleet()
    void fleet.snapshotVM('mf-web', 'golden')
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('Freezing state of mf-web…')
  })
})
