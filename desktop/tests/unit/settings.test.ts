import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setToastScheduler, useToasts } from '../../src/composables/useToasts'
import { api } from '../../src/shared/api'
import { useSettings } from '../../src/stores/settings'

const CONFIG = {
  default_preset: 'standard' as const,
  presets: {
    light: { cpu: 2, memory_gb: 4 },
    standard: { cpu: 4, memory_gb: 8 },
    heavy: { cpu: 8, memory_gb: 16 },
  },
}

beforeEach(() => {
  setActivePinia(createPinia())
  setToastScheduler(() => {})
  useToasts().toasts.value = []
})

describe('settings store', () => {
  it('load fetches config once and is idempotent', async () => {
    const spy = vi.spyOn(api, 'config').mockResolvedValue(CONFIG)
    const s = useSettings()
    await s.load()
    await s.load()
    // A second load must not re-hit the engine — create() calls this defensively on every
    // create, so a non-idempotent load would fire an HTTP request per VM created.
    expect(spy).toHaveBeenCalledTimes(1)
    expect(s.loaded).toBe(true)
    expect(s.defaultPreset).toBe('standard')
    expect(s.presets?.heavy).toEqual({ cpu: 8, memory_gb: 16 })
  })

  it('load surfaces an error and stays unloaded so a later load retries', async () => {
    const spy = vi.spyOn(api, 'config').mockRejectedValueOnce(new Error('boom'))
    const s = useSettings()
    await s.load()
    expect(s.loaded).toBe(false)
    expect(s.presets).toBeNull()
    spy.mockResolvedValue(CONFIG)
    await s.load()
    expect(s.loaded).toBe(true)
  })

  it('concurrent loads share one request', async () => {
    const spy = vi.spyOn(api, 'config').mockResolvedValue(CONFIG)
    spy.mockClear() // call count accumulates across this file's shared spy
    const s = useSettings()
    await Promise.all([s.load(), s.load(), s.load()])
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('setDefaultPreset writes through and updates state', async () => {
    vi.spyOn(api, 'config').mockResolvedValue(CONFIG)
    const spy = vi
      .spyOn(api, 'setConfig')
      .mockResolvedValue({ ...CONFIG, default_preset: 'heavy' as const })
    const s = useSettings()
    await s.load()
    await s.setDefaultPreset('heavy')
    expect(spy).toHaveBeenCalledWith('heavy')
    expect(s.defaultPreset).toBe('heavy')
  })

  it('setDefaultPreset leaves state untouched when the write fails', async () => {
    vi.spyOn(api, 'config').mockResolvedValue(CONFIG)
    vi.spyOn(api, 'setConfig').mockRejectedValue(new Error('409'))
    const s = useSettings()
    await s.load()
    await s.setDefaultPreset('heavy')
    // Optimistic UI would leave the picker showing a default the engine never accepted.
    expect(s.defaultPreset).toBe('standard')
    expect(useToasts().toasts.value.length).toBeGreaterThan(0)
  })

  it('runDoctor stores checks and clears the running flag', async () => {
    const checks = [
      { id: 'arch', label: 'Apple silicon', status: 'ok' as const, detail: 'arm64', fix: null },
    ]
    vi.spyOn(api, 'doctor').mockResolvedValue(checks)
    const s = useSettings()
    await s.runDoctor()
    expect(s.checks).toEqual(checks)
    expect(s.doctorRunning).toBe(false)
    expect(s.doctorError).toBeNull()
  })

  it('runDoctor records an error when the engine is unreachable', async () => {
    vi.spyOn(api, 'doctor').mockRejectedValue(new Error('connection refused'))
    const s = useSettings()
    await s.runDoctor()
    // Engine down is exactly when Doctor is opened — it must say so, not spin.
    expect(s.doctorError).toContain('connection refused')
    expect(s.doctorRunning).toBe(false)
    expect(s.checks).toEqual([])
  })

  it('resetData returns the result and toasts what went', async () => {
    vi.spyOn(api, 'resetData').mockResolvedValue({
      deleted: ['mf-a', 'mf-b'],
      failed: [],
      removed_paths: ['/x/state.json'],
    })
    const s = useSettings()
    const res = await s.resetData('fleet')
    expect(res?.deleted).toEqual(['mf-a', 'mf-b'])
    expect(s.resetting).toBe(false)
    expect(useToasts().toasts.value.length).toBeGreaterThan(0)
  })

  it('resetData surfaces per-VM failures rather than reporting success', async () => {
    vi.spyOn(api, 'resetData').mockResolvedValue({
      deleted: ['mf-a'],
      failed: [{ name: 'mf-b', error: 'busy' }],
      removed_paths: [],
    })
    const s = useSettings()
    await s.resetData('fleet')
    const text = useToasts()
      .toasts.value.map((t) => t.msg)
      .join(' ')
    expect(text).toContain('mf-b')
  })

  it('resetData returns null and toasts when the request itself fails', async () => {
    vi.spyOn(api, 'resetData').mockRejectedValue(new Error('409 conflict'))
    const s = useSettings()
    expect(await s.resetData('all')).toBeNull()
    expect(s.resetting).toBe(false)
    expect(useToasts().toasts.value.length).toBeGreaterThan(0)
  })

  it('resetData("all") reloads settings from the engine so a stale default cannot survive', async () => {
    const configSpy = vi.spyOn(api, 'config')
    configSpy.mockClear() // call count accumulates across this file's shared spy
    configSpy.mockResolvedValueOnce({ ...CONFIG, default_preset: 'heavy' as const })
    const s = useSettings()
    await s.load()
    expect(s.defaultPreset).toBe('heavy')

    vi.spyOn(api, 'resetData').mockResolvedValue({ deleted: [], failed: [], removed_paths: [] })
    configSpy.mockResolvedValueOnce({ ...CONFIG, default_preset: 'standard' as const })
    await s.resetData('all')

    // connect.py -> config.reset() drops the config file, so the engine now serves the
    // default (config.py's DEFAULT_PRESET) rather than the 'heavy' this session set earlier.
    expect(s.defaultPreset).toBe('standard')
    expect(configSpy).toHaveBeenCalledTimes(2)
  })

  it('resetData("fleet") does not touch settings — the engine never resets config for it', async () => {
    const configSpy = vi.spyOn(api, 'config').mockResolvedValue(CONFIG)
    const s = useSettings()
    await s.load()
    configSpy.mockClear()

    vi.spyOn(api, 'resetData').mockResolvedValue({ deleted: [], failed: [], removed_paths: [] })
    await s.resetData('fleet')

    expect(configSpy).not.toHaveBeenCalled()
  })
})
