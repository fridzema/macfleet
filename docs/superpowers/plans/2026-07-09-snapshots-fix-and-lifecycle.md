# Snapshots: fix + lifecycle — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Snapshot button work and give snapshots a full lifecycle — named snapshots, in-place restore, and delete from the sidebar.

**Architecture:** Engine gains `Fleet.restore()` and a duplicate-label guard in `Fleet.snapshot()`; a new `POST /vms/{name}/restore` endpoint and a `restore` CLI command expose it. The desktop stops sending the hyphenated label that 409s today, moves snapshot naming into a shared `SnapshotDialog`, and adds restore/delete controls to the sidebar snapshot rows.

**Tech Stack:** Python 3.12 (uv, pytest, Typer, FastAPI), Vue 3 + Pinia + TypeScript (bun, vitest), tart CLI.

This is **Plan 1 of 3** for the combined spec `docs/superpowers/specs/2026-07-09-fleet-ux-snapshots-and-shared-folders-design.md`. Plans 2 (context menu + multi-select) and 3 (shared folders) follow.

## Global Constraints

- Strict typing: PHP/TS strict, Python `from __future__ import annotations` + type hints (match existing modules).
- Engine tests: `uv run pytest`. Desktop tests: `bun run test:unit` from `desktop/`.
- Engine lint: `make lint-engine` (ruff). Desktop lint: `bun run lint` (eslint + biome), typecheck `bunx vue-tsc -b`.
- Conventional commits, no `Co-authored-by` trailers.
- Snapshot ids are `mfsnap-<vm>-<label>`, split on the **last** hyphen; labels must match `^[A-Za-z0-9][A-Za-z0-9._]{0,63}$` (no hyphen). Do not weaken `validate_label`.
- Engine `tart` is faked in tests via the `_fleet(tmp_path, vms=[...])` helper in `tests/test_connect.py` (returns `fleet, calls, spawned, lease`).

---

### Task 1: Engine — reject duplicate snapshot ids

**Files:**
- Modify: `macfleet/connect.py` (`Fleet.snapshot`)
- Test: `tests/test_connect.py`

**Interfaces:**
- Produces: `Fleet.snapshot(name, label)` now raises `RuntimeError` if `mfsnap-<vm>-<label>` already exists, before touching the source VM.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_connect.py
def test_snapshot_rejects_duplicate_id(tmp_path):
    fleet, _, _, _ = _fleet(tmp_path, vms=[
        VmInfo("mf-web", "stopped", "local"),
        VmInfo("mfsnap-web-clean", "stopped", "local"),
    ])
    with pytest.raises(RuntimeError, match="already exists"):
        fleet.snapshot("web", "clean")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_connect.py::test_snapshot_rejects_duplicate_id -v`
Expected: FAIL (currently attempts `tart clone` and does not raise "already exists").

- [ ] **Step 3: Add the guard**

In `macfleet/connect.py`, at the top of `snapshot()` (after `validate_label(label)`), insert:

```python
        sid = f"mfsnap-{shortname(name)}-{label}"
        if sid in {v.name for v in self.tart.list()}:
            raise RuntimeError(f"snapshot {shortname(name)}-{label} already exists")
```

Then reuse `sid` for the clone call: change `self.tart.clone(src, f"mfsnap-{shortname(name)}-{label}")` to `self.tart.clone(src, sid)`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_connect.py -k snapshot -v`
Expected: PASS (new test plus existing `test_snapshot_*`).

- [ ] **Step 5: Commit**

```bash
git add macfleet/connect.py tests/test_connect.py
git commit -m "fix(engine): reject duplicate snapshot ids before cloning"
```

---

### Task 2: Engine — `Fleet.restore()`

**Files:**
- Modify: `macfleet/connect.py`
- Test: `tests/test_connect.py`

