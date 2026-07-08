import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import CommandPalette from '../../src/components/CommandPalette.vue'
import { useDarkMode } from '../../src/composables/useDarkMode'
import { setToastScheduler, useToasts } from '../../src/composables/useToasts'
import { useFleet } from '../../src/stores/fleet'
import { useUi } from '../../src/stores/ui'

vi.mock('../../src/composables/useDarkMode', () => ({
  useDarkMode: vi.fn(),
}))

beforeEach(() => {
  setActivePinia(createPinia())
  vi.mocked(useDarkMode).mockReturnValue({ isDark: ref(false), toggleDark: vi.fn() })
  setToastScheduler(() => {})
  useToasts().toasts.value = []
})

afterEach(() => vi.restoreAllMocks())

describe('CommandPalette', () => {
  it('renders nothing when closed', () => {
    const wrapper = mount(CommandPalette)
    expect(wrapper.find('[data-test="palette-backdrop"]').exists()).toBe(false)
  })

  it('renders the grouped item list when open', () => {
    const fleet = useFleet()
    fleet.vms = [{ name: 'mf-web', state: 'running', source: 'local', healthy: true }]
    const ui = useUi()
    ui.selectVm('web')
    ui.openPalette()
    const wrapper = mount(CommandPalette)
    const items = wrapper.findAll('[data-test="palette-item"]')
    expect(items.length).toBe(ui.paletteItems.length)
    expect(items.length).toBeGreaterThan(0)
    expect(wrapper.text()).toContain('Create')
    expect(wrapper.text()).toContain('VM')
    expect(wrapper.text()).toContain('App')
  })

  it('typing filters the list via ui.query', async () => {
    const ui = useUi()
    ui.openPalette()
    const wrapper = mount(CommandPalette)
    await wrapper.find('[data-test="palette-input"]').setValue('zzz-does-not-match-anything')
    expect(ui.query).toBe('zzz-does-not-match-anything')
    expect(wrapper.findAll('[data-test="palette-item"]')).toHaveLength(0)
    expect(wrapper.find('[data-test="palette-empty"]').text()).toBe('No matching commands')
  })

  it('ArrowDown moves the active index, clamped at the last item', async () => {
    const ui = useUi()
    ui.openPalette()
    const wrapper = mount(CommandPalette)
    const last = ui.paletteItems.length - 1
    const input = wrapper.find('[data-test="palette-input"]')
    for (let i = 0; i < last + 3; i++) {
      await input.trigger('keydown', { key: 'ArrowDown' })
    }
    expect(ui.index).toBe(last)
  })

  it('ArrowUp moves the active index, clamped at 0', async () => {
    const ui = useUi()
    ui.openPalette()
    const wrapper = mount(CommandPalette)
    const input = wrapper.find('[data-test="palette-input"]')
    await input.trigger('keydown', { key: 'ArrowUp' })
    await input.trigger('keydown', { key: 'ArrowUp' })
    expect(ui.index).toBe(0)
  })

  it('arrow keys are a no-op when the filtered list is empty', async () => {
    const ui = useUi()
    ui.openPalette()
    ui.query = 'zzz-does-not-match-anything'
    const wrapper = mount(CommandPalette)
    const input = wrapper.find('[data-test="palette-input"]')
    await input.trigger('keydown', { key: 'ArrowDown' })
    await input.trigger('keydown', { key: 'ArrowUp' })
    expect(ui.index).toBe(0)
  })

  it('Enter runs the active item and closes the palette', async () => {
    const fleet = useFleet()
    const create = vi.spyOn(fleet, 'create').mockResolvedValue()
    const ui = useUi()
    ui.openPalette()
    const wrapper = mount(CommandPalette)
    // The "Spin up new VM" item is first (index 0).
    await wrapper.find('[data-test="palette-input"]').trigger('keydown', { key: 'Enter' })
    expect(create).toHaveBeenCalled()
    expect(ui.open).toBe(false)
  })

  it('Enter is a no-op when the filtered list is empty', async () => {
    const ui = useUi()
    ui.openPalette()
    ui.query = 'zzz-does-not-match-anything'
    const wrapper = mount(CommandPalette)
    await wrapper.find('[data-test="palette-input"]').trigger('keydown', { key: 'Enter' })
    expect(ui.open).toBe(true)
  })

  it('ignores keys other than Arrow/Enter/Escape', async () => {
    const ui = useUi()
    ui.openPalette()
    const wrapper = mount(CommandPalette)
    await wrapper.find('[data-test="palette-input"]').trigger('keydown', { key: 'a' })
    expect(ui.index).toBe(0)
    expect(ui.open).toBe(true)
  })

  it('Escape closes the palette', async () => {
    const ui = useUi()
    ui.openPalette()
    const wrapper = mount(CommandPalette)
    await wrapper.find('[data-test="palette-input"]').trigger('keydown', { key: 'Escape' })
    expect(ui.open).toBe(false)
  })

  it('clicking an item runs it and closes the palette', async () => {
    const fleet = useFleet()
    const create = vi.spyOn(fleet, 'create').mockResolvedValue()
    const ui = useUi()
    ui.openPalette()
    const wrapper = mount(CommandPalette)
    await wrapper.findAll('[data-test="palette-item"]')[0]?.trigger('click')
    expect(create).toHaveBeenCalled()
    expect(ui.open).toBe(false)
  })

  it('hovering an item makes it active', async () => {
    const fleet = useFleet()
    fleet.snapshots = [{ id: 'web-golden', vm: 'web', label: 'golden', size: 10 }]
    const ui = useUi()
    ui.openPalette()
    const wrapper = mount(CommandPalette)
    await wrapper.findAll('[data-test="palette-item"]')[1]?.trigger('mouseenter')
    expect(ui.index).toBe(1)
  })

  it('clicking the backdrop closes the palette', async () => {
    const ui = useUi()
    ui.openPalette()
    const wrapper = mount(CommandPalette)
    await wrapper.find('[data-test="palette-backdrop"]').trigger('click')
    expect(ui.open).toBe(false)
  })

  it('clicking inside the modal does not close the palette', async () => {
    const ui = useUi()
    ui.openPalette()
    const wrapper = mount(CommandPalette)
    await wrapper.find('[data-test="palette-modal"]').trigger('click')
    expect(ui.open).toBe(true)
  })

  it('autofocuses the input when opened', async () => {
    const ui = useUi()
    const wrapper = mount(CommandPalette, { attachTo: document.body })
    ui.openPalette()
    await flushPromises()
    expect(document.activeElement).toBe(wrapper.find('[data-test="palette-input"]').element)
    wrapper.unmount()
  })
})
