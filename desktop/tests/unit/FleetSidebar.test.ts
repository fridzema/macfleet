import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import FleetSidebar from '../../src/components/FleetSidebar.vue'
import { useDarkMode } from '../../src/composables/useDarkMode'
import { setToastScheduler, useToasts } from '../../src/composables/useToasts'
import { api } from '../../src/shared/api'
import { useFleet } from '../../src/stores/fleet'
import { useUi } from '../../src/stores/ui'

vi.mock('../../src/composables/useDarkMode', () => ({
  useDarkMode: vi.fn(),
}))

beforeEach(() => {
  setActivePinia(createPinia())
  vi.mocked(useDarkMode).mockReturnValue({ isDark: ref(false), toggleDark: vi.fn() })
  // The fleet store's toasts (create/newFromSnapshot/tickTtl) default to a real
  // setTimeout — swap in a no-op so nothing dangles past the test.
  setToastScheduler(() => {})
  useToasts().toasts.value = []
  // Snapshot initialization is independent of the hot fleet path.
  vi.spyOn(api, 'listSnapshots').mockResolvedValue([])
  vi.spyOn(api, 'watchFleet').mockImplementation(() => new Promise(() => {}))
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('FleetSidebar — fleet rows', () => {
  it('lists polled VMs and selects a row via ui.selectVm', async () => {
    vi.spyOn(api, 'listVms').mockResolvedValue([
      { name: 'mf-a', state: 'running', source: 'local', healthy: true },
      { name: 'mf-b', state: 'stopped', source: 'local', healthy: false },
    ])
    const wrapper = mount(FleetSidebar)
    const ui = useUi()
    await flushPromises()
    const rows = wrapper.findAll('[data-test="vm-row"]')
    expect(rows).toHaveLength(2)
    await rows[0]?.trigger('click')
    expect(ui.selectedVm).toBe('a')
    wrapper.unmount()
  })

  it('shows a disabled "Creating" row for a pending VM', async () => {
    vi.spyOn(api, 'listVms').mockResolvedValue([])
    const store = useFleet()
    const wrapper = mount(FleetSidebar)
    await flushPromises()
    store.pending = ['building']
    await flushPromises()
    const rows = wrapper.findAll('[data-test="vm-row"]')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.text()).toContain('building')
    expect(rows[0]?.text()).toContain('Creating')
    expect(rows[0]?.attributes('disabled')).toBeDefined()
    wrapper.unmount()
  })

  it('renders the running/booting/suspended/stopped/error states with their comp labels', async () => {
    vi.spyOn(api, 'listVms').mockResolvedValue([
      { name: 'mf-running', state: 'running', source: 'local', healthy: true },
      { name: 'mf-booting', state: 'running', source: 'local', healthy: false },
      { name: 'mf-suspended', state: 'suspended', source: 'local', healthy: false },
      { name: 'mf-stopped', state: 'stopped', source: 'local', healthy: false },
      { name: 'mf-flaky', state: 'error', source: 'local', healthy: false },
    ])
    const wrapper = mount(FleetSidebar)
    await flushPromises()
    const rows = wrapper.findAll('[data-test="vm-row"]')
    expect(rows).toHaveLength(5)
    expect(rows.map((r) => r.text())).toEqual([
      expect.stringContaining('Running'),
      expect.stringContaining('Booting'),
      expect.stringContaining('Suspended'),
      expect.stringContaining('Stopped'),
      expect.stringContaining('Unhealthy'),
    ])
    wrapper.unmount()
  })

  it('highlights the active row via ui.selectedVm, glowing only when running', async () => {
    vi.spyOn(api, 'listVms').mockResolvedValue([
      { name: 'mf-a', state: 'running', source: 'local', healthy: true },
      { name: 'mf-b', state: 'stopped', source: 'local', healthy: false },
    ])
    const wrapper = mount(FleetSidebar)
    const ui = useUi()
    await flushPromises()
    ui.selectVm('a')
    await wrapper.vm.$nextTick()
    const rows = wrapper.findAll('[data-test="vm-row"]')
    expect(rows[0]?.classes().join(' ')).toContain('animate-[mfglow_2.6s_ease-in-out_infinite]')
    expect(rows[1]?.classes().join(' ')).not.toContain('animate-[mfglow_2.6s_ease-in-out_infinite]')
    wrapper.unmount()
  })

  it('shows a TTL chip for a VM tracked in store.leases, and none otherwise', async () => {
    vi.spyOn(api, 'listVms').mockResolvedValue([
      { name: 'mf-leased', state: 'running', source: 'local', healthy: true },
      { name: 'mf-plain', state: 'running', source: 'local', healthy: true },
    ])
    const store = useFleet()
    const wrapper = mount(FleetSidebar)
    await flushPromises()
    store.leases = { leased: 125 }
    await wrapper.vm.$nextTick()
    const rows = wrapper.findAll('[data-test="vm-row"]')
    expect(rows[0]?.text()).toContain('2m 5s')
    expect(rows[1]?.text()).not.toContain('m ')
    wrapper.unmount()
  })

  it('formats a sub-minute TTL as plain seconds', async () => {
    vi.spyOn(api, 'listVms').mockResolvedValue([
      { name: 'mf-leased', state: 'running', source: 'local', healthy: true },
    ])
    const store = useFleet()
    const wrapper = mount(FleetSidebar)
    await flushPromises()
    store.leases = { leased: 45 }
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-test="vm-row"]').text()).toContain('45s')
    wrapper.unmount()
  })

  it('resolves a VM name that does not carry the mf- prefix unchanged (defensive passthrough)', async () => {
    vi.spyOn(api, 'listVms').mockResolvedValue([])
    const store = useFleet()
    const wrapper = mount(FleetSidebar)
    await flushPromises()
    store.vms = [{ name: 'standalone', state: 'running', source: 'local', healthy: true }]
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-test="vm-row"]').text()).toContain('standalone')
    wrapper.unmount()
  })

  it('a pending VM already appearing (but not yet running) in the polled list stays "Creating"', async () => {
    vi.spyOn(api, 'listVms').mockResolvedValue([
      { name: 'mf-web', state: 'stopped', source: 'local', healthy: false },
    ])
    const store = useFleet()
    const wrapper = mount(FleetSidebar)
    await flushPromises()
    store.pending = ['web']
    await wrapper.vm.$nextTick()
    const row = wrapper.find('[data-test="vm-row"]')
    expect(row.text()).toContain('Creating')
    expect(row.attributes('disabled')).toBeDefined()
    wrapper.unmount()
  })

  it('a pending VM that has actually turned running is no longer shown as "Creating"', async () => {
    vi.spyOn(api, 'listVms').mockResolvedValue([
      { name: 'mf-web', state: 'running', source: 'local', healthy: true },
    ])
    const store = useFleet()
    const wrapper = mount(FleetSidebar)
    await flushPromises()
    store.pending = ['web']
    await wrapper.vm.$nextTick()
    const row = wrapper.find('[data-test="vm-row"]')
    expect(row.text()).toContain('Running')
    expect(row.attributes('disabled')).toBeUndefined()
    wrapper.unmount()
  })

  it('shows "No VMs running" when the fleet is empty, and "No matches" when search filters it out', async () => {
    vi.spyOn(api, 'listVms').mockResolvedValue([])
    const wrapper = mount(FleetSidebar)
    await flushPromises()
    expect(wrapper.text()).toContain('No VMs running')

    vi.spyOn(api, 'listVms').mockResolvedValue([
      { name: 'mf-web', state: 'running', source: 'local', healthy: true },
    ])
    const store = useFleet()
    await store.refresh()
    await wrapper.vm.$nextTick()
    const ui = useUi()
    ui.search = 'zzz'
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('No matches')
    wrapper.unmount()
  })

  it('filters fleet rows by ui.search (case-insensitive substring)', async () => {
    vi.spyOn(api, 'listVms').mockResolvedValue([
      { name: 'mf-web-1', state: 'running', source: 'local', healthy: true },
      { name: 'mf-db-1', state: 'running', source: 'local', healthy: true },
    ])
    const wrapper = mount(FleetSidebar)
    const ui = useUi()
    await flushPromises()
    ui.search = 'WEB'
    await wrapper.vm.$nextTick()
    const rows = wrapper.findAll('[data-test="vm-row"]')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.text()).toContain('web-1')
    wrapper.unmount()
  })

  it('shows "Connecting to engine…" when the very first refresh fails', async () => {
    vi.spyOn(api, 'listVms').mockRejectedValue(new Error('ECONNREFUSED'))
    const wrapper = mount(FleetSidebar)
    await flushPromises()
    expect(wrapper.text()).toContain('Connecting to engine…')
    wrapper.unmount()
  })

  it('shows the error message once loaded if a later refresh fails with an empty fleet', async () => {
    const listVms = vi.spyOn(api, 'listVms').mockResolvedValue([])
    const wrapper = mount(FleetSidebar)
    await flushPromises()
    listVms.mockRejectedValue(new Error('sidecar unreachable'))
    const store = useFleet()
    await store.refresh()
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('sidecar unreachable')
    wrapper.unmount()
  })
})