**Interfaces:**
- Produces: `Fleet.restore(name: str, snapshot_id: str) -> None`. Verifies `mfsnap-<snapshot_id>` exists; if `mf-<name>` exists it is stopped+deleted first; then clones the snapshot to `mf-<name>` and boots it. Rejects the golden template (via `ensure_mutable`) and invalid names (via `validate_name`).

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_connect.py
def test_restore_stops_deletes_clones_runs_when_vm_exists(tmp_path):
    fleet, calls, spawned, _ = _fleet(tmp_path, vms=[
        VmInfo("mf-web", "running", "local"),
        VmInfo("mfsnap-web-clean", "stopped", "local"),
    ])
    fleet.restore("web", "web-clean")
    assert calls.index(["tart", "stop", "mf-web"]) \
        < calls.index(["tart", "delete", "mf-web"]) \
        < calls.index(["tart", "clone", "mfsnap-web-clean", "mf-web"])
    assert ["tart", "run", "mf-web", "--no-graphics"] in spawned


def test_restore_recreates_when_vm_absent(tmp_path):
    fleet, calls, spawned, _ = _fleet(
        tmp_path, vms=[VmInfo("mfsnap-web-clean", "stopped", "local")])
    fleet.restore("web", "web-clean")
    assert not any(c[:2] == ["tart", "delete"] for c in calls)
    assert ["tart", "clone", "mfsnap-web-clean", "mf-web"] in calls
    assert ["tart", "run", "mf-web", "--no-graphics"] in spawned


def test_restore_rejects_unknown_snapshot(tmp_path):
    fleet, _, _, _ = _fleet(tmp_path, vms=[VmInfo("mf-web", "running", "local")])
    with pytest.raises(RuntimeError, match="not found"):
        fleet.restore("web", "web-clean")


def test_restore_rejects_golden():
    fleet = Fleet(tart=Tart(run=fake_runner(lambda argv: "")))
    with pytest.raises(RuntimeError, match="protected template"):
        fleet.restore("golden", "web-clean")
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_connect.py -k restore -v`
Expected: FAIL with `AttributeError: 'Fleet' object has no attribute 'restore'`.

- [ ] **Step 3: Implement `restore`**

Add to `macfleet/connect.py` (near `duplicate`):

```python
    def restore(self, name: str, snapshot_id: str) -> None:
        """Restore mf-<name> to a snapshot: stop+delete the current VM (if any), clone the
        snapshot over its name, and boot it (resumes the captured state). Destructive — the
        VM's current disk/state is discarded. Works when the VM no longer exists (recreate)."""
        target = ensure_mutable(name)
        validate_name(name)
        snap = f"mfsnap-{snapshot_id}"
        names = {v.name for v in self.tart.list()}
        if snap not in names:
            raise RuntimeError(f"snapshot {snapshot_id} not found")
        if target in names:
            try:
                self.tart.stop(target)
            except RuntimeError:
                pass
            self.tart.delete(target)
            self._res_cache.pop(target, None)
            self._forget_ip(target)
            self._leases.unsuspend(target)
        self.tart.clone(snap, target)
        self._spawn(["tart", "run", target, "--no-graphics"])
```

Note: this boots with the plain run args. Plan 3 (shared folders) introduces `_run_argv` and routes this boot through it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_connect.py -k restore -v`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add macfleet/connect.py tests/test_connect.py
git commit -m "feat(engine): Fleet.restore to reset a VM to a snapshot"
```

---

### Task 3: Engine surface — restore endpoint + CLI

**Files:**
- Modify: `macfleet/api.py`, `macfleet/cli.py`
- Test: `tests/test_api.py`, `tests/test_cli.py`

**Interfaces:**
- Consumes: `Fleet.restore(name, snapshot_id)` from Task 2.
- Produces: `POST /vms/{name}/restore` (body `{"snapshot_id": str}` → `{"ok": true}`) and CLI `macfleet restore <name> <snapshot_id>`.

- [ ] **Step 1: Write the failing API test**

Add a `restore` method to the `FakeFleet` in `tests/test_api.py` (inside the class, next to `down`):

```python
    def restore(self, name, snapshot_id):
        self.calls.append(("restore", name, snapshot_id))
