import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

let handler: ((e: { payload: { action: string; vm?: string } }) => void) | null = null
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((_name: string, cb: (e: unknown) => void) => {
    handler = cb as typeof handler
    return Promise.resolve(() => {})
  }),
}))

const push = vi.fn()
vi.mock('vue-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-router')>()),
  useRouter: () => ({ push }),
}))

import { setToastScheduler } from '../../src/composables/useToasts'
import { useTrayMenu } from '../../src/composables/useTrayMenu'
import { useFleet } from '../../src/stores/fleet'
import { useSettings } from '../../src/stores/settings'
import { useUi } from '../../src/stores/ui'

beforeEach(() => {
  setActivePinia(createPinia())
  setToastScheduler(() => {})
  handler = null
  push.mockClear()
})

async function fire(payload: { action: string; vm?: string }) {
  useTrayMenu()
  await flushPromises() // drain the chained dynamic import so `listen` registers `handler`
  handler?.({ payload })
  await flushPromises() // let the dispatch's awaits (router.push, store calls) settle
}

describe('useTrayMenu', () => {
  it('settings navigates to /settings', async () => {
    await fire({ action: 'settings' })
    expect(push).toHaveBeenCalledWith('/settings')
  })

  it('doctor navigates to settings and runs the checks', async () => {
    const spy = vi.spyOn(useSettings(), 'runDoctor').mockResolvedValue()
    await fire({ action: 'doctor' })
    expect(push).toHaveBeenCalledWith('/settings')
    expect(spy).toHaveBeenCalled()
  })

  it('new creates a VM', async () => {
    const spy = vi.spyOn(useFleet(), 'create').mockResolvedValue()
    await fire({ action: 'new' })
    expect(spy).toHaveBeenCalled()
  })

  it('show selects the named VM', async () => {
    const spy = vi.spyOn(useUi(), 'selectVm')
    await fire({ action: 'show', vm: 'web' })
    expect(spy).toHaveBeenCalledWith('web')
  })

  it('suspend-all suspends every running VM by short name', async () => {
    const fleet = useFleet()
    fleet.vms = [
      { name: 'mf-a', state: 'running', source: 'local', healthy: true },
      { name: 'mf-b', state: 'stopped', source: 'local', healthy: false },
    ] as never
    const spy = vi.spyOn(fleet, 'bulkSuspend').mockResolvedValue()
    await fire({ action: 'suspend-all' })
    expect(spy).toHaveBeenCalledWith(['a'])
  })

  it('ignores an unknown action', async () => {
    await fire({ action: 'nope' })
    expect(push).not.toHaveBeenCalled()
  })
})
