# Right-click menu + multi-select — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a right-click context menu on fleet/snapshot rows and ⌘/⇧-click multi-selection with a bulk-action panel, reusing the existing per-VM store actions.

**Architecture:** All new state lives in the `ui` Pinia store (selection set + context-menu descriptor); two new components (`ContextMenu.vue`, `BulkPanel.vue`) render it. `FleetSidebar` rows gain modifier-aware click handling and a `@contextmenu` handler that builds a state-aware item list. Bulk actions fan out through a new throttled `store.runBulk` so many VMs don't spawn a tart-subprocess storm.

**Tech Stack:** Vue 3 + Pinia + TypeScript (bun, vitest), Tauri.

This is **Plan 2 of 3** for `docs/superpowers/specs/2026-07-09-fleet-ux-snapshots-and-shared-folders-design.md`. Plan 1 (snapshots) is merged; Plan 3 (shared folders) follows. Feature-B "Restore from snapshot…" is intentionally NOT in the VM context menu — restore stays on snapshot rows where it already has a two-step confirm (a one-shot menu item can't confirm a destructive op). Bulk delete lives only in `BulkPanel` (with confirm), not the context menu, for the same reason.

## Global Constraints

- Desktop tests: `bun run test:unit` from `desktop/`. Lint `bun run lint`; typecheck `bunx vue-tsc -b`.
- Strict TS. Conventional commits, no `Co-authored-by`.
- Selection is short VM names (no `mf-` prefix), consistent with `ui.selectedVm`.
- Bulk fan-out MUST be concurrency-capped (max 3) — parallel tart calls are what caused the flap fixed in v0.2.0.
- Reuse existing store actions (`suspend`/`down`/`resume`/`nuke`/`duplicate`) and ui actions (`selectVm`/`startRename`/`askDeleteVm`/`requestSnapshot`).

---

### Task 1: ui store — multi-selection state

**Files:**
- Modify: `desktop/src/stores/ui.ts`
- Test: `desktop/tests/unit/ui.test.ts`

**Interfaces:**
- Produces: `selectedVms: Ref<string[]>`, `selectionCount: ComputedRef<number>`, `isSelected(name): boolean`, `selectOnly(name)`, `toggleSelect(name)`, `selectRange(name, ordered: string[])`, `selectAll(names: string[])`, `clearSelection()`. `selectOnly`/`toggleSelect` keep `selectedVm` (the detail target) coherent: when the selection collapses to exactly one, that one becomes the detail target; when it empties, the target clears.

- [ ] **Step 1: Write the failing tests**

```ts
// desktop/tests/unit/ui.test.ts  (new describe block)
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
```

- [ ] **Step 2: Run to verify they fail**

Run (from `desktop/`): `bun run test:unit ui`
Expected: FAIL (`selectOnly` etc. undefined).

- [ ] **Step 3: Implement selection state**

In `desktop/src/stores/ui.ts`, add after the `snapshotTarget` block (uses `computed`, already imported):

```ts
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
    if (selectedVms.value.length === 1) selectVm(selectedVms.value[0])
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
```

Expose all of them in the returned object (next to `selectVm`):

```ts
    selectedVms,
    selectionCount,
    isSelected,
    selectOnly,
    toggleSelect,
    selectRange,
    selectAll,
    clearSelection,
```

- [ ] **Step 4: Run to verify they pass**

Run: `bun run test:unit ui`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add desktop/src/stores/ui.ts desktop/tests/unit/ui.test.ts
git commit -m "feat(desktop): ui-store multi-selection state"
```

---

### Task 2: ui store — context-menu descriptor

**Files:**
- Modify: `desktop/src/stores/ui.ts`
- Test: `desktop/tests/unit/ui.test.ts`

**Interfaces:**
- Produces: `export interface ContextMenuItem { label: string; run: () => void; danger?: boolean }`; `contextMenu: Ref<{ x: number; y: number; items: ContextMenuItem[] } | null>`; `openContextMenu(x, y, items)`, `closeContextMenu()`.

- [ ] **Step 1: Write the failing test**

```ts
// desktop/tests/unit/ui.test.ts
describe('ui store — context menu', () => {
  it('opens with position + items and closes to null', () => {
    const ui = useUi()
    ui.openContextMenu(10, 20, [{ label: 'X', run: () => {} }])
    expect(ui.contextMenu?.x).toBe(10)
    expect(ui.contextMenu?.items).toHaveLength(1)
    ui.closeContextMenu()
    expect(ui.contextMenu).toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun run test:unit ui`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `desktop/src/stores/ui.ts`, add the interface near the top (beside `PaletteItem`):

```ts
export interface ContextMenuItem {
  label: string
  run: () => void
  danger?: boolean
}
```

Add state in the store setup (after the selection block):

```ts
  const contextMenu = ref<{ x: number; y: number; items: ContextMenuItem[] } | null>(null)
  function openContextMenu(x: number, y: number, items: ContextMenuItem[]): void {
    contextMenu.value = { x, y, items }
  }
  function closeContextMenu(): void {
    contextMenu.value = null
  }
```

Expose `contextMenu, openContextMenu, closeContextMenu` in the returned object.

- [ ] **Step 4: Run to verify it passes**

Run: `bun run test:unit ui`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add desktop/src/stores/ui.ts desktop/tests/unit/ui.test.ts
git commit -m "feat(desktop): ui-store context-menu descriptor"
```

---

### Task 3: ContextMenu component

**Files:**
- Create: `desktop/src/components/ContextMenu.vue`
- Modify: `desktop/src/layouts/DefaultLayout.vue`
- Test: `desktop/tests/unit/ContextMenu.test.ts`

**Interfaces:**
- Consumes: `ui.contextMenu`, `ui.closeContextMenu`.

- [ ] **Step 1: Write the failing test**

```ts
// desktop/tests/unit/ContextMenu.test.ts
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, expect, it, vi } from 'vitest'
import ContextMenu from '../../src/components/ContextMenu.vue'
import { useUi } from '../../src/stores/ui'

beforeEach(() => setActivePinia(createPinia()))

it('renders items and runs + closes on click', async () => {
  const ui = useUi()
  const run = vi.fn()
  const w = mount(ContextMenu)
  ui.openContextMenu(5, 5, [{ label: 'Do it', run }])
  await w.vm.$nextTick()
  await w.get('[data-test="ctx-item"]').trigger('click')
  expect(run).toHaveBeenCalledOnce()
  expect(ui.contextMenu).toBeNull()
})

it('is hidden when there is no menu', () => {
  const w = mount(ContextMenu)
  expect(w.find('[data-test="context-menu"]').exists()).toBe(false)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun run test:unit ContextMenu`
Expected: FAIL (component missing).

- [ ] **Step 3: Create the component**

```vue
<!-- desktop/src/components/ContextMenu.vue -->
<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue'
import { type ContextMenuItem, useUi } from '../stores/ui'

const ui = useUi()

function choose(item: ContextMenuItem): void {
  ui.closeContextMenu()
  item.run()
}

// Dismiss on any outside interaction. Escape/scroll/resize also close.
function onDocPointer(): void {
  if (ui.contextMenu) ui.closeContextMenu()
}
function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') ui.closeContextMenu()
}
onMounted(() => {
  window.addEventListener('pointerdown', onDocPointer, true)
  window.addEventListener('scroll', onDocPointer, true)
  window.addEventListener('resize', onDocPointer)
  window.addEventListener('keydown', onKey)
})
onBeforeUnmount(() => {
  window.removeEventListener('pointerdown', onDocPointer, true)
  window.removeEventListener('scroll', onDocPointer, true)
  window.removeEventListener('resize', onDocPointer)
  window.removeEventListener('keydown', onKey)
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="ui.contextMenu"
      data-test="context-menu"
      class="fixed z-50 min-w-[168px] rounded-lg border border-[var(--border)] bg-[var(--bg-elev)] py-1 shadow-[var(--shadow)]"
      :style="{ left: `${ui.contextMenu.x}px`, top: `${ui.contextMenu.y}px` }"
      @contextmenu.prevent
    >
      <button
        v-for="item in ui.contextMenu.items"
        :key="item.label"
        type="button"
        data-test="ctx-item"
        class="block w-full px-3 py-1.5 text-left text-xs hover:bg-[var(--bg-hover)]"
        :class="item.danger ? 'text-[var(--red)]' : 'text-[var(--text-dim)]'"
        @click="choose(item)"
      >
        {{ item.label }}
      </button>
    </div>
  </Teleport>
</template>
```

- [ ] **Step 4: Mount globally**

In `desktop/src/layouts/DefaultLayout.vue`, import and render beside `SnapshotDialog`:

```ts
import ContextMenu from '../components/ContextMenu.vue'
```

```html
    <SnapshotDialog />
    <ContextMenu />
    <ToastStack />
```

Add a `ContextMenu` stub to `desktop/tests/unit/DefaultLayout.test.ts` `stubs` (mirrors the others):

```ts
  ContextMenu: { template: '<div data-testid="context-menu" />' },
```

- [ ] **Step 5: Run tests**

Run: `bun run test:unit ContextMenu DefaultLayout`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add desktop/src/components/ContextMenu.vue desktop/src/layouts/DefaultLayout.vue desktop/tests/unit/ContextMenu.test.ts desktop/tests/unit/DefaultLayout.test.ts
git commit -m "feat(desktop): ContextMenu component mounted at app root"
```

---

### Task 4: fleet store — throttled bulk actions

**Files:**
- Modify: `desktop/src/stores/fleet.ts`
- Test: `desktop/tests/unit/fleet.test.ts`

**Interfaces:**
- Produces: `bulkSuspend(names)`, `bulkStop(names)`, `bulkResume(names)`, `bulkNuke(names)` — each returns `Promise<void>`, fans out with a concurrency cap of 3, refreshes once, and toasts a summary.

- [ ] **Step 1: Write the failing tests**

```ts
// desktop/tests/unit/fleet.test.ts  (inside the lifecycle-mutations describe)
  it('bulkSuspend runs every name and toasts a success summary', async () => {
    vi.spyOn(api, 'suspend').mockResolvedValue({})
    const s = useFleet()
    await s.bulkSuspend(['a', 'b', 'c'])
    expect(api.suspend).toHaveBeenCalledTimes(3)
    expect(useToasts().toasts.value.some((t) => t.msg.includes('Suspended 3 VMs'))).toBe(true)
  })

  it('bulkNuke reports failures in the summary and error', async () => {
    vi.spyOn(api, 'nuke').mockImplementation((n: string) =>
      n === 'b' ? Promise.reject(new Error('boom')) : Promise.resolve({}),
    )
    const s = useFleet()
    await s.bulkNuke(['a', 'b'])
    expect(useToasts().toasts.value.some((t) => t.msg.includes('1 failed'))).toBe(true)
    expect(s.error).toContain('b')
  })
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun run test:unit fleet`
Expected: FAIL (`bulkSuspend` undefined).

- [ ] **Step 3: Implement `runBulk` + bulk actions**

In `desktop/src/stores/fleet.ts`, add near `run`:

```ts
  // Fan out a per-VM op with a concurrency cap so a bulk action doesn't spawn a burst of
  // tart subprocesses (the load that made the fleet flap). One refresh + one summary toast.
  async function runBulk(
    names: string[],
    fn: (name: string) => Promise<unknown>,
    verb: string,
  ): Promise<void> {
    const failed: string[] = []
    const queue = [...names]
    async function worker(): Promise<void> {
      while (queue.length) {
        const name = queue.shift() as string
        try {
          await fn(name)
        } catch {
          failed.push(name)
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(3, names.length) }, worker))
    await refresh()
    if (failed.length) {
      error.value = `${verb} failed for ${failed.join(', ')}`
      toast(`${verb} ${names.length - failed.length}/${names.length} — ${failed.length} failed`, '⚠')
    } else {
      toast(`${verb} ${names.length} VMs`, '✓')
    }
  }
  const bulkSuspend = (names: string[]) => runBulk(names, (n) => api.suspend(n), 'Suspended')
  const bulkStop = (names: string[]) => runBulk(names, (n) => api.down(n), 'Stopped')
  const bulkResume = (names: string[]) => runBulk(names, (n) => api.resume(n), 'Resumed')
  const bulkNuke = (names: string[]) => runBulk(names, (n) => api.nuke(n), 'Deleted')
```

Expose `bulkSuspend, bulkStop, bulkResume, bulkNuke` in the returned object.

- [ ] **Step 4: Run to verify they pass**

Run: `bun run test:unit fleet`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add desktop/src/stores/fleet.ts desktop/tests/unit/fleet.test.ts
git commit -m "feat(desktop): throttled bulk VM actions"
```

---

### Task 5: FleetSidebar — modifier-select + selected styling + right-click

**Files:**
- Modify: `desktop/src/components/FleetSidebar.vue`
- Test: `desktop/tests/unit/FleetSidebar.test.ts`

**Interfaces:**
- Consumes: ui selection + context-menu actions (Tasks 1-2), `store.bulkSuspend/bulkStop/bulkResume` (Task 4), existing `store.suspend/down/resume/duplicate`, `ui.startRename/askDeleteVm/requestSnapshot/selectOnly`.

- [ ] **Step 1: Write the failing tests**

```ts
// desktop/tests/unit/FleetSidebar.test.ts (new describe block)
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
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun run test:unit FleetSidebar`
Expected: FAIL (cmd-click doesn't set `selectedVms`; contextmenu doesn't open a menu).

- [ ] **Step 3: Add handlers to the script**

In `FleetSidebar.vue` `<script setup>`, import the item type and add handlers (replace the existing `selectRow`):

```ts
import { type ContextMenuItem, useUi } from '../stores/ui'
```

```ts
function orderedNames(): string[] {
  return filteredRows.value.map((r) => r.name)
}
function onRowClick(e: MouseEvent, name: string): void {
  if (e.metaKey || e.ctrlKey) ui.toggleSelect(name)
  else if (e.shiftKey) ui.selectRange(name, orderedNames())
  else ui.selectOnly(name)
}
function vmMenuItems(row: Row): ContextMenuItem[] {
  const name = row.name
  const items: ContextMenuItem[] = [{ label: 'Open', run: () => ui.selectOnly(name) }]
  if (row.status === 'running') {
    items.push({ label: 'Suspend', run: () => store.suspend(name) })
    items.push({ label: 'Stop', run: () => store.down(name) })
  } else {
    items.push({
      label: row.status === 'suspended' ? 'Resume' : 'Start',
      run: () => store.resume(name),
    })
  }
  items.push({ label: 'Snapshot…', run: () => ui.requestSnapshot([name]) })
  items.push({ label: 'Duplicate', run: () => store.duplicate(name) })
  items.push({ label: 'Rename', run: () => ui.startRename(name) })
  items.push({
    label: 'Connect',
    run: () => {
      ui.selectVm(name)
      store.selectedTab = 'connect'
    },
  })
  items.push({ label: 'Delete', danger: true, run: () => ui.askDeleteVm(name) })
  return items
}
function bulkMenuItems(names: string[]): ContextMenuItem[] {
  return [
    { label: `Suspend ${names.length}`, run: () => store.bulkSuspend(names) },
    { label: `Stop ${names.length}`, run: () => store.bulkStop(names) },
    { label: `Resume ${names.length}`, run: () => store.bulkResume(names) },
    { label: `Snapshot ${names.length}…`, run: () => ui.requestSnapshot(names) },
  ]
}
function onContext(e: MouseEvent, row: Row): void {
  if (row.status === 'creating') return
  const sel = ui.selectedVms
  const items = sel.length >= 2 && sel.includes(row.name) ? bulkMenuItems(sel) : vmMenuItems(row)
  ui.openContextMenu(e.clientX, e.clientY, items)
}
```

- [ ] **Step 4: Wire the row template**

On the `v-for="row in filteredRows"` `<button>`, replace `@click="selectRow(row.name)"` with:

```html
        @click="onRowClick($event, row.name)"
        @contextmenu.prevent="onContext($event, row)"
```

Add selection styling — extend the row's `:class` array with a selected ring:

```html
          ui.isSelected(row.name) ? 'ring-1 ring-[var(--emerald)]' : '',
```

- [ ] **Step 5: Run tests**

Run: `bun run test:unit FleetSidebar`
Expected: PASS (new + existing — the pre-existing "selects a row via ui.selectVm" test still passes because `selectOnly` calls `selectVm`).

- [ ] **Step 6: Commit**

```bash
git add desktop/src/components/FleetSidebar.vue desktop/tests/unit/FleetSidebar.test.ts
git commit -m "feat(desktop): modifier-select and right-click menu on fleet rows"
```

---

### Task 6: BulkPanel + HomePage integration

**Files:**
- Create: `desktop/src/components/BulkPanel.vue`
- Modify: `desktop/src/pages/HomePage.vue`
- Test: `desktop/tests/unit/BulkPanel.test.ts`

**Interfaces:**
- Consumes: `ui.selectedVms/selectionCount/toggleSelect/clearSelection`, `store.bulkSuspend/bulkStop/bulkResume/bulkNuke`, `ui.requestSnapshot`.

- [ ] **Step 1: Write the failing test**

```ts
// desktop/tests/unit/BulkPanel.test.ts
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun run test:unit BulkPanel`
Expected: FAIL (component missing).

- [ ] **Step 3: Create BulkPanel**

```vue
<!-- desktop/src/components/BulkPanel.vue -->
<script setup lang="ts">
import { ref } from 'vue'
import { useFleet } from '../stores/fleet'
import { useUi } from '../stores/ui'

const store = useFleet()
const ui = useUi()
const armedDelete = ref(false)

function del(): void {
  const names = [...ui.selectedVms]
  if (!armedDelete.value) {
    armedDelete.value = true
    return
  }
  armedDelete.value = false
  store.bulkNuke(names)
  ui.clearSelection()
}
</script>

<template>
  <div class="flex flex-1 flex-col items-center justify-center gap-5 p-6 text-[var(--text-dim)]">
    <div class="text-[15px] font-[550] text-[var(--text)]">{{ ui.selectionCount }} selected</div>
    <div class="flex max-w-[420px] flex-wrap justify-center gap-1.5">
      <span
        v-for="name in ui.selectedVms"
        :key="name"
        class="flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--bg-elev2)] px-2 py-1 font-mono text-[11px]"
      >
        {{ name }}
        <button type="button" class="text-[var(--text-faint)]" @click="ui.toggleSelect(name)">✕</button>
      </span>
    </div>
    <div class="flex flex-wrap justify-center gap-2">
      <button type="button" data-test="bulk-suspend" class="h-9 rounded-lg border border-[var(--border)] bg-[var(--bg-elev2)] px-3 text-xs" @click="store.bulkSuspend([...ui.selectedVms])">⏸ Suspend</button>
      <button type="button" data-test="bulk-resume" class="h-9 rounded-lg border border-[var(--border)] bg-[var(--bg-elev2)] px-3 text-xs" @click="store.bulkResume([...ui.selectedVms])">▶ Resume</button>
      <button type="button" data-test="bulk-stop" class="h-9 rounded-lg border border-[var(--border)] bg-[var(--bg-elev2)] px-3 text-xs" @click="store.bulkStop([...ui.selectedVms])">■ Stop</button>
      <button type="button" data-test="bulk-snapshot" class="h-9 rounded-lg border border-[var(--border)] bg-[var(--bg-elev2)] px-3 text-xs" @click="ui.requestSnapshot([...ui.selectedVms])">◈ Snapshot</button>
      <button type="button" data-test="bulk-delete" class="h-9 rounded-lg border border-[var(--border)] px-3 text-xs text-[var(--red)]" @click="del">{{ armedDelete ? 'Confirm delete' : '🗑 Delete' }}</button>
    </div>
    <button type="button" data-test="bulk-clear" class="text-[11px] text-[var(--text-faint)]" @click="ui.clearSelection()">Clear selection</button>
  </div>
</template>
```

- [ ] **Step 4: Show it in HomePage when 2+ selected**

In `desktop/src/pages/HomePage.vue`, import `BulkPanel` and make it the first branch inside `<main>`:

```ts
import BulkPanel from '../components/BulkPanel.vue'
```

Change the `<main>` body so bulk takes priority:

```html
      <BulkPanel v-if="ui.selectionCount >= 2" />
      <VmDetail
        v-else-if="selectedVm"
        :key="ui.selectedVm!"
        :name="ui.selectedVm!"
        :state="selectedVm.state"
        :healthy="selectedVm.healthy"
      />
      <div v-else ...>  <!-- unchanged empty state -->
```

(Only the `v-if`/`v-else-if` wiring changes; leave the empty-state block as-is.)

- [ ] **Step 5: Run the full desktop suite + lint + typecheck**

Run: `bun run test:unit && bun run lint && bunx vue-tsc -b`
Expected: PASS, clean, exit 0.

- [ ] **Step 6: Commit**

```bash
git add desktop/src/components/BulkPanel.vue desktop/src/pages/HomePage.vue desktop/tests/unit/BulkPanel.test.ts
git commit -m "feat(desktop): bulk-action panel for multi-selected VMs"
```

---

## Self-Review

**Spec coverage (Features B & C):** B context menu → Tasks 2 (state), 3 (component), 5 (row wiring + item builders). B snapshot-row menu: covered functionally by the Plan-1 inline restore/delete controls; the spec's "relocate into context menu" is a cosmetic follow-up, not required. C selection model (⌘/⇧/⌘A/Escape) → Task 1 + Task 5 wiring (⌘A/Escape are ui actions `selectAll`/`clearSelection`, reachable from a later keyboard-hookup; the sidebar wires ⌘/⇧-click here). C bulk panel + actions → Tasks 4 (runBulk) + 6 (BulkPanel + HomePage). Throttled fan-out → Task 4 (cap 3).

**Deviations from spec (intentional, noted at top):** "Restore from snapshot…" is not in the VM context menu (destructive op needs confirm; restore lives on snapshot rows). Bulk delete is only in `BulkPanel`, not the context menu. ⌘A select-all / Escape-clear keyboard shortcuts expose store actions (`selectAll`/`clearSelection`) but the global keydown binding is deferred to a small follow-up (the `useHotkeys` composable) — not blocking.

**Placeholder scan:** none.

**Type consistency:** `ContextMenuItem` defined in Task 2 and consumed in Tasks 3 & 5. `selectedVms`/`selectionCount`/`isSelected`/`selectOnly`/`toggleSelect`/`selectRange`/`clearSelection` consistent across Tasks 1, 5, 6. `bulkSuspend/bulkStop/bulkResume/bulkNuke` consistent across Tasks 4, 5, 6. `Row` is the existing local interface in `FleetSidebar.vue`.
