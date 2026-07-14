import { defineStore } from 'pinia'
import { ref } from 'vue'
import { useToasts } from '../composables/useToasts'
import {
  api,
  type DoctorCheck,
  type Preset,
  type PresetName,
  type ResetResult,
  type ResetScope,
} from '../shared/api'

export const useSettings = defineStore('settings', () => {
  const { add: toast } = useToasts()

  const presets = ref<Record<PresetName, Preset> | null>(null)
  const defaultPreset = ref<PresetName>('standard')
  const loaded = ref(false)

  const checks = ref<DoctorCheck[]>([])
  const doctorRunning = ref(false)
  const doctorError = ref<string | null>(null)

  const resetting = ref(false)

  // Shared in-flight promise. create() calls load() defensively on every create, and the
  // Settings page calls it on mount — without this, a create during boot fires a second
  // GET /config. Cleared on failure so a later call retries rather than replaying the
  // rejection forever (same reasoning as api.ts's configPromise).
  let inFlight: Promise<void> | null = null

  async function load(): Promise<void> {
    if (loaded.value) return
    if (inFlight) return inFlight
    const p = (async () => {
      try {
        const cfg = await api.config()
        presets.value = cfg.presets
        defaultPreset.value = cfg.default_preset
        loaded.value = true
      } catch (e) {
        toast(`Could not load settings: ${e}`, '⚠')
      } finally {
        inFlight = null
      }
    })()
    inFlight = p
    return p
  }

  async function setDefaultPreset(p: PresetName): Promise<void> {
    try {
      const cfg = await api.setConfig(p)
      // Trust the engine's echo, not the local guess — it is the authority on what stuck.
      defaultPreset.value = cfg.default_preset
      toast(`Default size set to ${cfg.default_preset}`, '✓')
    } catch (e) {
      toast(`Could not save default size: ${e}`, '⚠')
    }
  }

  async function runDoctor(): Promise<void> {
    doctorRunning.value = true
    doctorError.value = null
    try {
      checks.value = await api.doctor()
    } catch (e) {
      // Doctor is opened precisely when things are broken; an unreachable engine is a
      // reportable state, not a spinner.
      doctorError.value = String(e)
    } finally {
      doctorRunning.value = false
    }
  }

  async function resetData(scope: ResetScope): Promise<ResetResult | null> {
    resetting.value = true
    try {
      const res = await api.resetData(scope)
      if (res.failed.length > 0) {
        toast(`Could not delete ${res.failed.map((f) => f.name).join(', ')}`, '⚠')
      } else {
        toast(`Removed ${res.deleted.length} VM(s)`, '✓')
      }
      return res
    } catch (e) {
      toast(`Reset failed: ${e}`, '⚠')
      return null
    } finally {
      resetting.value = false
    }
  }

  return {
    presets,
    defaultPreset,
    loaded,
    checks,
    doctorRunning,
    doctorError,
    resetting,
    load,
    setDefaultPreset,
    runDoctor,
    resetData,
  }
})
