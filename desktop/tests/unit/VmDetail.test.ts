import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import VmDetail from '../../src/components/VmDetail.vue'
import { setToastScheduler, useToasts } from '../../src/composables/useToasts'
import { api } from '../../src/shared/api'
import { useFleet } from '../../src/stores/fleet'
import { useUi } from '../../src/stores/ui'

const running = { name: 'web', state: 'running', healthy: true }
const stopped = { name: 'web', state: 'stopped', healthy: false }

beforeEach(() => {
  setActivePinia(createPinia())
  // Toasts triggered by the fleet mutations below default to a real setTimeout —
  // swap in a no-op so nothing dangles past a test.
  setToastScheduler(() => {})
  useToasts().toasts.value = []
  vi.spyOn(api, 'resources').mockResolvedValue({
    cpu: 4,
    memory_mb: 8192,
    disk_gb: 50,
    display: '1920x1080',
    state: 'running',
  })
})

afterEach(() => vi.restoreAllMocks())

describe('VmDetail — header', () => {
  it('shows the running badge and fetched resource chips', async () => {
    const wrapper = mount(VmDetail, { props: running })
    await flushPromises()
    expect(wrapper.find('[data-test="status-badge"]').text()).toBe('Running')
    expect(wrapper.find('[data-test="chip-cpu"]').text()).toBe('4 vCPU')
    expect(wrapper.find('[data-test="chip-ram"]').text()).toBe('8 GB')
    expect(wrapper.find('[data-test="chip-disk"]').text()).toBe('50 GB')
    wrapper.unmount()
  })

  it('shows the stopped badge for a non-running, unhealthy VM', async () => {
    const wrapper = mount(VmDetail, { props: stopped })
    await flushPromises()
    expect(wrapper.find('[data-test="status-badge"]').text()).toBe('Stopped')
    wrapper.unmount()
  })

  it('re-fetches resources when the selected VM changes', async () => {
    const resources = vi.spyOn(api, 'resources')
    const wrapper = mount(VmDetail, { props: running })
    await flushPromises()
    expect(resources).toHaveBeenCalledWith('web')
    await wrapper.setProps({ name: 'db', state: 'running', healthy: true })
    await flushPromises()
    expect(resources).toHaveBeenCalledWith('db')
    wrapper.unmount()
  })
})

describe('VmDetail — actions', () => {
  it('Suspend calls store.suspend when running', async () => {
    const store = useFleet()
    const suspend = vi.spyOn(store, 'suspend').mockResolvedValue()
    const wrapper = mount(VmDetail, { props: running })
    await wrapper.find('[data-test="suspend-resume-btn"]').trigger('click')
    expect(suspend).toHaveBeenCalledWith('web')
    wrapper.unmount()
  })

  it('shows Resume and calls store.resume when not running', async () => {
    const store = useFleet()
    const resume = vi.spyOn(store, 'resume').mockResolvedValue()
    const wrapper = mount(VmDetail, { props: stopped })
    expect(wrapper.find('[data-test="suspend-resume-btn"]').text()).toContain('Resume')
    await wrapper.find('[data-test="suspend-resume-btn"]').trigger('click')
    expect(resume).toHaveBeenCalledWith('web')
    wrapper.unmount()
  })

  it('Snapshot calls store.snapshotVM with a default "<name>-snap" label', async () => {
    const store = useFleet()
    const snapshotVM = vi.spyOn(store, 'snapshotVM').mockResolvedValue()
    const wrapper = mount(VmDetail, { props: running })
    await wrapper.find('[data-test="snapshot-btn"]').trigger('click')
    expect(snapshotVM).toHaveBeenCalledWith('web', 'web-snap')
    wrapper.unmount()
  })

  it('Duplicate calls store.duplicate', async () => {
    const store = useFleet()
    const duplicate = vi.spyOn(store, 'duplicate').mockResolvedValue()
    const wrapper = mount(VmDetail, { props: running })
    await wrapper.find('[data-test="duplicate-btn"]').trigger('click')
    expect(duplicate).toHaveBeenCalledWith('web')
    wrapper.unmount()
  })

  it('Connect switches store.selectedTab to "connect"', async () => {
    const store = useFleet()
    const wrapper = mount(VmDetail, { props: running })
    await wrapper.find('[data-test="connect-btn"]').trigger('click')
    expect(store.selectedTab).toBe('connect')
    wrapper.unmount()
  })
})

describe('VmDetail — tab bar', () => {
  it('defaults to the Screen tab and switches store.selectedTab, rendering each tab', async () => {
    const store = useFleet()
    // ScreenTab (Task 8) reads live VM state from the store itself rather than via
    // props — seed it to match `running` so its frame renders instead of falling back
    // to the "not found" overlay.
    store.vms = [{ ...running, name: 'mf-web', source: 'local' }]
    const wrapper = mount(VmDetail, { props: running })
    expect(store.selectedTab).toBe('screen')
    expect(wrapper.find('[data-test="screen-frame"]').exists()).toBe(true)

    await wrapper.find('[data-test="tab-terminal"]').trigger('click')
    expect(store.selectedTab).toBe('terminal')
    expect(wrapper.text()).toContain('Terminal — coming in Task 9')

    await wrapper.find('[data-test="tab-logs"]').trigger('click')
    expect(store.selectedTab).toBe('logs')
    expect(wrapper.text()).toContain('Logs — coming in Task 10')

    await wrapper.find('[data-test="tab-resources"]').trigger('click')
    expect(store.selectedTab).toBe('resources')
    expect(wrapper.text()).toContain('Resources — coming in Task 11')

    await wrapper.find('[data-test="tab-connect"]').trigger('click')
    expect(store.selectedTab).toBe('connect')
    expect(wrapper.text()).toContain('Connect — coming in Task 12')
    wrapper.unmount()
  })
})

