import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, expect, it, vi } from 'vitest'
import FoldersTab from '../../src/components/vmtabs/FoldersTab.vue'
import { setToastScheduler } from '../../src/composables/useToasts'
import { api } from '../../src/shared/api'
import { useFleet } from '../../src/stores/fleet'

beforeEach(() => {
  setActivePinia(createPinia())
  setToastScheduler(() => {})
})

it('lists shares and removes one via setShares', async () => {
  vi.spyOn(api, 'getShares').mockResolvedValue({
    shares: [{ tag: 'src', host_path: '/h', read_only: true }],
  })
  const s = useFleet()
  const setShares = vi.spyOn(s, 'setShares').mockResolvedValue()
  const w = mount(FoldersTab, { props: { name: 'web' } })
  await flushPromises()
  expect(w.text()).toContain('src')
  await w.get('[data-test="folders-remove"]').trigger('click')
  expect(setShares).toHaveBeenCalledWith('web', [])
})

it('adds a folder from the path input, defaulting the tag to the basename', async () => {
  vi.spyOn(api, 'getShares').mockResolvedValue({ shares: [] })
  const s = useFleet()
  const setShares = vi.spyOn(s, 'setShares').mockResolvedValue()
  const w = mount(FoldersTab, { props: { name: 'web' } })
  await flushPromises()
  await w.get('[data-test="folders-add-path"]').setValue('/Users/me/src')
  await w.get('[data-test="folders-add"]').trigger('click')
  expect(setShares).toHaveBeenCalledWith('web', [
    { tag: 'src', host_path: '/Users/me/src', read_only: true },
  ])
})
