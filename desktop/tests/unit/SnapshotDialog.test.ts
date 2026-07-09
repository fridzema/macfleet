import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import SnapshotDialog from '../../src/components/SnapshotDialog.vue'
import { useFleet } from '../../src/stores/fleet'
import { useUi } from '../../src/stores/ui'

beforeEach(() => setActivePinia(createPinia()))
afterEach(() => vi.useRealTimers())

it('prefills a timestamp label and snapshots each target with a sanitized label', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 6, 9, 15, 23, 1))
  const ui = useUi()
  const fleet = useFleet()
  const snap = vi.spyOn(fleet, 'snapshotVM').mockResolvedValue()
  const w = mount(SnapshotDialog)
  ui.requestSnapshot(['web'])
  await w.vm.$nextTick()
  const input = w.get('[data-test="snapshot-label"]')
  expect((input.element as HTMLInputElement).value).toBe('20260709.152301')
  await input.setValue('my snap')
  await w.get('[data-test="snapshot-save"]').trigger('click')
  expect(snap).toHaveBeenCalledWith('web', 'my.snap')
  expect(ui.snapshotTarget).toBeNull()
})

it('is hidden when there is no target', () => {
  const w = mount(SnapshotDialog)
  expect(w.find('[data-test="snapshot-dialog"]').exists()).toBe(false)
})
