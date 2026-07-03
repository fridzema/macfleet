import { defineStore } from 'pinia'
import { ref } from 'vue'
import { api, type Vm } from '../shared/api'

export const useFleet = defineStore('fleet', () => {
  const vms = ref<Vm[]>([])
  const error = ref<string | null>(null)

  async function refresh(): Promise<void> {
    try {
      vms.value = await api.listVms()
      error.value = null
    } catch (e) {
      error.value = String(e)
    }
  }

  async function up(name: string): Promise<void> {
    await api.up(name)
    await refresh()
  }
  async function down(name: string): Promise<void> {
    await api.down(name)
    await refresh()
  }
  async function nuke(name: string): Promise<void> {
    await api.nuke(name)
    await refresh()
  }

  return { vms, error, refresh, up, down, nuke }
})
