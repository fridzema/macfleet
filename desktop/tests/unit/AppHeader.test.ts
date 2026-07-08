import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import AppHeader from '../../src/components/AppHeader.vue'
import { useDarkMode } from '../../src/composables/useDarkMode'
import { api } from '../../src/shared/api'
import { useFleet } from '../../src/stores/fleet'
import { useUi } from '../../src/stores/ui'

vi.mock('../../src/composables/useDarkMode', () => ({
  useDarkMode: vi.fn(),
}))

let toggleDark: ReturnType<typeof vi.fn>

beforeEach(() => {
  setActivePinia(createPinia())
  toggleDark = vi.fn()
  vi.mocked(useDarkMode).mockReturnValue({ isDark: ref(false), toggleDark })
})

afterEach(() => vi.restoreAllMocks())

describe('AppHeader', () => {
  it('renders logo, search, palette trigger, capacity chip, agent indicator, theme toggle', async () => {
    vi.spyOn(api, 'host').mockResolvedValue({ total_mem_gb: 32, cpu_count: 8, name: 'Mac' })
    const wrapper = mount(AppHeader)
    await flushPromises()
    expect(wrapper.text()).toContain('macfleet')
    expect(wrapper.find('input').exists()).toBe(true)
    expect(wrapper.find('[data-test="palette-trigger"]').text()).toContain('⌘K')
    expect(wrapper.find('[data-test="capacity-chip"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="agent-trigger"]').exists()).toBe(true)
    expect(wrapper.find('button[title="Toggle theme"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('fetches host on mount and binds the search input to ui.search', async () => {
    const host = vi
      .spyOn(api, 'host')
      .mockResolvedValue({ total_mem_gb: 32, cpu_count: 8, name: 'Mac' })
    const wrapper = mount(AppHeader)
    const ui = useUi()
    await flushPromises()
    expect(host).toHaveBeenCalledTimes(1)
    await wrapper.find('input').setValue('web')
    expect(ui.search).toBe('web')
    wrapper.unmount()
  })

  it('clicking the palette trigger opens the command palette', async () => {
    vi.spyOn(api, 'host').mockResolvedValue({ total_mem_gb: 32, cpu_count: 8, name: 'Mac' })
    const wrapper = mount(AppHeader)
    const ui = useUi()
    await wrapper.find('[data-test="palette-trigger"]').trigger('click')
    expect(ui.open).toBe(true)
    wrapper.unmount()
  })

  it('⌘K opens the command palette', async () => {
    vi.spyOn(api, 'host').mockResolvedValue({ total_mem_gb: 32, cpu_count: 8, name: 'Mac' })
    const wrapper = mount(AppHeader)
    const ui = useUi()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))
    expect(ui.open).toBe(true)
    wrapper.unmount()
  })

  it('shows the running count plus host memory once the host loads', async () => {
    vi.spyOn(api, 'host').mockResolvedValue({ total_mem_gb: 32, cpu_count: 8, name: 'Mac' })
    const fleet = useFleet()
    fleet.vms = [
      { name: 'mf-a', state: 'running', source: 'local', healthy: true },
      { name: 'mf-b', state: 'stopped', source: 'local', healthy: false },
    ]
    const wrapper = mount(AppHeader)
    await flushPromises()
    const text = wrapper.find('[data-test="capacity-chip"]').text()
    expect(text).toContain('1 running')
    expect(text).toContain('32 GB')
    wrapper.unmount()
  })

  it('shows just the running count when the host has not loaded', async () => {
    vi.spyOn(api, 'host').mockRejectedValue(new Error('unreachable'))
    const fleet = useFleet()
    fleet.vms = [{ name: 'mf-a', state: 'running', source: 'local', healthy: true }]
    const wrapper = mount(AppHeader)
    await flushPromises()
    const text = wrapper.find('[data-test="capacity-chip"]').text()
    expect(text).toContain('1 running')
    expect(text).not.toContain('GB')
    wrapper.unmount()
  })

  it('shows the moon icon and "switch to light" label in dark mode', async () => {
    vi.spyOn(api, 'host').mockResolvedValue({ total_mem_gb: 32, cpu_count: 8, name: 'Mac' })
    vi.mocked(useDarkMode).mockReturnValue({ isDark: ref(true), toggleDark })
    const wrapper = mount(AppHeader)
    await flushPromises()
    const button = wrapper.find('button[title="Toggle theme"]')
    expect(button.text()).toBe('☾')
    expect(button.attributes('aria-label')).toBe('Switch to light mode')
    wrapper.unmount()
  })

  it('shows the sun icon in light mode and toggles the theme on click', async () => {
    vi.spyOn(api, 'host').mockResolvedValue({ total_mem_gb: 32, cpu_count: 8, name: 'Mac' })
    const wrapper = mount(AppHeader)
    await flushPromises()
    const button = wrapper.find('button[title="Toggle theme"]')
    expect(button.text()).toBe('☀')
    expect(button.attributes('aria-label')).toBe('Switch to dark mode')
    await button.trigger('click')
    expect(toggleDark).toHaveBeenCalled()
    wrapper.unmount()
  })
})
