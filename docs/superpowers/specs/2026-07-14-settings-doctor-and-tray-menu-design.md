# Settings, Doctor, and the menu bar tray menu

Status: approved design (2026-07-14) — ready for an implementation plan.

## Summary

Two user-facing additions, plus the engine surface they both need:

1. **A Settings page** (`/settings`) with three sections — General (default VM
   size), Data (two-tier reset), Doctor (system checks + logs).
2. **A macOS menu bar menu** listing the fleet, with per-VM quick actions
   (connect VNC/SSH, copy IP, restart, suspend/resume, stop, delete).

Confirmed product decisions: the tray menu is a **native** macOS menu (not a
webview popover), driven by fleet state the frontend pushes to Rust; settings
live in an **engine config file** so the CLI, MCP server, and desktop share one
default; Delete is available from the tray behind a native confirm dialog;
"Remove all data" has two tiers with `mf-golden` protected by default; closing
the window **hides** it rather than quitting.

## Goals

- One place to set the default VM size that the CLI and desktop both honour.
- Diagnose a broken install (and a non-starting engine) without a terminal.
- Reset macfleet's data without hand-deleting `tart` VMs.
- Reach the fleet and its common actions from the menu bar with the window closed.

## Non-goals (YAGNI)

- A user-editable preset table. The three presets stay engine-owned constants;
  only *which one is default* is configurable.
- A default disk size. `tart set --disk-size` is grow-only (`connect.py:526`),
  which is why presets omit disk today; a default that silently cannot shrink
  below golden's ~80GB is a footgun.
- A webview tray popover with rich status (RAM bars, TTL countdown). Native menu
  only.
- A full in-app log viewer with filtering/follow. Doctor shows a tail.
- Rust-side engine polling or an HTTP client in Rust. The webview stays the only
  engine client.
- A settings *window* (macOS convention). This app is single-window + router; a
  route is idiomatic here.

## Current state (grounding)

- **Engine** (`macfleet/`): `Fleet` in `connect.py` shells out to `tart`; `api.py`
  (FastAPI), `cli.py` (Typer), `mcp.py` (MCP). `leases.py` / `shares.py` /
  `activity.py` are small flock-guarded JSON stores under `~/.macfleet/`, via
  `_lock.py`.
- **Desktop** (`desktop/`): Tauri 2 + Vue 3 + Pinia + Tailwind 4 (CSS-var design
  system in `src/style.css`). `shared/api.ts` is the HTTP client; the engine runs
  as a sidecar on an ephemeral loopback port with a per-run token, handed to the
  webview by the single `get_api_config` Tauri command.
- **There is no settings system.** No config file, no `tauri-plugin-store`. The
  only persisted preference in the whole app is the theme, implicitly, via
  VueUse's `useDark` localStorage default.
- **Size presets are frontend-only** (`desktop/src/stores/fleet.ts:47`), so
  `macfleet up foo` from the CLI and a desktop create produce different VMs.
- **There is no doctor.** A preflight list was specced and never built —
  `docs/superpowers/specs/2026-07-03-macfleet-design.md:125`.
- **The engine's log is never captured.** The sidecar inherits stdio; output goes
  nowhere. Tauri host logs land in `~/Library/Logs/com.macfleet.desktop/`; guest
  logs are already tailed by `LogsTab.vue`.
- **A tray already exists** (`src-tauri/src/lib.rs`, ~line 180) with two items:
  Show and Quit. `tauri` carries the `tray-icon` feature.
- `restart` is already plumbed end to end (`api.py:227` → `api.ts:288` →
  `fleet.ts:188`) — "reboot" needs no engine work.
- VM names match `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` (`vm.py:99`) — no colons.
- State is `running | stopped` plus a `healthy` flag (`booting`). Suspended is not
  a state: the engine tracks it in a side set and `resume()` transparently
  restores-or-cold-boots (`connect.py:279`).

## Design

