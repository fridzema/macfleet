import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { useDarkMode } from '../../src/composables/useDarkMode'
import { setToastScheduler, useToasts } from '../../src/composables/useToasts'
import { useFleet } from '../../src/stores/fleet'
import { fuzzy, useUi } from '../../src/stores/ui'

vi.mock('../../src/composables/useDarkMode', () => ({
  useDarkMode: vi.fn(),
}))

let toggleDark: ReturnType<typeof vi.fn>

beforeEach(() => {
  setActivePinia(createPinia())
  // No-op scheduler so store-triggered toasts leave no real timer dangling.
  setToastScheduler(() => {})
  toggleDark = vi.fn()
  vi.mocked(useDarkMode).mockReturnValue({ isDark: ref(false), toggleDark })
  useToasts().toasts.value = []
})

describe('fuzzy', () => {
  it('matches an empty query against anything', () => {
    expect(fuzzy('', 'Snapshot web')).toBe(true)
  })

  it('matches an in-order subsequence, case-insensitively', () => {
    expect(fuzzy('spw', 'Snapshot Web')).toBe(true)
  })

  it('rejects when the characters are out of order', () => {
    expect(fuzzy('wsp', 'Snapshot Web')).toBe(false)
  })

  it('rejects when a character is missing entirely', () => {
    expect(fuzzy('zzz', 'Snapshot Web')).toBe(false)
  })
})

describe('ui store — search / theme', () => {
  it('search starts empty', () => {
    const ui = useUi()
    expect(ui.search).toBe('')
  })

  it('exposes isDark/toggleDark from useDarkMode', () => {
    const ui = useUi()
    ui.toggleDark()
    expect(toggleDark).toHaveBeenCalled()
  })
})

describe('ui store — selection resets per-VM flags', () => {
  it('selectVm to a different VM clears an armed delete and open rename (no wrong-VM action)', () => {
    const fleet = useFleet()
    fleet.vms = [
      { name: 'mf-web', state: 'running', source: 'local', healthy: true },
      { name: 'mf-db', state: 'running', source: 'local', healthy: true },
    ]
    const ui = useUi()
    // Arm both per-VM flags against "web".
    ui.startRename('web')
    ui.askDeleteVm('web')
    expect(ui.confirmDeleteVm).toBe(true)
    // Switching to another VM must reset them so the "db" header can't inherit them.
    ui.selectVm('db')
    expect(ui.selectedVm).toBe('db')
    expect(ui.renaming).toBe(false)
    expect(ui.renameValue).toBe('')
    expect(ui.confirmDeleteVm).toBe(false)
  })

  it('palette "Switch to X" clears an armed delete via selectVm', () => {
    const fleet = useFleet()
    fleet.vms = [
      { name: 'mf-web', state: 'running', source: 'local', healthy: true },
      { name: 'mf-db', state: 'running', source: 'local', healthy: true },
    ]
    const ui = useUi()
    ui.selectVm('web')
    ui.askDeleteVm('web')
    expect(ui.confirmDeleteVm).toBe(true)
    ui.paletteItems.find((i) => i.label === 'Switch to db')?.run()
    expect(ui.selectedVm).toBe('db')
    expect(ui.confirmDeleteVm).toBe(false)
  })
})

describe('ui store — command palette state', () => {
  it('openPalette resets query/index and opens', () => {
    const ui = useUi()
    ui.query = 'stale'
    ui.index = 3
    ui.openPalette()
    expect(ui.open).toBe(true)
    expect(ui.query).toBe('')
    expect(ui.index).toBe(0)
  })

  it('closePalette closes without touching query', () => {
    const ui = useUi()
    ui.openPalette()
    ui.query = 'web'
    ui.closePalette()
    expect(ui.open).toBe(false)
    expect(ui.query).toBe('web')
  })

  it('changing query resets index back to 0', () => {
    const ui = useUi()
    ui.index = 2
    ui.query = 'web'
    expect(ui.index).toBe(0)
  })
})

