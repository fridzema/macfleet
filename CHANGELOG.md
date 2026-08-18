# Changelog

All notable changes to macfleet are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

## [0.5.0] - 2026-08-18

The desktop app is now a persistent menu-bar fleet controller, with engine-owned settings
and diagnostics available from a dedicated settings screen.

### Added

- **Native menu-bar control.** The tray menu polls the authenticated engine and exposes VM
  state, lifecycle actions, VNC/SSH connections, IP copying, and a route back into the app.
  Closing the main window now hides it while the fleet remains accessible from the menu bar.
- **Settings and diagnostics.** A new settings route controls the default VM size preset,
  runs the engine's doctor checks, shows engine logs, and provides fleet-only or full data
  reset actions.
- **Engine configuration API.** Engine-owned size presets, atomic persisted configuration,
  doctor diagnostics, data-reset operations, and their authenticated API endpoints keep CLI,
  desktop, and tray behavior aligned.

### Changed

- **Consistent macfleet branding.** The application, tray, browser assets, documentation,
  contributor guidance, security policy, and package metadata now use the macfleet name and
  stacked-windows mark throughout.
- Releases are explicitly source-only on GitHub until the desktop app can be signed and
  notarized; the Python distribution is not published to PyPI.

### Fixed

- Create flows preserve and use the selected size preset instead of silently reverting to a
  different preset.
- Settings remain scrollable on short windows, expose clear navigation back to the fleet,
  reload after a full reset, and report engine-log read failures.

## [0.5.0] - 2026-08-18

Settings, diagnostics, and a real menu-bar app: the engine gained a config
store, doctor checks, and a two-tier data reset, all surfaced in a new settings
page and a native tray menu. macfleet also got its own brand mark and its
first-party project docs.

### Added