### 1. Engine config — `macfleet/config.py`

A new module mirroring `leases.py` / `shares.py`: flock-guarded JSON at
`~/.macfleet/config.json`.

```python
PRESETS = {"light": {"cpu": 2, "memory_gb": 4},
           "standard": {"cpu": 4, "memory_gb": 8},
           "heavy": {"cpu": 8, "memory_gb": 16}}
DEFAULT_PRESET = "standard"
# ~/.macfleet/config.json → {"default_preset": "standard"}
```

The preset table becomes engine-owned truth.

- `GET /config` → `{default_preset, presets}`
- `PUT /config` — accepts only `default_preset`, validated against `PRESETS` keys.
- CLI: `macfleet up <name> [--preset light|standard|heavy]`, resolving to
  cpu/memory, defaulting to the config's `default_preset`.

A missing or corrupt `config.json` reads as defaults rather than raising — a bad
config file must not make the app unstartable.

**Frontend:** the `PRESETS` const at `fleet.ts:47` is deleted and sourced from
`GET /config`, fetched on the existing `loaded` boot path so preset buttons never
render against a stale table.

### 2. Doctor — `macfleet/doctor.py`

`run_checks(fleet) -> list[Check]` where
`Check = {id, label, status: ok|warn|fail|skip, detail, fix?}`. Exposed as
`GET /doctor`, run on demand.

| Check | Condition | Fix offered |
|---|---|---|
| `arch` | fail if not arm64 | none — hard stop |
| `tart` | fail if not on PATH | install tart |
| `golden` | fail if `mf-golden` absent | `macfleet bake` |
| `golden_warm` | warn if golden not suspended | `macfleet warm` |
| `tcc_screenshot` | fail if screenshot fails on a running VM; `skip` if none running | re-bake golden |
| `orphans` | warn on leaked `mfbackup-*` / `mftmp-*` | Remove all data |
| `stale_leases` | warn on leases for VMs tart no longer has | auto-prune |
| `disk` | warn on low free space on the tart volume | none |

Checks derive from the unimplemented preflight list
(`2026-07-03-macfleet-design.md:125`) plus traps the code implies: `restore`
deliberately leaves `mfbackup-*` behind rather than delete user data
(`connect.py:1014`), and TCC/screenshot failure is the documented golden-image
trap.

Each check gets a **short per-call timeout**. `vm.py`'s 300s subprocess budget
would let one hung `tart` freeze the whole page.

### 3. Reset — `POST /data/reset`

Two scopes:

- **`fleet`** — all `mf-*` except golden, all `mfsnap-*`, plus leaked
  `mfbackup-*` / `mftmp-*`.
- **`all`** — additionally `mf-golden`, and `config.json` resets to defaults.

Deletion is a **whitelist, not `rm -rf ~/.macfleet`**: it removes `state.json`,
`shares.json`, `activity.jsonl`, and `operations/` by name. Blanket removal would
delete `engine.log` out from under the running process (§4) and silently take
`config.json` with it.

Only the `mf-` / `mfsnap-` / `mfbackup-` / `mftmp-` prefixes are ever touched —
other VMs in `~/.tart/` are not ours. `scope=all` is the single path that
deliberately bypasses `ensure_mutable`'s golden guard (`vm.py:103`). Per-VM
deletes reuse the existing `_locked_vms` lock and run sequentially. Returns the
deleted VMs and removed paths so the UI reports what actually went.

Gated by `MACFLEET_ALLOW_CONTROL`, like the other control operations.

CLI: `macfleet reset [--all]` with a confirmation prompt.

### 4. Engine log capture

`lib.rs` currently lets the sidecar inherit stdio, so engine output is lost —
including the readiness-probe failure that explains a non-starting app. Redirect
the spawn's stdout+stderr into `~/.macfleet/engine.log`, rotating
`engine.log → engine.log.1` at startup. Truncate-per-run bounds size without a
reader thread or rotation logic; the engine logs little.

