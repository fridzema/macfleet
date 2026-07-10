import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, expect, it, vi } from 'vitest'
import ContextMenu from '../../src/components/ContextMenu.vue'
import { useUi } from '../../src/stores/ui'

// Stub <Teleport> so the menu renders inside the wrapper (it teleports to body otherwise).
const mountOpts = { global: { stubs: { teleport: true } } }

beforeEach(() => setActivePinia(createPinia()))

it('renders items and runs + closes on click', async () => {
  const ui = useUi()
  const run = vi.fn()
  const w = mount(ContextMenu, mountOpts)
  ui.openContextMenu(5, 5, [{ label: 'Do it', run }])
  await w.vm.$nextTick()
  await w.get('[data-test="ctx-item"]').trigger('click')
  expect(run).toHaveBeenCalledOnce()
  expect(ui.contextMenu).toBeNull()
})

it('is hidden when there is no menu', () => {
  const w = mount(ContextMenu, mountOpts)
  expect(w.find('[data-test="context-menu"]').exists()).toBe(false)
})