describe('FleetSidebar — snapshots', () => {
  it('lists snapshots and "＋ VM" calls store.newFromSnapshot', async () => {
    vi.spyOn(api, 'listVms').mockResolvedValue([])
    vi.spyOn(api, 'listSnapshots').mockResolvedValue([
      { id: 'snap1', vm: 'ci-runner-01', label: 'clean-ventura', size: 18 },
    ])
    const store = useFleet()
    const newFromSnapshot = vi.spyOn(store, 'newFromSnapshot').mockResolvedValue()
    const wrapper = mount(FleetSidebar)
    await flushPromises()
    const snapRows = wrapper.findAll('[data-test="snap-row"]')
    expect(snapRows).toHaveLength(1)
    expect(snapRows[0]?.text()).toContain('clean-ventura')
    expect(snapRows[0]?.text()).toContain('ci-runner-01')
    expect(snapRows[0]?.text()).toContain('18 GB')
    await wrapper.find('[data-test="snap-new"]').trigger('click')
    expect(newFromSnapshot).toHaveBeenCalledWith(store.snapshots[0])
    wrapper.unmount()
  })

  it('filters snapshots by ui.search against label or source vm', async () => {
    vi.spyOn(api, 'listVms').mockResolvedValue([])
    vi.spyOn(api, 'listSnapshots').mockResolvedValue([
      { id: 'snap1', vm: 'ci-runner-01', label: 'clean-ventura', size: 18 },
      { id: 'snap2', vm: 'build-mac-14', label: 'xcode-15-ready', size: 24 },
    ])
    const wrapper = mount(FleetSidebar)
    const ui = useUi()
    await flushPromises()
    ui.search = 'xcode'
    await wrapper.vm.$nextTick()
    const snapRows = wrapper.findAll('[data-test="snap-row"]')
    expect(snapRows).toHaveLength(1)
    expect(snapRows[0]?.text()).toContain('xcode-15-ready')
    wrapper.unmount()
  })
})