```

Add the test:

```python
def test_restore_endpoint_calls_fleet():
    fake = FakeFleet()
    client = TestClient(build_app(fleet=fake))
    r = client.post("/vms/web/restore", json={"snapshot_id": "web-clean"})
    assert r.status_code == 200
    assert r.json() == {"ok": True}
    assert ("restore", "web", "web-clean") in fake.calls
```

- [ ] **Step 2: Run it to verify it fails**

Run: `uv run pytest tests/test_api.py::test_restore_endpoint_calls_fleet -v`
Expected: FAIL with 404 (route not defined).

- [ ] **Step 3: Add the endpoint**

In `macfleet/api.py`, add a request model near the other `BaseModel`s:

```python
class RestoreRequest(BaseModel):
    snapshot_id: str
```

And a route near `snapshot`/`duplicate`:

```python
    @api.post("/vms/{name}/restore")
    def restore(name: str, body: RestoreRequest) -> dict:
        fleet.restore(name, body.snapshot_id)
        return {"ok": True}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `uv run pytest tests/test_api.py::test_restore_endpoint_calls_fleet -v`
Expected: PASS.

- [ ] **Step 5: Write the failing CLI test**

```python
# tests/test_cli.py
def test_restore_command(monkeypatch):
    calls = {}

    class FakeFleet:
        def restore(self, name, snapshot_id):
            calls["restore"] = (name, snapshot_id)

    monkeypatch.setattr(cli, "_fleet", lambda: FakeFleet())
    result = runner.invoke(cli.app, ["restore", "web", "web-clean"])
    assert result.exit_code == 0
    assert calls["restore"] == ("web", "web-clean")
```

- [ ] **Step 6: Run it to verify it fails**

Run: `uv run pytest tests/test_cli.py::test_restore_command -v`
Expected: FAIL (no `restore` command).

- [ ] **Step 7: Add the CLI command**

In `macfleet/cli.py`, near `clone`:

```python
@app.command()
def restore(name: str, snapshot_id: str) -> None:
    """Restore mf-<name> to a snapshot (replaces its disk with the captured state)."""
    _fleet().restore(name, snapshot_id)
    typer.echo(f"restored: mf-{name} <- {snapshot_id}")
```

- [ ] **Step 8: Run engine tests + lint**

Run: `uv run pytest tests/test_api.py tests/test_cli.py -v && make lint-engine`
Expected: PASS, lint clean.

- [ ] **Step 9: Commit**

```bash
git add macfleet/api.py macfleet/cli.py tests/test_api.py tests/test_cli.py
git commit -m "feat(engine): restore endpoint and CLI command"
```

---

### Task 4: Desktop — label util, `api.restore`, `store.restoreVM`

**Files:**
- Create: `desktop/src/shared/snapshot.ts`
- Modify: `desktop/src/shared/api.ts`, `desktop/src/stores/fleet.ts`
- Test: `desktop/tests/unit/snapshot.test.ts`, `desktop/tests/unit/fleet.test.ts`

**Interfaces:**
- Produces: `sanitizeLabel(raw: string): string`, `defaultSnapshotLabel(now: Date): string`, `api.restore(name, snapshotId)`, `store.restoreVM(name, snapshotId): Promise<void>`.

- [ ] **Step 1: Write the failing util test**