describe('ui store — paletteItems', () => {
  it('always includes "spin up new VM" and the theme toggle', () => {
    const ui = useUi()
    const labels = ui.paletteItems.map((i) => i.label)
    expect(labels).toContain('Spin up new VM (Golden image)')
    expect(labels).toContain('Toggle dark theme')
  })

  it('running the "spin up" item calls fleet.create and closes the palette', () => {
    const fleet = useFleet()
    const create = vi.spyOn(fleet, 'create').mockResolvedValue()
    const ui = useUi()
    ui.openPalette()
    const item = ui.paletteItems.find((i) => i.id === 'new')
    item?.run()
    expect(create).toHaveBeenCalled()
    expect(ui.open).toBe(false)
  })

  it('adds one "new VM from snapshot" item per snapshot, running newFromSnapshot', () => {
    const fleet = useFleet()
    fleet.snapshots = [{ id: 'web-golden', vm: 'web', label: 'golden', size: 10 }]
    const newFromSnapshot = vi.spyOn(fleet, 'newFromSnapshot').mockResolvedValue()
    const ui = useUi()
    const item = ui.paletteItems.find((i) => i.id === 'nf-web-golden')
    expect(item?.label).toBe('New VM from snapshot · golden')
    expect(item?.group).toBe('Create')
    item?.run()
    expect(newFromSnapshot).toHaveBeenCalledWith(fleet.snapshots[0])
  })

  it('has no VM/Danger-group items when nothing is selected', () => {
    const fleet = useFleet()
    fleet.vms = [{ name: 'mf-web', state: 'running', source: 'local', healthy: true }]
    const ui = useUi()
    const groups = ui.paletteItems.map((i) => i.group)
    expect(groups).not.toContain('VM')
    expect(groups).not.toContain('Danger')
  })

  it('selecting a VM populates the palette VM commands (selectVm is the source of truth)', () => {
    const fleet = useFleet()
    fleet.vms = [{ name: 'mf-web', state: 'running', source: 'local', healthy: true }]
    const ui = useUi()
    // Before selection: no per-VM commands.
    expect(ui.paletteItems.some((i) => i.group === 'VM')).toBe(false)
    // selectVm drives the palette's per-VM group into existence.
    ui.selectVm('web')
    const vmIds = ui.paletteItems.filter((i) => i.group === 'VM').map((i) => i.id)
    expect(vmIds).toEqual(['snap', 'susp', 'dup', 'ren', 'res', 'conn', 'term', 'log'])
    expect(ui.paletteItems.some((i) => i.id === 'del')).toBe(true)
  })

  it('adds VM + Danger items for the selected VM', () => {
    const fleet = useFleet()
    fleet.vms = [{ name: 'mf-web', state: 'running', source: 'local', healthy: true }]
    const ui = useUi()
    ui.selectVm('web')
    const byId = Object.fromEntries(ui.paletteItems.map((i) => [i.id, i]))
    expect(byId.snap.label).toBe('Snapshot web')
    expect(byId.susp.label).toBe('Suspend web') // running -> offers Suspend
    expect(byId.dup.label).toBe('Duplicate web')
    expect(byId.res.group).toBe('VM')
    expect(byId.conn.group).toBe('VM')
    expect(byId.term.group).toBe('VM')
    expect(byId.log.group).toBe('VM')
    expect(byId.del.label).toBe('Delete web')
    expect(byId.del.group).toBe('Danger')
  })

  it('offers Resume for a non-running selected VM, and running it calls fleet.resume', () => {
    const fleet = useFleet()
    fleet.vms = [{ name: 'mf-web', state: 'stopped', source: 'local', healthy: false }]
    const resume = vi.spyOn(fleet, 'resume').mockResolvedValue()
    const ui = useUi()
    ui.selectVm('web')
    const item = ui.paletteItems.find((i) => i.id === 'susp')
    expect(item?.label).toBe('Resume web')
    item?.run()
    expect(resume).toHaveBeenCalledWith('web')
  })

  it('suspend/resume item calls the matching fleet action', () => {
    const fleet = useFleet()
    fleet.vms = [{ name: 'mf-web', state: 'running', source: 'local', healthy: true }]
    const suspend = vi.spyOn(fleet, 'suspend').mockResolvedValue()
    const ui = useUi()
    ui.selectVm('web')
    ui.paletteItems.find((i) => i.id === 'susp')?.run()
    expect(suspend).toHaveBeenCalledWith('web')
  })

  it('snapshot item opens the snapshot dialog for the selected VM', () => {
    const fleet = useFleet()
    fleet.vms = [{ name: 'mf-web', state: 'running', source: 'local', healthy: true }]
    const ui = useUi()
    ui.selectVm('web')
    ui.paletteItems.find((i) => i.id === 'snap')?.run()
    expect(ui.snapshotTarget).toEqual(['web'])
  })

  it('duplicate item calls fleet.duplicate', () => {
    const fleet = useFleet()
    fleet.vms = [{ name: 'mf-web', state: 'running', source: 'local', healthy: true }]
    const duplicate = vi.spyOn(fleet, 'duplicate').mockResolvedValue()
    const ui = useUi()
    ui.selectVm('web')
    ui.paletteItems.find((i) => i.id === 'dup')?.run()
    expect(duplicate).toHaveBeenCalledWith('web')
  })

  it('rename item arms inline rename via store flags — no browser prompt, no immediate rename', () => {
    const fleet = useFleet()
    fleet.vms = [{ name: 'mf-web', state: 'running', source: 'local', healthy: true }]
    const rename = vi.spyOn(fleet, 'rename').mockResolvedValue()
    const prompt = vi.spyOn(window, 'prompt')
    const ui = useUi()
    ui.selectVm('web')
    ui.paletteItems.find((i) => i.id === 'ren')?.run()
    expect(ui.renaming).toBe(true)
    expect(ui.renameValue).toBe('web') // prefilled with the current name
    expect(ui.selectedVm).toBe('web')
    expect(ui.confirmDeleteVm).toBe(false)
    expect(prompt).not.toHaveBeenCalled()
    expect(rename).not.toHaveBeenCalled() // execution happens in the inline UI later
  })

  it('cancelRename clears the renaming flag', () => {
    const fleet = useFleet()
    fleet.vms = [{ name: 'mf-web', state: 'running', source: 'local', healthy: true }]
    const ui = useUi()
    ui.startRename('web')
    ui.cancelRename()
    expect(ui.renaming).toBe(false)
  })

  it('resize/connect/terminal/logs items switch the fleet tab', () => {
    const fleet = useFleet()
    fleet.vms = [{ name: 'mf-web', state: 'running', source: 'local', healthy: true }]
    const ui = useUi()
    ui.selectVm('web')
    ui.paletteItems.find((i) => i.id === 'res')?.run()
    expect(fleet.selectedTab).toBe('resources')
    ui.paletteItems.find((i) => i.id === 'conn')?.run()
    expect(fleet.selectedTab).toBe('connect')
    ui.paletteItems.find((i) => i.id === 'term')?.run()
    expect(fleet.selectedTab).toBe('terminal')
    ui.paletteItems.find((i) => i.id === 'log')?.run()
    expect(fleet.selectedTab).toBe('logs')
  })

  it('delete item arms the two-step confirm flag — no browser dialog, no immediate nuke', () => {
    const fleet = useFleet()
    fleet.vms = [{ name: 'mf-web', state: 'running', source: 'local', healthy: true }]
    const nuke = vi.spyOn(fleet, 'nuke').mockResolvedValue()
    const confirm = vi.spyOn(window, 'confirm')
    const ui = useUi()
    ui.selectVm('web')
    ui.paletteItems.find((i) => i.id === 'del')?.run()
    expect(ui.confirmDeleteVm).toBe(true)
    expect(ui.selectedVm).toBe('web')
    expect(ui.renaming).toBe(false)
    expect(confirm).not.toHaveBeenCalled()
    expect(nuke).not.toHaveBeenCalled() // deletion happens after the UI confirm step
  })

  it('cancelDeleteVm clears the confirm flag', () => {
    const fleet = useFleet()
    fleet.vms = [{ name: 'mf-web', state: 'running', source: 'local', healthy: true }]
    const ui = useUi()
    ui.askDeleteVm('web')
    ui.cancelDeleteVm()
    expect(ui.confirmDeleteVm).toBe(false)
  })

  it('lists every other VM under "Go to", and switching updates selectedVm', () => {
    const fleet = useFleet()
    fleet.vms = [
      { name: 'mf-web', state: 'running', source: 'local', healthy: true },
      { name: 'mf-db', state: 'running', source: 'local', healthy: true },
    ]
    const ui = useUi()
    ui.selectVm('web')
    const goTo = ui.paletteItems.filter((i) => i.group === 'Go to')
    expect(goTo.map((i) => i.label)).toEqual(['Switch to db'])
    goTo[0].run()
    expect(ui.selectedVm).toBe('db')
  })

  it('resolves a VM name that does not carry the mf- prefix unchanged (defensive passthrough)', () => {
    const fleet = useFleet()
    fleet.vms = [{ name: 'standalone', state: 'running', source: 'local', healthy: true }]
    const ui = useUi()
    ui.selectVm('standalone')
    const byId = Object.fromEntries(ui.paletteItems.map((i) => [i.id, i]))
    expect(byId.snap.label).toBe('Snapshot standalone')
  })

  it('theme item reflects the current mode and toggles it', () => {
    vi.mocked(useDarkMode).mockReturnValue({ isDark: ref(true), toggleDark })
    const ui = useUi()
    const item = ui.paletteItems.find((i) => i.id === 'theme')
    expect(item?.label).toBe('Toggle light theme')
    item?.run()
    expect(toggleDark).toHaveBeenCalled()
  })

  it('filters items by the fuzzy query', () => {
    const ui = useUi()
    ui.query = 'zzz-does-not-match-anything'
    expect(ui.paletteItems).toEqual([])
  })
})

