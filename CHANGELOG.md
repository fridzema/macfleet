# Changelog

All notable changes to macfleet are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

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

[0.1.1]: https://github.com/fridzema/macfleet/releases/tag/v0.1.1
[0.1.0]: https://github.com/fridzema/macfleet/releases/tag/v0.1.0