**The tail is read frontend-side via `tauri-plugin-fs`, not through the engine
API.** When the engine is dead is exactly when the log is needed, so routing it
through the engine's own HTTP would fail precisely when it matters. Requires a
capability addition: read-only scope for `$HOME/.macfleet/engine.log*` (today
`fs:allow-read-text-file` is scoped to `$APPDATA` / `$APPCONFIG` / `$RESOURCE`).

Consequence, and intended: Doctor degrades gracefully — the checks need the
engine, the log tail never does.

### 5. Settings page

`desktop/src/pages/SettingsPage.vue` at `/settings`, three sections:

- **General** — preset radio cards rendered from the engine's presets →
  `PUT /config` on change, toast on success.
- **Data** — the two reset tiers, each behind a `tauri-plugin-dialog` confirm
  naming the exact consequence (tier 2 states that golden needs a re-bake).
- **Doctor** — run-checks button; status list using the existing
  `--emerald` / `--amber` / `--red` / `--idle` vars; engine log tail; reveal
  buttons for `~/.macfleet` and `~/Library/Logs/com.macfleet.desktop/`.

New `stores/settings.ts` (config, presets, checks, in-flight flags). New `api.ts`
methods: `config`, `setConfig`, `doctor`, `resetData`. `⌘,` joins `useHotkeys`.

`tests/unit/router.test.ts` asserts `routes` has length 3 and index-addresses
them — it must be updated, and the new route added before the `:pathMatch`
catch-all.

### 6. Tray menu

New `src-tauri/src/tray.rs`. The existing builder gains `.with_id("main")` so the
icon is reachable via `tray_by_id`.

Top level:

```
● dev            ▸
◐ build          ▸
○ scratch        ▸
──────────────────
New VM
Suspend all
──────────────────
Settings…
Doctor…
──────────────────
Show macfleet
Quit
```

Per-VM submenu, running (`●` / `◐`):

```
Connect VNC
Connect SSH
Copy IP address
──────────────────
Restart
Suspend
Stop
──────────────────
Show in app
Delete…
```

Per-VM submenu, stopped (`○`):

```
Resume
──────────────────
Show in app
Delete…
```

Dots: `●` running (healthy), `◐` booting, `○` stopped.

- `#[tauri::command] set_tray_vms(vms: Vec<TrayVm>)` rebuilds the menu and calls
  `set_menu`. `TrayVm` is `{name, status}` **only** — IP is fetched lazily on
  click via `api.connection(name)`, so a refresh does not cost one HTTP call per
  VM.
- Menu IDs encode `vm:<name>:<action>`; unambiguous because names cannot contain
  colons. Globals: `new`, `suspend-all`, `settings`, `doctor`, `show`, `quit`.
