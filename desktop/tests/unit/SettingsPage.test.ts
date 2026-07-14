import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setToastScheduler } from '../../src/composables/useToasts'
import SettingsPage from '../../src/pages/SettingsPage.vue'
import { api } from '../../src/shared/api'

// Deliberately distinct from macfleet/config.py's real defaults (2/4, 4/8, 8/16) so a
// regression to a hardcoded template table — the exact bug this page removes — fails here
// instead of accidentally matching these mock numbers.
const CONFIG = {
  default_preset: 'standard' as const,
  presets: {
    light: { cpu: 3, memory_gb: 6 },
    standard: { cpu: 5, memory_gb: 10 },
    heavy: { cpu: 9, memory_gb: 18 },
  },
}

beforeEach(() => {
  setActivePinia(createPinia())
  setToastScheduler(() => {})
  vi.spyOn(api, 'config').mockResolvedValue(CONFIG)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('SettingsPage — General', () => {
  it('renders a card per engine preset with its real cpu/RAM', async () => {
    const w = mount(SettingsPage)
    await flushPromises()
    const cards = w.findAll('[data-test^="preset-"]')
    expect(cards).toHaveLength(3)
    // Values come from the engine, not a local table.
    expect(w.get('[data-test="preset-heavy"]').text()).toContain('9')
    expect(w.get('[data-test="preset-heavy"]').text()).toContain('18')
  })

  it('marks the configured default as selected', async () => {
    const w = mount(SettingsPage)
    await flushPromises()
    expect(w.get('[data-test="preset-standard"]').attributes('aria-checked')).toBe('true')
    expect(w.get('[data-test="preset-light"]').attributes('aria-checked')).toBe('false')
  })

  it('writes the new default when a card is clicked', async () => {
    const spy = vi
      .spyOn(api, 'setConfig')
      .mockResolvedValue({ ...CONFIG, default_preset: 'heavy' as const })
    const w = mount(SettingsPage)
    await flushPromises()
    await w.get('[data-test="preset-heavy"]').trigger('click')
    expect(spy).toHaveBeenCalledWith('heavy')
  })

  it('does not re-write the default that is already set', async () => {
    const spy = vi.spyOn(api, 'setConfig')
    const w = mount(SettingsPage)
    await flushPromises()
    await w.get('[data-test="preset-standard"]').trigger('click')
    expect(spy).not.toHaveBeenCalled()
  })
})
