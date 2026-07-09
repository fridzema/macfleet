# Changelog

All notable changes to macfleet are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

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

[0.1.0]: https://github.com/fridzema/macfleet/releases/tag/v0.1.0
