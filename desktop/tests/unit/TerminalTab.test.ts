import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import TerminalTab from '../../src/components/vmtabs/TerminalTab.vue'
import { setToastScheduler, useToasts } from '../../src/composables/useToasts'
import { api } from '../../src/shared/api'
import { useFleet } from '../../src/stores/fleet'

beforeEach(() => {
  setActivePinia(createPinia())
  setToastScheduler(() => {})
  useToasts().toasts.value = []
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('TerminalTab', () => {
  it('shows the guest-agent header line with the VM name', () => {
    const wrapper = mount(TerminalTab, { props: { name: 'web' } })
    expect(wrapper.find('[data-test="scrollback"]').text()).toContain(
      'macfleet guest-agent · in-guest shell · web',
    )
    wrapper.unmount()
  })

  it('Enter calls api.exec with (name, cmd) and appends stdout + exit code, clearing the input', async () => {
    const exec = vi.spyOn(api, 'exec').mockResolvedValue({ stdout: 'hello\n', exit_code: 0 })
    const wrapper = mount(TerminalTab, { props: { name: 'web' } })

    await wrapper.find('[data-test="term-input"]').setValue('echo hello')
    await wrapper.find('[data-test="term-input"]').trigger('keydown', { key: 'Enter' })
    await vi.waitFor(() => expect(exec).toHaveBeenCalled())
    await wrapper.vm.$nextTick()

    expect(exec).toHaveBeenCalledWith('web', 'echo hello')
    const entry = wrapper.find('[data-test="term-entry"]')
    expect(entry.text()).toContain('echo hello')
    expect(entry.text()).toContain('hello')
    expect(entry.find('[data-test="term-code"]').text()).toBe('exit 0')
    expect((wrapper.find('[data-test="term-input"]').element as HTMLInputElement).value).toBe('')
    wrapper.unmount()
  })

  it('Run button submits the same as Enter', async () => {
    const exec = vi.spyOn(api, 'exec').mockResolvedValue({ stdout: 'ok', exit_code: 0 })
    const wrapper = mount(TerminalTab, { props: { name: 'web' } })

    await wrapper.find('[data-test="term-input"]').setValue('ls')
    await wrapper.find('[data-test="run-btn"]').trigger('click')
    await vi.waitFor(() => expect(exec).toHaveBeenCalledWith('web', 'ls'))
    wrapper.unmount()
  })

  it('ignores keys other than Enter in the input', async () => {
    const exec = vi.spyOn(api, 'exec').mockResolvedValue({ stdout: 'ok', exit_code: 0 })
    const wrapper = mount(TerminalTab, { props: { name: 'web' } })

    await wrapper.find('[data-test="term-input"]').setValue('ls')
    await wrapper.find('[data-test="term-input"]').trigger('keydown', { key: 'a' })
    expect(exec).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('does not call api.exec for a blank command', async () => {
    const exec = vi.spyOn(api, 'exec').mockResolvedValue({ stdout: '', exit_code: 0 })
    const wrapper = mount(TerminalTab, { props: { name: 'web' } })
    await wrapper.find('[data-test="run-btn"]').trigger('click')
    expect(exec).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('a nonzero guest exit renders red but is not a toasted error', async () => {
    vi.spyOn(api, 'exec').mockResolvedValue({ stdout: 'not found', exit_code: 127 })
    const wrapper = mount(TerminalTab, { props: { name: 'web' } })

    await wrapper.find('[data-test="term-input"]').setValue('nope')
    await wrapper.find('[data-test="run-btn"]').trigger('click')
    await vi.waitFor(() => expect(wrapper.find('[data-test="term-code"]').text()).toBe('exit 127'))

    expect(wrapper.find('[data-test="term-code"]').classes()).toContain('text-[var(--red)]')
    expect(useToasts().toasts.value).toHaveLength(0)
    wrapper.unmount()
  })

  it('an exec network failure toasts and appends a distinct error entry, not a fake exit code', async () => {
    vi.spyOn(api, 'exec').mockRejectedValue(new Error('POST /vms/web/exec -> 500'))
    const wrapper = mount(TerminalTab, { props: { name: 'web' } })

    await wrapper.find('[data-test="term-input"]').setValue('ls')
    await wrapper.find('[data-test="run-btn"]').trigger('click')
    await vi.waitFor(() =>
      expect(wrapper.find('[data-test="term-code"]').text()).toBe('exec failed'),
    )

    expect(wrapper.find('[data-test="term-code"]').classes()).toContain('text-[var(--red)]')
    expect(useToasts().toasts.value.map((t) => t.msg)).toContain('Failed to run command on web')
    wrapper.unmount()
  })

  it('persists history in the store across a component remount for the same VM', async () => {
    vi.spyOn(api, 'exec').mockResolvedValue({ stdout: 'out', exit_code: 0 })
    const store = useFleet()
    let wrapper = mount(TerminalTab, { props: { name: 'web' } })
    await wrapper.find('[data-test="term-input"]').setValue('cmd1')
    await wrapper.find('[data-test="run-btn"]').trigger('click')
    await vi.waitFor(() => expect(store.terminalHistory.web).toHaveLength(1))
    wrapper.unmount()

    wrapper = mount(TerminalTab, { props: { name: 'web' } })
    expect(wrapper.findAll('[data-test="term-entry"]')).toHaveLength(1)
    wrapper.unmount()
  })

  it('keeps per-VM history separate', async () => {
    const store = useFleet()
    store.terminalHistory = {
      web: [{ cmd: 'a', out: 'A', code: 0 }],
      db: [{ cmd: 'b', out: 'B', code: 0 }],
    }
    const wrapper = mount(TerminalTab, { props: { name: 'web' } })
    expect(wrapper.findAll('[data-test="term-entry"]')).toHaveLength(1)
    expect(wrapper.text()).toContain('a')
    expect(wrapper.text()).not.toContain('cmd: b')
    wrapper.unmount()
  })
})
