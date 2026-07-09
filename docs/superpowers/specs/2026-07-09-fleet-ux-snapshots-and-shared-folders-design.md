# Fleet UX: snapshots, right-click, multi-select, and shared folders

Status: approved design (2026-07-09) — ready for an implementation plan.

## Summary

Four changes to macfleet, designed as one combined spec:

1. **Snapshots — fix + full lifecycle.** The Snapshot button is broken; fix it,
   then add naming, in-place restore, and delete-from-sidebar.
2. **Right-click context menu** on VM (and snapshot) rows, surfacing the existing
   per-VM actions.
3. **Multi-select** VMs with ⌘/⇧-click plus a bulk-action panel.
4. **Shared folders** between host and guest, read-only by default, applied on the
   VM's next start.

Confirmed product decisions: multi-select uses ⌘/⇧-click with a bulk bar (not
checkboxes); snapshots get the full create/name/restore/delete lifecycle; shared
folders default to read-only and apply on next start (no surprise restarts).

## Goals

- Snapshots work from the UI and support a full lifecycle.
- Common per-VM actions are reachable via right-click.
- Operate on several VMs at once without a subprocess storm.
- Mount host directories into guests, safely and predictably.

## Non-goals (YAGNI)

- Fleet-wide default shares (a folder auto-mounted into every VM). Per-VM only.
- Renaming an existing snapshot (name is set at creation; delete + recreate).
- A batch API endpoint for bulk operations (client-side throttled fan-out instead).
- Checkboxes for selection (⌘/⇧-click chosen).
- Guest-side automount tooling — rely on tart/macOS VirtioFS automount.

## Current state (grounding)

- Engine (`macfleet/`): `Fleet` in `connect.py` shells out to `tart`; `api.py`
  (FastAPI), `mcp.py` (MCP server), `cli.py` (Typer). `leases.py` and
  `activity.py` are small single-file stores under `~/.macfleet/`.
- Desktop (`desktop/`): Tauri + Vue 3 + Pinia. `FleetSidebar.vue` lists VMs as
  plain `<button>`s (single-select via `ui.selectVm`); `VmDetail.vue` has tabs
  (screen/terminal/logs/resources/connect) and a header action bar; `stores/fleet.ts`
  and `stores/ui.ts` hold state; `shared/api.ts` is the HTTP client; `CommandPalette.vue`
  exposes per-VM actions.
- Snapshots already exist end-to-end: `Fleet.snapshot/snapshots/delete_snapshot`,
  `/vms/{name}/snapshot`, `/snapshots`, `store.snapshotVM/deleteSnapshot/newFromSnapshot`,
  a "◈ Snapshot" button, a sidebar snapshot list with "+VM".

### The snapshot bug (root cause)

`VmDetail.vue:115` and `stores/ui.ts:134` call `snapshotVM(name, \`${name}-snap\`)`,
so the **label** sent is e.g. `web-snap`. The engine's `validate_label`
(`vm.py`, `_LABEL_RE = ^[A-Za-z0-9][A-Za-z0-9._]{0,63}$`) forbids `-`, because the
snapshot id is `mfsnap-<vm>-<label>` and is parsed by splitting on the last hyphen.
Every UI snapshot therefore returns `409 invalid snapshot label` → "Failed to
snapshot". The label is meant to be a short, hyphen-free suffix.

---

## Feature A — Snapshots: fix + full lifecycle

### A1. Label fix

- Default label is a hyphen-free timestamp: `YYYYMMDD.HHMMSS` (e.g.
  `20260709.152301`) — digits and dots only, valid under `_LABEL_RE`.
- Client sanitizes user-entered labels: trim, replace any char outside
  `[A-Za-z0-9._]` with `.`, collapse repeats, reject empty. The engine remains
  the source of truth (`validate_label` unchanged).

### A2. Naming

- New `desktop/src/components/SnapshotDialog.vue`: a small modal with a name field
  pre-filled with the timestamp default, Save/Cancel, Enter-to-save, and inline
  validation. Teleported to `<body>`; dismiss on Escape/backdrop.
- Driven by `ui` store state `snapshotTarget: string[] | null` (one name, or many
  for a bulk snapshot). Triggered from: the detail header button, the row context
  menu, the command palette, and the bulk panel.
- A single label applies across many VMs because each id is `mfsnap-<vm>-<label>`.

### A3. Restore in place (new)