```ts
// desktop/tests/unit/snapshot.test.ts
import { describe, expect, it } from 'vitest'
import { defaultSnapshotLabel, sanitizeLabel } from '../../src/shared/snapshot'

describe('snapshot labels', () => {
  it('replaces hyphens and spaces with dots', () => {
    expect(sanitizeLabel('web-snap test')).toBe('web.snap.test')
  })
  it('strips leading non-alphanumerics and caps length', () => {
    expect(sanitizeLabel('--clean')).toBe('clean')
    expect(sanitizeLabel('x'.repeat(80)).length).toBe(64)
  })
  it('formats a hyphen-free timestamp', () => {
    expect(defaultSnapshotLabel(new Date(2026, 6, 9, 15, 23, 1))).toBe('20260709.152301')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run (from `desktop/`): `bun run test:unit snapshot`
Expected: FAIL (module not found).

- [ ] **Step 3: Create the util**

```ts
// desktop/src/shared/snapshot.ts
// Snapshot labels become part of the id `mfsnap-<vm>-<label>`, split on the last hyphen,
// so a label must have no hyphen. The engine validator allows only [A-Za-z0-9._] with an
// alphanumeric first char; mirror that here for instant feedback (engine still validates).
const INVALID = /[^A-Za-z0-9._]/g

export function sanitizeLabel(raw: string): string {
  return raw
    .trim()
    .replace(INVALID, '.')
    .replace(/^[^A-Za-z0-9]+/, '')
    .slice(0, 64)
}