describe('VmDetail — inline rename', () => {
  it('clicking the name arms ui.renaming, prefilled with the current name', async () => {
    const wrapper = mount(VmDetail, { props: running })
    const ui = useUi()
    await wrapper.find('[data-test="rename-display"]').trigger('click')
    expect(ui.renaming).toBe(true)
    expect(ui.renameValue).toBe('web')
    wrapper.unmount()
  })

  it('Enter commits the renamed value via store.rename and closes the input', async () => {
    const store = useFleet()
    const rename = vi.spyOn(store, 'rename').mockResolvedValue()
    const wrapper = mount(VmDetail, { props: running })
    const ui = useUi()
    ui.startRename('web')
    await wrapper.vm.$nextTick()
    await wrapper.find('[data-test="rename-input"]').setValue('renamed vm')
    await wrapper.find('[data-test="rename-input"]').trigger('keydown', { key: 'Enter' })
    expect(rename).toHaveBeenCalledWith('web', 'renamed-vm')
    expect(ui.renaming).toBe(false)
    wrapper.unmount()
  })

  it('Escape cancels without calling store.rename', async () => {
    const store = useFleet()
    const rename = vi.spyOn(store, 'rename').mockResolvedValue()
    const wrapper = mount(VmDetail, { props: running })
    const ui = useUi()
    ui.startRename('web')
    await wrapper.vm.$nextTick()
    await wrapper.find('[data-test="rename-input"]').setValue('ignored')
    await wrapper.find('[data-test="rename-input"]').trigger('keydown', { key: 'Escape' })
    expect(rename).not.toHaveBeenCalled()
    expect(ui.renaming).toBe(false)
    wrapper.unmount()
  })
})

describe('VmDetail — two-step delete', () => {
  it('clicking delete arms ui.confirmDeleteVm without deleting', async () => {
    const store = useFleet()
    const nuke = vi.spyOn(store, 'nuke').mockResolvedValue()
    const wrapper = mount(VmDetail, { props: running })
    const ui = useUi()
    await wrapper.find('[data-test="delete-btn"]').trigger('click')
    expect(ui.confirmDeleteVm).toBe(true)
    expect(nuke).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('confirming with Yes calls store.nuke and clears the confirm flag', async () => {
    const store = useFleet()
    const nuke = vi.spyOn(store, 'nuke').mockResolvedValue()
    const wrapper = mount(VmDetail, { props: running })
    const ui = useUi()
    ui.askDeleteVm('web')
    await wrapper.vm.$nextTick()
    await wrapper.find('[data-test="delete-yes"]').trigger('click')
    expect(nuke).toHaveBeenCalledWith('web')
    expect(ui.confirmDeleteVm).toBe(false)
    wrapper.unmount()
  })

  it('cancelling with No clears the confirm flag without deleting', async () => {
    const store = useFleet()
    const nuke = vi.spyOn(store, 'nuke').mockResolvedValue()
    const wrapper = mount(VmDetail, { props: running })
    const ui = useUi()
    ui.askDeleteVm('web')
    await wrapper.vm.$nextTick()
    await wrapper.find('[data-test="delete-no"]').trigger('click')
    expect(nuke).not.toHaveBeenCalled()
    expect(ui.confirmDeleteVm).toBe(false)
    wrapper.unmount()
  })
})

describe('VmDetail — wrong-VM guard on prop change', () => {
  it('changing the name prop clears an armed delete confirm so Yes cannot nuke the new VM', async () => {
    const store = useFleet()
    const nuke = vi.spyOn(store, 'nuke').mockResolvedValue()
    const wrapper = mount(VmDetail, { props: running })
    const ui = useUi()
    // Arm delete on "web".
    ui.askDeleteVm('web')
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-test="delete-yes"]').exists()).toBe(true)
    // Now the instance is shown for a different VM: the stale confirm must vanish.
    await wrapper.setProps({ name: 'db', state: 'running', healthy: true })
    expect(ui.confirmDeleteVm).toBe(false)
    expect(wrapper.find('[data-test="delete-yes"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="delete-btn"]').exists()).toBe(true)
    expect(nuke).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('changing the name prop closes an open rename input so Enter cannot rename the new VM', async () => {
    const store = useFleet()
    const rename = vi.spyOn(store, 'rename').mockResolvedValue()
    const wrapper = mount(VmDetail, { props: running })
    const ui = useUi()
    ui.startRename('web')
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-test="rename-input"]').exists()).toBe(true)
    await wrapper.setProps({ name: 'db', state: 'running', healthy: true })
    expect(ui.renaming).toBe(false)
    expect(wrapper.find('[data-test="rename-input"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="rename-display"]').text()).toBe('db')
    expect(rename).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})