describe('FleetSidebar — create panel', () => {
  it('up-form submits store.create with the name typed into up-name', async () => {
    vi.spyOn(api, 'listVms').mockResolvedValue([])
    const store = useFleet()
    const create = vi.spyOn(store, 'create').mockResolvedValue()
    const wrapper = mount(FleetSidebar)
    await wrapper.find('[data-test="up-name"]').setValue('web')
    expect(store.createOptions.name).toBe('web')
    await wrapper.find('[data-test="up-form"]').trigger('submit')
    expect(create).toHaveBeenCalled()
    wrapper.unmount()
  })

  it('advanced options are hidden until the toggle is clicked', async () => {
    vi.spyOn(api, 'listVms').mockResolvedValue([])
    const wrapper = mount(FleetSidebar)
    await flushPromises()
    expect(wrapper.find('[data-test="create-source"]').exists()).toBe(false)
    await wrapper.find('[data-test="create-advanced-toggle"]').trigger('click')
    expect(wrapper.find('[data-test="create-source"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('advanced source options list Golden plus every snapshot', async () => {
    vi.spyOn(api, 'listVms').mockResolvedValue([])
    vi.spyOn(api, 'listSnapshots').mockResolvedValue([
      { id: 'snap1', vm: 'ci-runner-01', label: 'clean-ventura', size: 18 },
    ])
    const wrapper = mount(FleetSidebar)
    await flushPromises()
    await wrapper.find('[data-test="create-advanced-toggle"]').trigger('click')
    const options = wrapper.find('[data-test="create-source"]').findAll('option')
    expect(options.map((o) => o.text())).toEqual([
      'Golden image (macOS 14.5)',
      'Snapshot · clean-ventura',
    ])
    wrapper.unmount()
  })

  it('creating with a snapshot source, a resources preset, and TTL calls store.create with those createOptions', async () => {
    vi.spyOn(api, 'listVms').mockResolvedValue([])
    vi.spyOn(api, 'listSnapshots').mockResolvedValue([
      { id: 'snap1', vm: 'ci-runner-01', label: 'clean-ventura', size: 18 },
    ])
    const store = useFleet()
    const create = vi.spyOn(store, 'create').mockResolvedValue()
    const wrapper = mount(FleetSidebar)
    await flushPromises()

    await wrapper.find('[data-test="up-name"]').setValue('ci-clone')
    await wrapper.find('[data-test="create-advanced-toggle"]').trigger('click')
    await wrapper.find('[data-test="create-source"]').setValue('snap1')
    await wrapper.find('[data-test="create-preset"]').setValue('heavy')
    await wrapper.find('[data-test="create-ttl"]').setValue(true)
    await wrapper.find('[data-test="up-form"]').trigger('submit')

    expect(create).toHaveBeenCalled()
    expect(store.createOptions).toMatchObject({
      name: 'ci-clone',
      source: 'snap1',
      preset: 'heavy',
      ttl: true,
    })
    wrapper.unmount()
  })
})

describe('FleetSidebar — polling', () => {
  it('refreshes on mount, then uses a slow recovery poll while TTL ticks locally', async () => {
    vi.useFakeTimers()
    const listVms = vi.spyOn(api, 'listVms').mockResolvedValue([])
    const store = useFleet()
    const tickTtl = vi.spyOn(store, 'tickTtl')
    const wrapper = mount(FleetSidebar)
    await vi.waitFor(() => expect(listVms).toHaveBeenCalledTimes(1))

    await vi.advanceTimersByTimeAsync(30_000)
    expect(listVms).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(1000)
    expect(tickTtl).toHaveBeenCalled()

    wrapper.unmount()
  })
})

describe('FleetSidebar — snapshot rows', () => {
  it('two-step deletes a snapshot from its row', async () => {
    vi.spyOn(api, 'listVms').mockResolvedValue([])
    vi.spyOn(api, 'listSnapshots').mockResolvedValue([
      { id: 'web-clean', vm: 'web', label: 'clean', size: 2 },
    ])
    const wrapper = mount(FleetSidebar)
    const s = useFleet()
    const del = vi.spyOn(s, 'deleteSnapshot').mockResolvedValue()
    await flushPromises()
    await wrapper.find('[data-test="snap-delete"]').trigger('click') // arm
    expect(del).not.toHaveBeenCalled()
    await wrapper.find('[data-test="snap-delete"]').trigger('click') // confirm
    expect(del).toHaveBeenCalledWith('web-clean')
  })

  it("two-step restores the snapshot's VM from its row", async () => {
    vi.spyOn(api, 'listVms').mockResolvedValue([])
    vi.spyOn(api, 'listSnapshots').mockResolvedValue([
      { id: 'web-clean', vm: 'web', label: 'clean', size: 2 },
    ])
    const wrapper = mount(FleetSidebar)
    const s = useFleet()
    const restore = vi.spyOn(s, 'restoreVM').mockResolvedValue()
    await flushPromises()
    await wrapper.find('[data-test="snap-restore"]').trigger('click')
    await wrapper.find('[data-test="snap-restore"]').trigger('click')
    expect(restore).toHaveBeenCalledWith('web', 'web-clean')
  })
})

describe('FleetSidebar — selection + context menu', () => {
  it('plain click selects one, cmd-click adds to the selection', async () => {
    vi.spyOn(api, 'listVms').mockResolvedValue([
      { name: 'mf-a', state: 'running', source: 'local', healthy: true },
      { name: 'mf-b', state: 'running', source: 'local', healthy: true },
    ])
    const wrapper = mount(FleetSidebar)
    const ui = useUi()
    await flushPromises()
    const rows = wrapper.findAll('[data-test="vm-row"]')
    await rows[0].trigger('click')
    await rows[1].trigger('click', { metaKey: true })
    expect(ui.selectedVms).toEqual(['a', 'b'])
  })

  it('right-click opens a context menu with a Suspend action for a running VM', async () => {
    vi.spyOn(api, 'listVms').mockResolvedValue([
      { name: 'mf-a', state: 'running', source: 'local', healthy: true },
    ])
    const wrapper = mount(FleetSidebar)
    const ui = useUi()
    await flushPromises()
    await wrapper.find('[data-test="vm-row"]').trigger('contextmenu')
    expect(ui.contextMenu?.items.some((i) => i.label === 'Suspend')).toBe(true)
  })
})