- **Settings page.** A `/settings` route with the default VM size (sourced from
  the engine's presets, never a client-side copy), the doctor checks with the
  engine log inline, and a two-tier data reset.
- **Engine settings surface.** A config store with engine-owned size presets
  (`GET`/`PUT /config`), eight doctor diagnostics (`GET /doctor`), and a
  two-tier data reset (`POST /data/reset`, `macfleet reset [--all]`).
- **Menu-bar tray menu.** The Rust host polls the fleet with its own
  authenticated engine client and renders it as a native tray menu: status
  dots, lifecycle actions, VNC/SSH connect, copy IP, and window surfacing.
  Closing the window now hides the app instead of quitting it.
- **Engine log.** The desktop captures its engine sidecar's output to
  `~/.macfleet/engine.log`, rotated on each launch.
- **Brand mark.** An icon master with `make icons`, rebranded bundle icons and
  favicon, a monochrome template tray icon, and a header mark that navigates
  home.
- **L1-L3 hardware release check.** `make verify-hardware` runs the
  above-L0 ladder end to end — clone, boot, SSH, guest exec, snapshot, then MCP
  stdio through create_from_snapshot, exec, screenshot, and delete — refusing
  to touch pre-existing VMs and cleaning up after itself.
- **Project docs.** `LICENSE` (MIT), `CONTRIBUTING.md`, and `SECURITY.md` at
  the repo root, package metadata in `pyproject.toml`, and README sections for
  installing macfleet and for its security model.

### Fixed

- **Presets survive the create form.** Create no longer silently uses the wrong
  preset, keeps the user's pick after a successful create, and labels the
  options from the engine.
- **Settings is reachable and readable.** The page scrolls, offers a way back,
  and reloads after a full reset.
- **Doctor reports `skip`, not `fail`,** when the computer-use gate is off, and
  surfaces engine-log read failures instead of showing an empty state.
- **The tray lists only fleet VMs**, not every VM `tart` knows about.

### Changed

- **Dependency audits narrowed.** `pip-audit` no longer re-resolves a second
  environment on top of uv's pinned export, and the Rust audit ignores an
  advisory for an optional dependency that is not compiled into macfleet.
- **OxideDock scaffold leftovers removed** — brand tokens, devcontainer name,
  env example, updater endpoint, and the stale lockfile package name.

## [0.4.2] - 2026-07-14

A reliability release: engine and desktop hardening around concurrent VM operations
and lease/lifecycle correctness. No new user-facing commands.

### Fixed

- **Concurrent VM operations no longer drop state.** Suspend, resume, rename, down,
  and nuke serialize per VM across the CLI, MCP, and API via file locks plus striped
  in-process locks, so overlapping operations can no longer interleave and silently
  lose a lease or a state update. Lock ordering is by stripe number, so a hash
  collision cannot invert lock order between multi-VM operations.
- **Resume survives a slow un-restorable suspend.** The restore probe is now
  synchronous (a short-lived CLI/API worker could exit before the previous background
  watcher ran) over a longer bounded window, and matches the exact known VZ
  `failed to restore … invalid argument` signature. Only that signature discards the
  saved state and cold-boots; any other launch failure preserves the suspend state
  for a later retry.
- **Lease countdowns survive restarts, sleep, and reap retries.** The desktop rebuilds
  the countdown from the engine's persisted absolute expiry on every fleet frame,
  correcting timer drift after sleep/backgrounding, and announces an expired lease
  only once per expiry — a still-present frame during a reap retry no longer
  re-toasts.
- **Screenshots can't leak across screens.** A `ScreenTab` whose in-flight screenshot
  settles after unmount no longer recreates its poll timer and leaks work into the
  next VM's screen.
- **Engine-startup failures are visible and recoverable.** When the sidecar fails to
  come up, the desktop shows the error with a retry button instead of a silent
  perpetual "Booting…".
- **Command output includes stderr.** `exec` results surface `stderr` alongside
  `stdout`.

### Internal

- Finished the OxideDock → macfleet rebrand and removed the leftover Tauri template
  scaffolding (the `greet`/`get_app_info` commands, the `AppState` visit counter,
  `commands.rs`/`error.rs`, the `ipc.ts` bridge and its test, and `bootstrap.sh`).
  The lib crate is now `macfleet_desktop_lib`.

## [0.4.1] - 2026-07-13

A bug-fix release. Everything here is guest-provisioning or VM-lifecycle robustness.

### Fixed

- **Clicks land where you click.** The in-guest gateway rescales mouse coordinates
  from the screenshot's pixel space to the display's logical points
  (`CGDisplayBounds`). cua clicks via `CGWarpMouseCursorPosition` (logical points)
  while the desktop maps clicks against the larger screenshot and cua applied no
  scaling, so on a HiDPI guest every click landed off.
- **Resume survives an un-restorable suspend.** macOS Virtualization can reject a
  saved suspend state (`VZ Code=12 "failed to restore … invalid argument"`);
  `resume()` now watches the `tart run` and, if the restore fails, discards the state
  and cold-boots instead of silently staying suspended.
- **`scripts/bake.sh` can bake a fresh golden again.** The provision script pins the
  `cs-venv` to Python 3.12 so `cua-computer-server` (which requires ≥3.12) installs on
  a base image whose default `python3` is 3.9.

## [0.4.0] - 2026-07-13

Creating a VM now selects it immediately and shows a live provisioning stepper until
the guest is healthy.

### Added

- **Per-VM provisioning progress.** `Fleet.create()` records the clone/configure/boot/
  health phases, advanced from live tart state plus the guest health check, and the
  desktop renders them as a Clone → Boot → Ready panel before switching to the normal
  detail view.
- **`GET /vms/{name}/provision`** for a just-created VM's progress; `/fleet/events` now
  streams `{vms, provisioning}` instead of a bare VM array.

### Changed

- **Create affordances wait for the engine.** They stay behind a clear "Starting
  engine…" state until the engine's first successful list.
- **`tauri dev` runs the live `uv run` engine** instead of the bundled PyInstaller
  binary, avoiding stale code and 30s readiness-probe failures under macOS Gatekeeper.

### Fixed

- **Version-skew tolerance.** The fleet SSE stream accepts both the legacy bare-array
  frame and the new `{vms, provisioning}` shape, so a version-skewed engine cannot
  freeze the fleet view.

## [0.3.1] - 2026-07-10

A reliability and security hardening pass across the engine and desktop client,
plus freezing the fleet on desktop quit. No new user-facing commands.

### Added

- **Freeze the fleet on quit.** The desktop app suspends every running VM on
  exit (`Fleet.suspend_all`, `MACFLEET_SUSPEND_VMS_ON_EXIT`) so a relaunch
  resumes fast; the quit path bounds uvicorn's graceful shutdown, then SIGKILLs
  the sidecar group so a hung shutdown can't block app exit.
- **Sidecar readiness + diagnostics.** The host probes the engine port for
  readiness and logs spawn failures (previously swallowed), and augments `PATH`
  so a Finder-launched build can still find `uv`.

### Security

- **`macfleet serve` is never unauthenticated.** It now generates a random API
  token when `MACFLEET_API_TOKEN` is unset or empty (a set-but-empty token was
  the same hole), so the loopback API — whose `/exec` runs guest commands —
  always requires a token. The desktop sidecar keeps passing its own.

### Fixed

- **Packaged builds reach the engine.** The CSP `connect-src` now allows the
  sidecar's ephemeral port (`127.0.0.1:*`) instead of a hardcoded `:8765`, which
  only worked in dev.
- **A hung shell-out can't wedge the API.** Every `tart`/`ssh`/`scp` call has a
  timeout; a stuck command no longer permanently consumes a request-thread.
- **`tart exec` output is bounded.** stdout is capped at 16 MiB so a runaway
  command (`cat /dev/zero`) can't OOM the engine.
- **No more lost state updates.** `state.json`, `shares.json`, and
  `activity.jsonl` are file-locked across the request threadpool, the reap loop,
  and separate MCP/CLI processes, so a TTL lease is no longer silently dropped
  (which leaked a VM past its expiry).
- **Polling can't freeze the UI.** Fleet-list, screen, logs, metrics, and status
  reads abort after 10s; the logs and resources tabs guard against overlapping
  and stale responses; the TTL countdown stops re-rendering the whole sidebar
  every second; and a slow fleet refresh can no longer clobber newer state.
- **Clearer connection errors.** `ip()` raises instead of returning an empty
  string, and `ssh()` retries only transient connection failures during the
  guest's boot window. Detached `tart run` children are reaped so zombies don't
  accumulate.

## [0.3.0] - 2026-07-10

Fleet UX: working snapshots with a full lifecycle, a right-click menu and
multi-select for bulk actions, and host↔guest shared folders.

### Added

- **Snapshot lifecycle.** Snapshots are named (a hyphen-free timestamp by
  default), can be **restored in place** (`Fleet.restore`, `POST
  /vms/{name}/restore`, `macfleet restore`), and can be deleted from the sidebar.
  A dedicated `SnapshotDialog` builds the label, so the previously-broken button
  works. Duplicate snapshot ids are rejected with a clear message.
- **Right-click context menu** on fleet and snapshot rows, surfacing the existing
  per-VM actions (start/stop, suspend/resume, snapshot, duplicate, rename,
  connect, delete) — and bulk actions when a multi-selection is right-clicked.
- **Multi-select** with ⌘/⇧-click (plus a selected-row highlight) and a
  **bulk-action panel** shown when 2+ VMs are selected: suspend / resume / stop /
  snapshot-all / delete. Bulk operations fan out with a concurrency cap of 3 to
  avoid a `tart` subprocess storm.
- **Shared folders.** Mount host directories into a guest, read-only by default.
  A new `Shares` store (`~/.macfleet/shares.json`), a single `Fleet._run_argv`
  that threads `--dir=` flags through every VM boot, `GET`/`PUT
  /vms/{name}/shares`, `POST /vms/{name}/restart` (+ `macfleet restart`), and a
  **Folders** tab with the Tauri folder picker. Changes apply on the VM's next
  start.

### Fixed

- The Snapshot button no longer fails with `409 invalid snapshot label` — the UI
  was sending a hyphenated label the engine rejects.

## [0.2.0] - 2026-07-09

Reliability and performance pass on the VM lifecycle — fleet VMs survive the
app quitting, creates are faster, and the status display stops flapping — plus
the `macfleet warm` command and a working computer-use driver.

### Added

- **`macfleet warm`** boots the golden image, waits for its guest server, then
  suspends it, so new VMs resume in ~2s instead of cold-booting macOS for
  ~30-60s (the dominant cost of a create). One-time; the bake checklist now
  ends with this step.
- **Claude computer-use driver.** `AnthropicDriver` (previously a stub) now
  drives the guest via Claude's `computer_20251124` tool, holding the
  conversation across turns and translating each action into the agent
  harness's click/type/done loop.

### Fixed

- **Fleet VMs survive the desktop app quitting.** `tart run` is detached into
  its own session, so the app's shutdown SIGTERM to the engine's process group
  no longer hard-stops every VM and force a cold re-boot on the next launch.
- **Status no longer flaps between running and booting.** The guest IP is
  cached off the health-check hot path, and both the Screen-tab screenshot poll
  and the fleet-list poll skip a tick while a request is still in flight, so a
  slow 2-3MB screenshot can't starve the guest healthcheck.
- **Faster VM creation.** `create` lists VMs once instead of twice and no longer
  runs a full reap first — an unrelated expired VM's slow graceful stop no
  longer blocks the clone.
- **Re-creating a running VM name** no longer fails with a 409; resources are
  applied only to a freshly-cloned (stopped) VM.
- **"Creating" rows can no longer spin forever** — a create whose boot never
  lands clears after a 120s deadline with a warning toast.

## [0.1.1] - 2026-07-09

Security hardening of the local engine API and the golden template, plus fixes to
the desktop screen stream and the documented checks.

### Security

- **Authenticate the local API.** The desktop launches the engine on an ephemeral
  per-run port (never a fixed `:8765` a stale server could own) and mints a per-run
  token, both handed to the webview via a `get_api_config` command. Every request
  now carries an `X-Macfleet-Token` header, required by the engine on all routes
  (`GET /vms` reaps expired VMs), closing a CSRF / unauthenticated-access hole on
  the loopback API.
- **Protect the golden template.** Every mutating and computer-use path
  (nuke/rename/duplicate/suspend/resume/up/down/snapshot/set_resources/exec/ssh/
  computer/metrics) now refuses `mf-golden` across the CLI, API, and MCP server.
- **Validate VM names and snapshot labels** and percent-encode URL path segments,
  so a name containing `/`, `#`, or `?` can't target the wrong route or become
  unmanageable. Labels forbid `-` so hyphenated VM names parse correctly.

### Fixed

- Screen tab no longer paints — or routes clicks to — a stale screenshot after
  switching VMs (a generation guard drops in-flight responses).
- `make test-engine` runs the `mcp` extra so the full suite passes, and the
  documented `cargo clippy -- -D warnings` is green again.

## [0.1.0] - 2026-07-09

First tagged version — a fleet of disposable macOS VMs on one Apple-silicon host,
managed over [`tart`](https://github.com/cirruslabs/tart), with a Python engine
(CLI + local API + MCP) and a Tauri desktop app on the same core.

### Added

- **Engine** (`macfleet` CLI + FastAPI on `:8765`): clone/boot VMs from a golden
  image, SSH and in-guest `exec`, suspend/resume, rename/duplicate, snapshots,
  per-VM resource configuration, TTL leases with lazy reaping, and computer-use
  control (screenshot/click/type) gated behind `MACFLEET_ALLOW_CONTROL=1`.
- **MCP server** (`macfleet-mcp`): full agent loop over the fleet, backed by an
  on-disk agent-activity feed.
- **Desktop app** (Tauri v2 + Vue 3): fleet sidebar, and per-VM Screen, Terminal,
  Logs, Resources, and Connect tabs; command palette; live per-VM metrics; host
  RAM capacity; agent-activity indicator.
- **Booting-aware detail tabs**: Screen/Logs/Connect wait for the guest to finish
  cold-booting instead of hammering an unreachable guest with requests.
- **Root `Makefile`** as the project entry point (`make dev` / `build` / `test` /
  `lint` / `setup`, delegating desktop work to `desktop/Makefile`).

### Known limitations

- New VMs **cold-boot** (~30–60s). Fast resume-from-snapshot is not yet viable:
  resumed clones do not bring up networking on tart 2.32.1, which also affects the
  `snapshot` / `create_from_snapshot` / `duplicate` features.
- The desktop app is **dev-only** — run it with `make dev`. It is not yet bundled,
  code-signed, or notarized.
- Computer-use requires a one-time manual TCC (Accessibility + Screen Recording)
  grant on the golden image; see `scripts/bake.sh`.

[0.5.0]: https://github.com/fridzema/macfleet/releases/tag/v0.5.0
[0.5.0]: https://github.com/fridzema/macfleet/releases/tag/v0.5.0
[0.4.2]: https://github.com/fridzema/macfleet/releases/tag/v0.4.2
[0.4.1]: https://github.com/fridzema/macfleet/releases/tag/v0.4.1
[0.4.0]: https://github.com/fridzema/macfleet/releases/tag/v0.4.0
[0.3.1]: https://github.com/fridzema/macfleet/releases/tag/v0.3.1
[0.3.0]: https://github.com/fridzema/macfleet/releases/tag/v0.3.0
[0.2.0]: https://github.com/fridzema/macfleet/releases/tag/v0.2.0
[0.1.1]: https://github.com/fridzema/macfleet/releases/tag/v0.1.1
[0.1.0]: https://github.com/fridzema/macfleet/releases/tag/v0.1.0
