import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { defineComponent } from 'vue'
import { useHotkeys } from '../../src/composables/useHotkeys'

function mountHost(cb: () => void) {
  const Host = defineComponent({
    setup() {
      useHotkeys(cb)
      return () => null
    },
  })
  return mount(Host)
}

describe('useHotkeys', () => {
  it('calls the callback and prevents default on Cmd+K', () => {
    const cb = vi.fn()
    mountHost(cb)
    const e = new KeyboardEvent('keydown', { key: 'k', metaKey: true, cancelable: true })
    const preventDefault = vi.spyOn(e, 'preventDefault')
    window.dispatchEvent(e)
    expect(cb).toHaveBeenCalledTimes(1)
    expect(preventDefault).toHaveBeenCalled()
  })

  it('calls the callback on Ctrl+K, case-insensitively', () => {
    const cb = vi.fn()
    mountHost(cb)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'K', ctrlKey: true }))
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('ignores K without a modifier', () => {
    const cb = vi.fn()
    mountHost(cb)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k' }))
    expect(cb).not.toHaveBeenCalled()
  })

  it('ignores a modifier held with a different key', () => {
    const cb = vi.fn()
    mountHost(cb)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', metaKey: true }))
    expect(cb).not.toHaveBeenCalled()
  })

  it('removes the listener on unmount', () => {
    const cb = vi.fn()
    const wrapper = mountHost(cb)
    wrapper.unmount()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))
    expect(cb).not.toHaveBeenCalled()
  })
})
