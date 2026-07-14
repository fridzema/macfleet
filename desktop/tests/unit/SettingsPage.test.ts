import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setToastScheduler } from '../../src/composables/useToasts'
import SettingsPage from '../../src/pages/SettingsPage.vue'
import { api } from '../../src/shared/api'

vi.mock('@tauri-apps/plugin-dialog', () => ({ confirm: vi.fn() }))

import { confirm } from '@tauri-apps/plugin-dialog'

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
  vi.spyOn(api, 'doctor').mockResolvedValue([])
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

describe('SettingsPage — Data', () => {
  it('does not reset when the confirm is declined', async () => {
    vi.mocked(confirm).mockResolvedValue(false)
    const spy = vi.spyOn(api, 'resetData')
    const w = mount(SettingsPage)
    await flushPromises()
    await w.get('[data-test="reset-fleet"]').trigger('click')
    await flushPromises()
    // A stray click must never delete a fleet.
    expect(spy).not.toHaveBeenCalled()
  })

  it('resets with scope fleet when confirmed', async () => {
    vi.mocked(confirm).mockResolvedValue(true)
    const spy = vi
      .spyOn(api, 'resetData')
      .mockResolvedValue({ deleted: ['mf-a'], failed: [], removed_paths: [] })
    const w = mount(SettingsPage)
    await flushPromises()
    await w.get('[data-test="reset-fleet"]').trigger('click')
    await flushPromises()
    expect(spy).toHaveBeenCalledWith('fleet')
  })

  it('resets with scope all from the full-reset button', async () => {
    vi.mocked(confirm).mockResolvedValue(true)
    const spy = vi
      .spyOn(api, 'resetData')
      .mockResolvedValue({ deleted: [], failed: [], removed_paths: [] })
    const w = mount(SettingsPage)
    await flushPromises()
    await w.get('[data-test="reset-all"]').trigger('click')
    await flushPromises()
    expect(spy).toHaveBeenCalledWith('all')
  })

  it('warns that golden needs a re-bake in the full-reset confirmation', async () => {
    vi.mocked(confirm).mockResolvedValue(false)
    const w = mount(SettingsPage)
    await flushPromises()
    await w.get('[data-test="reset-all"]').trigger('click')
    const message = String(vi.mocked(confirm).mock.calls.at(-1)?.[0])
    expect(message.toLowerCase()).toContain('re-bake')
  })

  it('refreshes the fleet after a reset so the sidebar drops dead VMs', async () => {
    vi.mocked(confirm).mockResolvedValue(true)
    vi.spyOn(api, 'resetData').mockResolvedValue({
      deleted: ['mf-a'],
      failed: [],
      removed_paths: [],
    })
    const listSpy = vi.spyOn(api, 'listVms').mockResolvedValue([])
    vi.spyOn(api, 'listSnapshots').mockResolvedValue([])
    const w = mount(SettingsPage)
    await flushPromises()
    await w.get('[data-test="reset-fleet"]').trigger('click')
    await flushPromises()
    expect(listSpy).toHaveBeenCalled()
  })
})

const CHECKS = [
  { id: 'arch', label: 'Apple silicon', status: 'ok' as const, detail: 'arm64', fix: null },
  {
    id: 'golden_warm',
    label: 'Golden image warm',
    status: 'warn' as const,
    detail: "state is 'stopped'",
    fix: 'macfleet warm',
  },
  {
    id: 'tcc_screenshot',
    label: 'Screen recording permission',
    status: 'skip' as const,
    detail: 'computer-use disabled',
    fix: null,
  },
]

describe('SettingsPage — Doctor', () => {
  it('runs the checks on mount', async () => {
    const spy = vi.spyOn(api, 'doctor').mockResolvedValue(CHECKS)
    mount(SettingsPage)
    await flushPromises()
    expect(spy).toHaveBeenCalled()
  })

  it('renders a row per check with its label and detail', async () => {
    vi.spyOn(api, 'doctor').mockResolvedValue(CHECKS)
    const w = mount(SettingsPage)
    await flushPromises()
    expect(w.findAll('[data-test^="check-"]')).toHaveLength(3)
    const warm = w.get('[data-test="check-golden_warm"]')
    expect(warm.text()).toContain('Golden image warm')
    expect(warm.text()).toContain("state is 'stopped'")
  })

  it('shows the fix hint when the engine gives one', async () => {
    vi.spyOn(api, 'doctor').mockResolvedValue(CHECKS)
    const w = mount(SettingsPage)
    await flushPromises()
    expect(w.get('[data-test="check-golden_warm"]').text()).toContain('macfleet warm')
    expect(w.get('[data-test="check-arch"]').text()).not.toContain('macfleet')
  })

  it('re-runs the checks on demand', async () => {
    const spy = vi.spyOn(api, 'doctor').mockResolvedValue(CHECKS)
    const w = mount(SettingsPage)
    await flushPromises()
    await w.get('[data-test="doctor-run"]').trigger('click')
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('reports an unreachable engine instead of showing an empty check list', async () => {
    vi.spyOn(api, 'doctor').mockRejectedValue(new Error('connection refused'))
    const w = mount(SettingsPage)
    await flushPromises()
    // Engine down is when a user opens Doctor — silence would be the worst answer.
    expect(w.get('[data-test="doctor-error"]').text()).toContain('connection refused')
  })
})
