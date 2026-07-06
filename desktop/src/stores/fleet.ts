import { defineStore } from 'pinia'
import { ref } from 'vue'
import { api, type Vm } from '../shared/api'

export const useFleet = defineStore('fleet', () => {
  const vms = ref<Vm[]>([])
  const error = ref<string | null>(null)

  async function refresh(): Promise<void> {
    try {
      // Only mf- fleet VMs are operable; base/OCI images can't be controlled, and
      // mf-golden is the read-only clone template, not a work VM.
      vms.value = (await api.listVms()).filter(
        (v) => v.name.startsWith('mf-') && v.name !== 'mf-golden',
      )
      error.value = null
    } catch (e) {
      error.value = String(e)
    }
  }

  // Surface API failures on `error` rather than rejecting into the caller's event
  // handler (which Vue reports as an unhandled error). Refresh only on success so a
  // failed op's message isn't cleared by the follow-up list fetch.
  async function run(fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn()
      await refresh()
    } catch (e) {
      error.value = String(e)
    }
  }

  const up = (name: string) => run(() => api.up(name))
  const down = (name: string) => run(() => api.down(name))
  const nuke = (name: string) => run(() => api.nuke(name))

  return { vms, error, refresh, up, down, nuke }
})
