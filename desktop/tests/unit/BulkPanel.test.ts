import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, expect, it, vi } from 'vitest'
import BulkPanel from '../../src/components/BulkPanel.vue'
import { setToastScheduler } from '../../src/composables/useToasts'
import { useFleet } from '../../src/stores/fleet'
import { useUi } from '../../src/stores/ui'

beforeEach(() => {
  setActivePinia(createPinia())
  setToastScheduler(() => {})
})

it('shows the count and deletes with a two-step confirm', async () => {
  const s = useFleet()
  const ui = useUi()
  ui.selectOnly('a')
  ui.toggleSelect('b')
  const bulkNuke = vi.spyOn(s, 'bulkNuke').mockResolvedValue()
  const w = mount(BulkPanel)
  expect(w.text()).toContain('2 selected')
  await w.get('[data-test="bulk-delete"]').trigger('click') // arm
  expect(bulkNuke).not.toHaveBeenCalled()
  await w.get('[data-test="bulk-delete"]').trigger('click') // confirm
  expect(bulkNuke).toHaveBeenCalledWith(['a', 'b'])
})

it('suspends the selection', async () => {
  const s = useFleet()
  const ui = useUi()
  ui.selectOnly('a')
  ui.toggleSelect('b')
  const bulkSuspend = vi.spyOn(s, 'bulkSuspend').mockResolvedValue()
  const w = mount(BulkPanel)
  await w.get('[data-test="bulk-suspend"]').trigger('click')
  expect(bulkSuspend).toHaveBeenCalledWith(['a', 'b'])
})