- Engine: `Fleet.restore(name, snapshot_id)`:
  1. `ensure_mutable(name)`; verify `mfsnap-<snapshot_id>` exists in `tart list`
     (raise a clear `RuntimeError` if not).
  2. If `mf-<name>` exists: `tart stop` (best-effort) then `tart delete`; drop its
     `_res_cache`/`_ip_cache` entries and `_leases.unsuspend`.
  3. `tart clone mfsnap-<snapshot_id> → mf-<name>`.
  4. Boot the VM (resumes the snapshot's suspended state). Until Feature D lands
     this is `_spawn(["tart","run",fullname(name),"--no-graphics"])`; once D
     introduces `_run_argv`, restore is routed through it so it picks up shares.
  - Works whether or not the VM currently exists (restore == recreate).
  - Leases and shares are keyed by name and survive the restore.
- API: `POST /vms/{name}/restore` body `{snapshot_id}` → `{ok:true}`; tart errors
  surface as `409` via the existing `RuntimeError` handler.
- Client: `api.restore(name, id)`, `store.restoreVM(name, id)` (toast start +
  result, then `refresh()`).
- MCP: add a `restore_vm` tool for parity (optional but cheap).

### A4. Delete from the sidebar

- Add a delete control to each sidebar snapshot row (two-step confirm, mirroring
  the VM delete pattern) wired to the existing `store.deleteSnapshot(id)`.
- Engine: `snapshot()` rejects a duplicate id — if `mfsnap-<vm>-<label>` already
  exists, raise `RuntimeError("snapshot <id> already exists")` instead of letting
  `tart clone` fail opaquely.

### A5. UI touch points

- Sidebar snapshot rows: keep "+VM"; add Restore and Delete (via the row context
  menu from Feature B, to keep rows uncluttered).
- Detail header "◈ Snapshot" opens `SnapshotDialog` instead of firing immediately.

---

## Feature B — Right-click context menu

### Component

- New generic `desktop/src/components/ContextMenu.vue`, teleported to `<body>`,
  positioned at the cursor, dismissed on outside-click / Escape / scroll / window
  blur. Keyboard navigable (↑/↓/Enter). Themed to match the command palette.
- State in `ui` store: `contextMenu: { x, y, items } | null`. A row opens it via
  `@contextmenu.prevent="openMenu($event, name)"`.

### Items

- Single VM (state-aware): Open; Start or Stop, and Suspend or Resume (per state);
  Snapshot…; Restore from snapshot… (submenu of that VM's snapshots, or empty
  state); Duplicate; Rename; Shared folders… (opens the Folders tab); Connect;
  Delete (confirm).
- Snapshot row: Restore, New VM, Delete.
- If the right-clicked VM is part of a 2+ selection, show the **bulk** items
  (Feature C) instead of single-VM items.

All items call existing `store`/`ui` actions; the menu adds no business logic.

---

## Feature C — Multi-select + bulk actions

### Selection model (`ui` store)

- `selection: Set<string>` (short names) and `anchor: string | null` for ranges.
- Plain click → `selectVm(name)`: opens detail, collapses selection to `{name}`.
- ⌘/Ctrl-click → toggle `name` in `selection`, set anchor.
- ⇧-click → select the inclusive range between `anchor` and `name`. Row order is
  owned by the view: `FleetSidebar` passes its ordered visible names to
  `ui.selectRange(name, orderedNames)`, which fills the range against `anchor`.
- ⌘A → select all visible; Escape → clear.
- Selected rows render a highlight/check; `isActive` styling still applies to the
  detail target.

### Main pane when 2+ selected

- `App`/`DefaultLayout` shows a new `BulkPanel.vue` instead of `VmDetail`:
  "N selected", the list of names each with a deselect control, and actions
  Suspend / Stop / Start-Resume / Snapshot all… / Delete (confirm). Clear-selection
  button.

### Bulk execution (`fleet.ts`)

- `runBulk(names, fn, {label})`: runs `fn(name)` with a small concurrency cap
  (e.g. 3) to avoid the tart-subprocess storm that causes fleet flap; awaits all,
  collects failures, does one `refresh()`, and toasts a summary
  ("Suspended 3 VMs" / "2 of 3 failed"). Delete-all routes through a confirm first.
- Reuses existing per-VM API calls; no new engine endpoints.

---

## Feature D — Shared folders

### Persistence — `Shares` store

- New `macfleet/shares.py`: `Shares` class over `~/.macfleet/shares.json`
  (same shape/discipline as `leases.py`: missing/corrupt reads empty; atomic
  temp-file + rename writes). Maps **full** VM name → list of
  `{tag, host_path, read_only}`.
- API: `get(full) -> list`, `set(full, shares) -> None`, `rename(old, new)`,
  `drop(full)`.
- `Fleet` gains a `_shares: Shares` and updates it in `rename` and `nuke`
  (alongside the existing lease updates).

### Boot integration — `_run_argv`

- New `Fleet._run_argv(full) -> list[str]`:
  `["tart", "run", full, "--no-graphics", *dir_flags]` where each share →
  `--dir=<tag>:<host_path>` plus `:ro` when `read_only`.
- Replace every boot site with `_spawn(self._run_argv(...))`:
  `create`, `resume`, `warm_golden` (golden has no shares → just `--no-graphics`),
  `snapshot` (resume source), `duplicate` (resume source + new), and `restore`.
- Tag rules: filesystem-safe, unique per VM; default to the folder basename.
  Host path may use `~`; validated to exist when added.

### Apply model + restart

- Shares take effect only on the next `tart run`. Editing a running VM persists
  immediately; the Folders tab shows a "changes apply on next start" banner with a
  **Restart** button.
- Engine `Fleet.restart(name)`: `tart stop` then `_spawn(self._run_argv(...))`.
- API: `GET /vms/{name}/shares` → list; `PUT /vms/{name}/shares` body `{shares:[…]}`
  (full replace, like `set_resources`); `POST /vms/{name}/restart`.

### UI — Folders tab

- Add `'folders'` to the `Tab` union and `TAB_COMPONENTS`
  (`shared/api.ts`, `stores/fleet.ts`, `VmDetail.vue`); new
  `desktop/src/components/vmtabs/FoldersTab.vue`.
- Lists shares: tag, host path, read-only badge, and the guest path
  `/Volumes/My Shared Files/<tag>`. "Add folder" uses the already-present Tauri
  dialog plugin (`open({directory:true})`) with a text-input fallback outside
  Tauri (dev/e2e). Per-row read-only toggle and remove. Restart banner when the
  VM is running and shares changed since boot.
- `store` gains `shares: Record<string, Share[]>`, `fetchShares(name)`,
  `setShares(name, shares)`, `restart(name)`.

### Security posture

- Read-only is the default; read-write is an explicit per-folder opt-in.
- Shared host directories are readable by guest code, which is computer-use /
  agent-driven. The default stays conservative; the UI labels read-write clearly.
  No enforced denylist of sensitive paths (documented caution).

---

## API surface (new/changed)

| Method | Path | Body | Purpose |
|---|---|---|---|
| POST | `/vms/{name}/restore` | `{snapshot_id}` | Restore VM to a snapshot (A3) |
| GET | `/vms/{name}/shares` | — | List a VM's shares (D) |
| PUT | `/vms/{name}/shares` | `{shares:[…]}` | Replace a VM's shares (D) |
| POST | `/vms/{name}/restart` | — | Stop then boot with current shares (D) |

Existing endpoints power bulk actions unchanged.

## Data / state files

- `~/.macfleet/state.json` — unchanged (leases + suspended).
- `~/.macfleet/shares.json` — new; `{ "<full-name>": [{tag, host_path, read_only}] }`.

## Error handling

- Engine tart/ssh failures already map to `409` via the `RuntimeError` handler;
  restore/restart/shares reuse it. Restore verifies the snapshot exists first.
- Duplicate snapshot labels → clear `409 snapshot <id> already exists`.
- Bulk: per-VM failures are collected, not fatal; the summary toast reports counts
  and the store `error` carries the first failure.
- Shares: non-existent host path rejected on add (client + engine validate);
  invalid/duplicate tag rejected.

## Testing

- **Engine (pytest):** `Shares` round-trip + rename/nuke propagation; `_run_argv`
  flag assembly (RO/RW, empty); `restore` ordering (stop→delete→clone→run) and the
  no-existing-VM path; `restart`; duplicate-label rejection; timestamp label
  validity. Faked `tart` runner as elsewhere in `test_connect.py`.
- **Desktop (vitest):** selection (⌘ toggle, ⇧ range over filtered order, ⌘A,
  Escape); `runBulk` concurrency cap + failure summary; context-menu wiring;
  snapshot dialog sanitization; `restoreVM`/`deleteSnapshot` store actions;
  shares store + FoldersTab (add/remove/RO toggle, restart banner).
- **e2e (Playwright, mocked):** right-click → action; ⌘/⇧ multi-select → bulk
  suspend; snapshot create → restore → delete; add/remove a shared folder.

## Implementation phasing (for the plan)

1. Snapshot label fix (A1) — smallest, unblocks a working button.
2. Snapshot lifecycle (A2 naming, A3 restore, A4 delete).
3. `ContextMenu.vue` (B) with single-VM/snapshot items.
4. Multi-select + bulk (C), reusing the context menu for bulk items.
5. Shared folders (D): `Shares` + `_run_argv` refactor + endpoints + FoldersTab.

Each phase is independently testable and shippable.

## Open questions

None outstanding — the three product forks were resolved (multi-select model,
snapshot scope, shares posture).
