import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { useDarkMode } from '../composables/useDarkMode'
import { useToasts } from '../composables/useToasts'
import { useFleet } from './fleet'

const short = (n: string) => (n.startsWith('mf-') ? n.slice(3) : n)

export interface PaletteItem {
  id: string
  label: string
  group: 'Create' | 'VM' | 'Danger' | 'Go to' | 'App'
  run: () => void
}

export interface ContextMenuItem {
  label: string
  run: () => void
  danger?: boolean
}

/** Subsequence match (comp `fuzzy` line 498): every char of `query`, in order, somewhere
 * in `str`. Empty query matches everything. */
export function fuzzy(query: string, str: string): boolean {
  const q = query.toLowerCase()
  const s = str.toLowerCase()
  if (!q) return true
  let i = 0
  for (const c of s) {
    if (c === q[i]) i++
    if (i >= q.length) return true
  }
  return false
}

export const useUi = defineStore('ui', () => {
  const fleet = useFleet()
  const { isDark, toggleDark } = useDarkMode()
  const { toasts, add: toast } = useToasts()

  const search = ref('')

  // The VM the command palette treats as "current" for its per-VM actions (snapshot,
  // suspend/resume, duplicate, rename, resize, connect, delete). Single source of truth
  // for selection going forward (HomePage's local ref migrates here in a later task).
  const selectedVm = ref<string | null>(null)

  // Inline rename + two-step delete confirm, mirroring the comp's `startRename` (line 577)
  // and `askDelete` (552/579) — no browser dialogs (this is a Tauri/WKWebView app). The
  // palette only *arms* these; the actual inline input / confirm-button render + execute
  // in the VM-detail component, same as its existing `armNuke` pattern.
  const renaming = ref(false)
  const renameValue = ref('')
  const confirmDeleteVm = ref(false)

  // The VM(s) the SnapshotDialog is naming a snapshot for (short names), or null when
  // closed. A list so a bulk snapshot can name one label for many VMs. The dialog is the
  // only place snapshot labels are built — keeping the hyphen-free rule in one spot.
  const snapshotTarget = ref<string[] | null>(null)
  function requestSnapshot(names: string[]): void {
    snapshotTarget.value = names
  }
  function closeSnapshot(): void {
    snapshotTarget.value = null
  }

  function selectVm(name: string | null): void {
    selectedVm.value = name
    // These flags are per-VM-scoped but stored globally, so they MUST reset on every
    // selection change — otherwise an armed delete or open rename on the previously
    // selected VM would carry over and act on the newly selected one (a wrong-VM nuke
    // or rename, both irreversible). This guards every call site: sidebar click, palette
    // "Switch to X", and startRename/askDeleteVm (which select first, then re-arm).
    renaming.value = false
    renameValue.value = ''
    confirmDeleteVm.value = false
  }

  // Multi-selection (short names) + the range anchor for shift-click. Kept coherent with
  // selectedVm (the single detail target): a lone selection sets the detail target; an
  // empty selection clears it. 2+ selected switches the main pane to the bulk panel.
  const selectedVms = ref<string[]>([])
  const selectionAnchor = ref<string | null>(null)
  const selectionCount = computed(() => selectedVms.value.length)
  function isSelected(name: string): boolean {
    return selectedVms.value.includes(name)
  }
  function selectOnly(name: string): void {
    selectedVms.value = [name]
    selectionAnchor.value = name
    selectVm(name)
  }
  function toggleSelect(name: string): void {
    const set = new Set(selectedVms.value)
    if (set.has(name)) set.delete(name)
    else set.add(name)
    selectedVms.value = [...set]
    selectionAnchor.value = name
    if (selectedVms.value.length === 1) selectVm(selectedVms.value[0] ?? null)
    else if (selectedVms.value.length === 0) selectVm(null)
  }
  function selectRange(name: string, ordered: string[]): void {
    const anchor = selectionAnchor.value ?? name
    const a = ordered.indexOf(anchor)
    const b = ordered.indexOf(name)
    if (a === -1 || b === -1) {
      selectOnly(name)
      return
    }
    const [lo, hi] = a <= b ? [a, b] : [b, a]
    selectedVms.value = ordered.slice(lo, hi + 1)
    if (selectedVms.value.length === 1) selectVm(name)
  }
  function selectAll(names: string[]): void {
    selectedVms.value = [...names]
    selectionAnchor.value = names[0] ?? null
  }
  function clearSelection(): void {
    selectedVms.value = []
    selectionAnchor.value = null
  }

  // Right-click menu descriptor: cursor position + the items to show, or null when closed.
  const contextMenu = ref<{ x: number; y: number; items: ContextMenuItem[] } | null>(null)
  function openContextMenu(x: number, y: number, items: ContextMenuItem[]): void {
    contextMenu.value = { x, y, items }
  }
  function closeContextMenu(): void {
    contextMenu.value = null
  }

  function startRename(name: string): void {
    selectVm(name)
    renameValue.value = name
    confirmDeleteVm.value = false
    renaming.value = true
  }
  function cancelRename(): void {
    renaming.value = false
  }
  function askDeleteVm(name: string): void {
    selectVm(name)
    renaming.value = false
    confirmDeleteVm.value = true
  }
  function cancelDeleteVm(): void {
    confirmDeleteVm.value = false
  }

  const open = ref(false)
  const query = ref('')
  const index = ref(0)

  // Typing a new query resets the highlighted row, same as the comp's `onPaletteInput`.
  // Sync flush: callers expect `index` to already be 0 right after setting `query`.
  watch(
    query,
    () => {
      index.value = 0
    },
    { flush: 'sync' },
  )

  function openPalette(): void {
    open.value = true
    query.value = ''
    index.value = 0
  }
  function closePalette(): void {
    open.value = false
  }

  const paletteItems = computed<PaletteItem[]>(() => {
    const items: PaletteItem[] = []
    const push = (
      id: string,
      label: string,
      group: PaletteItem['group'],
      action: () => void,
    ): void => {
      items.push({
        id,
        label,
        group,
        run: () => {
          closePalette()
          action()
        },
      })
    }

    push('new', 'Spin up new VM (Golden image)', 'Create', () => fleet.create())
    for (const sn of fleet.snapshots) {
      push(`nf-${sn.id}`, `New VM from snapshot · ${sn.label}`, 'Create', () =>
        fleet.newFromSnapshot(sn),
      )
    }

    const sel = selectedVm.value
      ? fleet.vms.find((v) => short(v.name) === selectedVm.value)
      : undefined
    if (sel) {
      const name = short(sel.name)
      push('snap', `Snapshot ${name}`, 'VM', () => requestSnapshot([name]))
      push('susp', `${sel.state === 'running' ? 'Suspend' : 'Resume'} ${name}`, 'VM', () =>
        sel.state === 'running' ? fleet.suspend(name) : fleet.resume(name),
      )
      push('dup', `Duplicate ${name}`, 'VM', () => fleet.duplicate(name))
      push('ren', `Rename ${name}`, 'VM', () => startRename(name))
      push('res', `Resize ${name}`, 'VM', () => {
        fleet.selectedTab = 'resources'
      })
      push('conn', `Connect to ${name}`, 'VM', () => {
        fleet.selectedTab = 'connect'
      })
      push('term', 'Open terminal', 'VM', () => {
        fleet.selectedTab = 'terminal'
      })
      push('log', 'Open logs', 'VM', () => {
        fleet.selectedTab = 'logs'
      })
      // Arms the two-step confirm; does NOT delete here (comp askDelete line 552/579).
      push('del', `Delete ${name}`, 'Danger', () => askDeleteVm(name))
    }

    for (const v of fleet.vms) {
      const name = short(v.name)
      if (name !== selectedVm.value)
        push(`sw-${v.name}`, `Switch to ${name}`, 'Go to', () => selectVm(name))
    }

    push('theme', `Toggle ${isDark.value ? 'light' : 'dark'} theme`, 'App', () => toggleDark())

    return items.filter((it) => fuzzy(query.value, it.label))
  })

  return {
    isDark,
    toggleDark,
    search,
    selectedVm,
    selectVm,
    selectedVms,
    selectionCount,
    isSelected,
    selectOnly,
    toggleSelect,
    selectRange,
    selectAll,
    clearSelection,
    contextMenu,
    openContextMenu,
    closeContextMenu,
    renaming,
    renameValue,
    confirmDeleteVm,
    snapshotTarget,
    requestSnapshot,
    closeSnapshot,
    startRename,
    cancelRename,
    askDeleteVm,
    cancelDeleteVm,
    open,
    query,
    index,
    openPalette,
    closePalette,
    paletteItems,
    toasts,
    toast,
  }
})