- Global actions resolve as: `new` → show window + `fleet.create()` with the
  configured default preset (same path as the palette's "Spin up new VM");
  `suspend-all` → the existing suspend-all endpoint, no confirm (recoverable);
  `settings` → show window + `router.push('/settings')`; `doctor` → the same,
  scrolled to the Doctor section and auto-running the checks.
- `show` on a per-VM submenu shows the window and selects that VM via
  `ui.selectVm`.
- Rust handles `show` / `quit` itself. Everything else emits
  `tray-action {action, vm}` to a new `composables/useTrayMenu.ts`, which
  dispatches through the existing store and `api.ts`.
- VMs are sorted by name so the menu does not jump between rebuilds.
- **Rebuild only when the projected `{name,status}` set actually changes**, not on
  every 2s SSE frame. Rebuilding a native menu on a timer can flicker or dismiss
  an open menu.
- Delete is guarded by a `tauri-plugin-dialog` confirm (the app's two-step arm
  pattern cannot be expressed in a native menu). Stop/Suspend/Restart are
  recoverable and fire immediately.
- Connect VNC / SSH open `vnc://admin@<ip>` / `ssh://admin@<ip>` through
  `tauri-plugin-opener` — macOS routes both natively. `opener:default`'s URL scope
  likely permits only http/https, so both schemes need an explicit scope entry.
- Connect/Copy IP items are disabled for non-running VMs.

### 7. Close → hide

`lib.rs` gains `on_window_event`: `CloseRequested` → `prevent_close()` +
`window.hide()`. Quit via the tray calls `app.exit(0)`, so the existing
`RunEvent::Exit` teardown (process-group SIGTERM, `MACFLEET_SUSPEND_VMS_ON_EXIT`)
still runs.

Required by the tray design: the frontend-push menu needs the webview alive to
render fleet state and dispatch actions.

Behaviour change: closing the window no longer suspends VMs — they run until an
actual Quit. That is standard menu bar app semantics.

**Open question for the plan to verify:** with no app menu bar set (`.menu()` is
never called on the Builder — the app is tray-only), `⌘Q` may not be wired on
macOS. Verify before relying on it; if unwired, add a minimal app menu.

## Data flow

```
SSE /fleet/events ──> stores/fleet.ts ──> project {name,status} ──> changed?
                                                                      │ yes
                                              invoke set_tray_vms  <──┘
                                                      │
                                              tray.rs rebuilds native menu
                                                      │
                                    user clicks ──> on_menu_event
                                                      │
                              show/quit ──> Rust      └──> emit tray-action
                                                              │
                                              useTrayMenu.ts ─┴─> fleet store / api.ts / router
```

The tray projection is a pure function (`vms -> TrayVm[]`) plus a change guard.
That is where the logic lives, and it is unit-testable without a native menu.

## Error handling

- Missing/corrupt `config.json` → defaults, no raise.
- `PUT /config` with an unknown preset → 4xx, validated against `PRESETS`.
- Doctor: each check is independently timed and caught; one failure renders as a
  `fail` row rather than failing the request.
- Doctor with the engine down → checks show unavailable, log tail still renders.
- Reset: partial failure returns what was deleted; a VM that refuses to stop is
  reported, not silently skipped.
- Tray action on a VM that vanished between rebuild and click → toast, refresh.
- `api.connection()` failure on a VNC/SSH/Copy click (VM has no IP yet) → toast,
  no URL opened.

## Testing

- **pytest**: `config.py` (read/write/validate/lock, corrupt-file fallback);
  `doctor.py` against a fake `Tart` for each status; reset path-whitelist,
  prefix-scoping, and golden protection per scope. New endpoints in `api.py`.
- **vitest**: `stores/settings.ts`; the tray projection + change guard (pure);
  updated `router.test.ts`.
- **Playwright**: the Settings page. The mock matches by path, so `/config`,
  `/doctor`, and `/data/reset` need mock entries.
- The native tray is not e2e-testable — hence the pure projection function.

## Plan decomposition

This spec is deliberately combined but too large for one plan. It splits into
three, in dependency order — following the precedent of
`2026-07-09-fleet-ux-snapshots-and-shared-folders-design.md`, which became three
plans:

1. **Engine surface** — `config.py`, `doctor.py`, reset, the three endpoints, CLI
   wiring (`up --preset`, `reset`), engine log capture in `lib.rs`. Ships
   independently and is usable from the CLI alone.
2. **Settings page** — `/settings`, `stores/settings.ts`, the `api.ts` methods,
   `⌘,`, the fs capability entry, router test update. Depends on plan 1.
3. **Tray menu + close→hide** — `tray.rs`, `set_tray_vms`, `useTrayMenu.ts`, the
   opener scope entries, `CloseRequested`. Depends on plan 2 for the Settings and
   Doctor deep-links.

## Rollout notes

Existing installs have no `config.json`; it is created on first write and reads as
defaults until then. No migration. The tray gains items but the existing
Show/Quit ids are unchanged.