export function defaultSnapshotLabel(now: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return (
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `.${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
  )
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `bun run test:unit snapshot`
Expected: PASS.

- [ ] **Step 5: Add `api.restore`**

In `desktop/src/shared/api.ts`, inside the `api` object near `snapshot`:

```ts
  restore: (n: string, snapshotId: string) =>
    postJson(`/vms/${enc(n)}/restore`, { snapshot_id: snapshotId }),
```

- [ ] **Step 6: Write the failing store test**

```ts
// desktop/tests/unit/fleet.test.ts  (add inside the lifecycle-mutations describe block)
  it('restoreVM calls api.restore then refreshes and toasts', async () => {
    const restore = vi.spyOn(api, 'restore').mockResolvedValue({})
    const s = useFleet()
    await s.restoreVM('web', 'web-clean')
    expect(restore).toHaveBeenCalledWith('web', 'web-clean')
    expect(useToasts().toasts.value.some((t) => t.msg === 'Restored')).toBe(true)
    expect(s.error).toBeNull()
  })

  it('restoreVM sets error and toasts on failure', async () => {
    vi.spyOn(api, 'restore').mockRejectedValue(new Error('409'))
    const s = useFleet()
    await s.restoreVM('web', 'web-clean')
    expect(s.error).toContain('409')
    expect(useToasts().toasts.value.some((t) => t.msg.includes('Failed to restore web'))).toBe(true)
  })
```

- [ ] **Step 7: Run it to verify it fails**

Run: `bun run test:unit fleet`
Expected: FAIL (`restoreVM` undefined).

- [ ] **Step 8: Implement `restoreVM`**

In `desktop/src/stores/fleet.ts`, add near `snapshotVM`:

```ts
  async function restoreVM(name: string, snapshotId: string): Promise<void> {
    toast(`Restoring ${name}…`, '↺')
    try {
      await api.restore(name, snapshotId)
      await refresh()
      toast('Restored', '✓')
    } catch (e) {
      error.value = String(e)
      toast(`Failed to restore ${name}`, '⚠')
    }
  }
```

Add `restoreVM` to the store's returned object (next to `snapshotVM`).

- [ ] **Step 9: Run desktop tests + lint + typecheck**

Run: `bun run test:unit && bun run lint && bunx vue-tsc -b`
Expected: PASS, clean, exit 0.

- [ ] **Step 10: Commit**

```bash
git add desktop/src/shared/snapshot.ts desktop/src/shared/api.ts desktop/src/stores/fleet.ts desktop/tests/unit/snapshot.test.ts desktop/tests/unit/fleet.test.ts
git commit -m "feat(desktop): snapshot label util, api.restore, store.restoreVM"
```

---

### Task 5: Desktop — SnapshotDialog + naming trigger

**Files:**
- Create: `desktop/src/components/SnapshotDialog.vue`
- Modify: `desktop/src/stores/ui.ts`, `desktop/src/components/VmDetail.vue`, `desktop/src/layouts/DefaultLayout.vue`
- Test: `desktop/tests/unit/SnapshotDialog.test.ts`

**Interfaces:**
- Consumes: `sanitizeLabel`, `defaultSnapshotLabel`, `store.snapshotVM(name, label)`.
- Produces: `ui.snapshotTarget: Ref<string[] | null>`, `ui.requestSnapshot(names: string[])`, `ui.closeSnapshot()`. The dialog is the ONLY place labels are constructed — this removes the buggy `${name}-snap` call sites.

- [ ] **Step 1: Add ui store state**

In `desktop/src/stores/ui.ts`, add refs + actions in the store setup and expose them in the returned object:

```ts
  const snapshotTarget = ref<string[] | null>(null)
  function requestSnapshot(names: string[]): void {
    snapshotTarget.value = names
  }
  function closeSnapshot(): void {
    snapshotTarget.value = null
  }
```

Return `snapshotTarget, requestSnapshot, closeSnapshot` alongside the other exposed members.

- [ ] **Step 2: Repoint the two buggy snapshot triggers**

In `desktop/src/stores/ui.ts` command palette, change the `'snap'` action:

```ts
      push('snap', `Snapshot ${name}`, 'VM', () => requestSnapshot([name]))
```

In `desktop/src/components/VmDetail.vue`, change `snapshot()`:

```ts
function snapshot(): void {
  ui.requestSnapshot([props.name])
}
```

(Remove the now-unused `store` reference in `snapshot()` if it leaves `store` unused — it does not, `store` is used elsewhere.)

- [ ] **Step 3: Write the failing dialog test**

```ts
// desktop/tests/unit/SnapshotDialog.test.ts
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, expect, it, vi } from 'vitest'
import SnapshotDialog from '../../src/components/SnapshotDialog.vue'
import { useFleet } from '../../src/stores/fleet'
import { useUi } from '../../src/stores/ui'

beforeEach(() => setActivePinia(createPinia()))

it('prefills a timestamp label and snapshots each target with a sanitized label', async () => {
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
```

- [ ] **Step 4: Run it to verify it fails**

Run: `bun run test:unit SnapshotDialog`
Expected: FAIL (component missing).

- [ ] **Step 5: Create the dialog**

```vue
<!-- desktop/src/components/SnapshotDialog.vue -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { defaultSnapshotLabel, sanitizeLabel } from '../shared/snapshot'
import { useFleet } from '../stores/fleet'
import { useUi } from '../stores/ui'

const ui = useUi()
const fleet = useFleet()
const label = ref('')

const targets = computed(() => ui.snapshotTarget ?? [])
const open = computed(() => targets.value.length > 0)
const clean = computed(() => sanitizeLabel(label.value))
const valid = computed(() => clean.value.length > 0)

watch(open, (isOpen) => {
  if (isOpen) label.value = defaultSnapshotLabel(new Date())
})

async function save(): Promise<void> {
  if (!valid.value) return
  const names = targets.value
  const chosen = clean.value
  ui.closeSnapshot()
  for (const name of names) await fleet.snapshotVM(name, chosen)
}
</script>

<template>
  <div
    v-if="open"
    data-test="snapshot-dialog"
    class="fixed inset-0 z-40 flex items-center justify-center bg-black/40"
    @click.self="ui.closeSnapshot()"
  >
    <div class="w-[320px] rounded-xl border border-[var(--border)] bg-[var(--bg-elev)] p-4">
      <div class="mb-2 text-sm font-semibold text-[var(--text)]">
        Snapshot {{ targets.join(', ') }}
      </div>
      <input
        v-model="label"
        data-test="snapshot-label"
        class="h-9 w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2.5 font-mono text-[12.5px] text-[var(--text)] outline-none"
        @keydown.enter="save"
        @keydown.escape="ui.closeSnapshot()"
      />
      <div class="mt-1 font-mono text-[11px] text-[var(--text-faint)]">
        id: mfsnap-…-{{ clean || '?' }}
      </div>
      <div class="mt-3 flex justify-end gap-2">
        <button
          type="button"
          data-test="snapshot-cancel"
          class="h-8 rounded-lg border border-[var(--border)] px-3 text-xs text-[var(--text-dim)]"
          @click="ui.closeSnapshot()"
        >
          Cancel
        </button>
        <button
          type="button"
          data-test="snapshot-save"
          :disabled="!valid"
          class="h-8 rounded-lg bg-[var(--emerald)] px-3 text-xs font-semibold text-[#04130d] disabled:opacity-50"
          @click="save"
        >
          Save
        </button>
      </div>
    </div>
  </div>
</template>
```

- [ ] **Step 6: Mount the dialog globally**

In `desktop/src/layouts/DefaultLayout.vue`, import and render it beside `CommandPalette`:

```ts
import SnapshotDialog from '../components/SnapshotDialog.vue'
```

```html
    <CommandPalette />
    <SnapshotDialog />
    <ToastStack />
```

- [ ] **Step 7: Run tests + lint + typecheck**

Run: `bun run test:unit && bun run lint && bunx vue-tsc -b`
Expected: PASS, clean, exit 0. (Existing `ui.test.ts` / `CommandPalette.test.ts` / `VmDetail.test.ts` may assert the old `snapshotVM(name, '<name>-snap')` call — update those assertions to expect `requestSnapshot([name])` instead.)

- [ ] **Step 8: Commit**

```bash
git add desktop/src/components/SnapshotDialog.vue desktop/src/stores/ui.ts desktop/src/components/VmDetail.vue desktop/src/layouts/DefaultLayout.vue desktop/tests/unit/SnapshotDialog.test.ts desktop/tests/unit/ui.test.ts desktop/tests/unit/VmDetail.test.ts
git commit -m "feat(desktop): SnapshotDialog for named snapshots; fix the broken label"
```

---

### Task 6: Desktop — restore + delete on sidebar snapshot rows

**Files:**
- Modify: `desktop/src/components/FleetSidebar.vue`
- Test: `desktop/tests/unit/FleetSidebar.test.ts`

**Interfaces:**
- Consumes: `store.restoreVM(vm, id)`, `store.deleteSnapshot(id)`.
- Produces: two-step Restore and Delete controls per snapshot row (destructive, so both confirm).

- [ ] **Step 1: Write the failing test**

```ts
// desktop/tests/unit/FleetSidebar.test.ts (mount FleetSidebar with a snapshot in the store)
  it('two-step deletes a snapshot from its row', async () => {
    const s = useFleet()
    s.snapshots = [{ id: 'web-clean', vm: 'web', label: 'clean', size: 2 }]
    const del = vi.spyOn(s, 'deleteSnapshot').mockResolvedValue()
    const w = mount(FleetSidebar)
    await w.vm.$nextTick()
    await w.get('[data-test="snap-delete"]').trigger('click') // arm
    expect(del).not.toHaveBeenCalled()
    await w.get('[data-test="snap-delete"]').trigger('click') // confirm
    expect(del).toHaveBeenCalledWith('web-clean')
  })

  it('two-step restores the snapshot\'s VM from its row', async () => {
    const s = useFleet()
    s.snapshots = [{ id: 'web-clean', vm: 'web', label: 'clean', size: 2 }]
    const restore = vi.spyOn(s, 'restoreVM').mockResolvedValue()
    const w = mount(FleetSidebar)
    await w.vm.$nextTick()
    await w.get('[data-test="snap-restore"]').trigger('click')
    await w.get('[data-test="snap-restore"]').trigger('click')
    expect(restore).toHaveBeenCalledWith('web', 'web-clean')
  })
```

(Match the existing `FleetSidebar.test.ts` mount/pinia setup — reuse its `beforeEach`.)

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run test:unit FleetSidebar`
Expected: FAIL (`snap-delete` / `snap-restore` not found).

- [ ] **Step 3: Add the arm-then-confirm state + handlers**

In `FleetSidebar.vue` `<script setup>`:

```ts
const armedSnap = ref<{ id: string; action: 'delete' | 'restore' } | null>(null)
function isArmed(id: string, action: 'delete' | 'restore'): boolean {
  return armedSnap.value?.id === id && armedSnap.value.action === action
}
function snapAction(sn: Snapshot, action: 'delete' | 'restore'): void {
  if (!isArmed(sn.id, action)) {
    armedSnap.value = { id: sn.id, action }
    return
  }
  armedSnap.value = null
  if (action === 'delete') store.deleteSnapshot(sn.id)
  else store.restoreVM(sn.vm, sn.id)
}
```

Ensure `Snapshot` is imported (it already is via `../shared/api` where `Vm` is imported — add `type Snapshot`).

- [ ] **Step 4: Add the row buttons**

Inside the snapshot-row `v-for="sn in filteredSnaps"`, after the existing "＋ VM" button, add:

```html
        <button
          type="button"
          data-test="snap-restore"
          title="Restore this VM to the snapshot"
          class="h-[26px] shrink-0 rounded-[7px] border border-[var(--border)] px-2 text-[11px] whitespace-nowrap text-[var(--text-dim)]"
          @click="snapAction(sn, 'restore')"
        >
          {{ isArmed(sn.id, 'restore') ? 'Confirm ↺' : '↺' }}
        </button>
        <button
          type="button"
          data-test="snap-delete"
          title="Delete snapshot"
          class="h-[26px] shrink-0 rounded-[7px] border border-[var(--border)] px-2 text-[11px] whitespace-nowrap text-[var(--red)]"
          @click="snapAction(sn, 'delete')"
        >
          {{ isArmed(sn.id, 'delete') ? 'Confirm 🗑' : '🗑' }}
        </button>
```

- [ ] **Step 5: Run desktop suite + lint + typecheck**

Run: `bun run test:unit && bun run lint && bunx vue-tsc -b`
Expected: PASS, clean, exit 0.

- [ ] **Step 6: Full regression + commit**

```bash
uv run pytest -q
cd desktop && bun run test:unit && cd ..
git add desktop/src/components/FleetSidebar.vue desktop/tests/unit/FleetSidebar.test.ts
git commit -m "feat(desktop): restore and delete snapshots from the sidebar"
```

---

## Self-Review

**Spec coverage (Feature A):** A1 label fix → Tasks 4 (util) + 5 (removes `${name}-snap` call sites). A2 naming → Task 5. A3 restore → Tasks 2 (engine), 3 (API/CLI), 4 (store), 6 (UI trigger). A4 delete → Task 6. Duplicate-label rejection → Task 1. MCP `restore_vm` tool: **intentionally deferred** (spec-optional); note for a later small task. Snapshot-row Restore/Delete live inline here rather than in the Plan 2 context menu, so Plan 1 is shippable on its own; Plan 2 may relocate them.

**Placeholder scan:** none — every step has concrete code/commands.

**Type consistency:** `restoreVM(name, snapshotId)`, `api.restore(n, snapshotId)`, `POST /vms/{name}/restore` `{snapshot_id}`, `Fleet.restore(name, snapshot_id)`, `sanitizeLabel`/`defaultSnapshotLabel`, `ui.requestSnapshot(names)`/`snapshotTarget` are consistent across tasks.

**Known cross-task test touch-ups:** Task 5 Step 7 flags that existing `ui.test.ts` / `CommandPalette.test.ts` / `VmDetail.test.ts` assertions referencing the old `snapshotVM(name, '<name>-snap')` must be updated to `requestSnapshot([name])`.