describe('ui store — toasts', () => {
  it('toast() adds to the shared toasts list', () => {
    const ui = useUi()
    ui.toast('Copied to clipboard')
    // ui.toasts is a Pinia-unwrapped ref, so it's the array directly.
    expect(ui.toasts.some((t) => t.msg === 'Copied to clipboard')).toBe(true)
  })
})

describe('ui store — selection', () => {
  it('selectOnly sets a single selection and opens the detail', () => {
    const ui = useUi()
    ui.selectOnly('web')
    expect(ui.selectedVms).toEqual(['web'])
    expect(ui.selectedVm).toBe('web')
  })
  it('toggleSelect adds then removes, collapsing the detail target', () => {
    const ui = useUi()
    ui.selectOnly('web')
    ui.toggleSelect('db')
    expect(ui.selectedVms).toEqual(['web', 'db'])
    ui.toggleSelect('web')
    expect(ui.selectedVms).toEqual(['db'])
    expect(ui.selectedVm).toBe('db')
  })
  it('selectRange fills between anchor and target over the given order', () => {
    const ui = useUi()
    ui.selectOnly('b')
    ui.selectRange('d', ['a', 'b', 'c', 'd'])
    expect(ui.selectedVms).toEqual(['b', 'c', 'd'])
  })
  it('clearSelection empties the selection', () => {
    const ui = useUi()
    ui.selectOnly('web')
    ui.toggleSelect('db')
    ui.clearSelection()
    expect(ui.selectedVms).toEqual([])
    expect(ui.selectionCount).toBe(0)
  })
})
