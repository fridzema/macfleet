# macfleet — VM management primitives + MCP server

**Date:** 2026-07-07
**Status:** Approved — ready for implementation planning
**Resolved decisions:** snapshot naming `mfsnap-<vm>-<label>` (opaque id authoritative);
`mcp` ships as an optional `[mcp]` extra (`uv run --extra mcp macfleet-mcp`); `up` is
kept and delegates to `create` (no deprecation).
**Scope:** One spec covering (1) VM-management primitives in the engine + HTTP API and
(2) an MCP server exposing them, so both humans and AI agents can quickly spin up,
snapshot, and drive throwaway macOS test VMs. Desktop UI for these features is a
**separate, later** spec.

## Goal

Take macfleet "to the next level": make it fast and ergonomic to spin up disposable
macOS test VMs for humans and AI agents. Concretely, add:

- **Stateful snapshots** — capture a running VM's state; spinning up from a snapshot
  resumes to that exact state in ~1-2s (no cold boot).
- **Lifecycle primitives** — suspend/resume, rename, duplicate, resource config.
- **Connection info & shell** — per-VM "how to connect" bundle and in-guest command
  execution (no SSH-key setup, via the Tart Guest Agent).
- **TTL leases** — agent-created VMs can auto-expire so nothing leaks.
- **MCP server** — the full provision-and-drive agent loop over stdio, in-process.

Non-goals for this spec: desktop UI surface, a pre-warmed VM pool, VNC/terminal UI,
WebSocket screenshot streaming. Those are follow-up specs.

## Background / constraints

The VM layer is `tart`. Confirmed capabilities on the target host:

- `tart clone` — copy-on-write clone (instant, cheap). Basis for snapshot + duplicate.
- `tart suspend <name>` — writes running state to disk. A cloned suspended VM, when
  run, **resumes** to the captured state.
- `tart rename`, `tart set` (`--cpu --memory --disk-size --display`; disk grow-only),
  `tart get`, `tart exec` (needs the Tart Guest Agent — present on Cirrus Labs base
  images, which `mf-golden` derives from), `tart run --vnc`.

Existing architecture (unchanged by this spec except where noted):

- `macfleet/connect.py::Fleet` — engine; shells to `tart` + SSH + the guest
  `cua-computer-server` on `:8000` (computer-use via `GuestControl` over `/cmd`).
- `macfleet/api.py` — FastAPI on `:8765`; app-level `RuntimeError → 409` handler that
  preserves CORS headers.
- `macfleet/cli.py` — Typer CLI. `macfleet/vm.py` — `Tart` wrapper, `fullname`/
  `shortname` helpers, `_run` (raises `RuntimeError` on nonzero exit).
- Desktop app consumes the HTTP API; filters the fleet to `mf-`-prefixed, non-golden.

## Architecture — shared core, thin adapters

All new logic lives in `Fleet`. The HTTP API and the MCP server are thin adapters over
`Fleet`. The MCP imports `macfleet` and calls `Fleet` **in-process** (no HTTP hop), so
it works headless without `macfleet serve` running.

```
                 ┌───────────────┐
   desktop  ───► │  HTTP API      │ ─┐
   / CLI         │  (api.py)      │  │
                 └───────────────┘  │      ┌──────────────────┐   ┌──────┐
                                    ├────► │  Fleet (engine)  │──►│ tart │
                 ┌───────────────┐  │      │  + Leases store  │   └──────┘
   AI agent ───► │  MCP server    │ ─┘      └──────────────────┘        │
                 │  (mcp.py,stdio)│                    │                 ▼
                 └───────────────┘                     ▼          guest :8000
                                          ~/.macfleet/state.json  (computer-use)
```

Naming conventions:

- Fleet VMs: `mf-<name>` (existing).
- Snapshots: `mfsnap-<vm>-<label>` — does **not** start with `mf-`, so the desktop's
  `mf-` fleet filter and `list_vms` fleet view naturally exclude them.
- Golden template: `mf-golden` (existing), already excluded from the fleet view.

## Component 1 — Engine primitives (`Fleet`)

All methods take short names; `fullname(n)` → `mf-<n>`. Each is one or two `tart`
calls; all failures surface as `RuntimeError` (via `_run`).

**Lifecycle**

- `suspend(name)` → `tart suspend mf-<name>`.
- `resume(name)` → background `tart run mf-<name> --no-graphics` (auto-resumes a
  suspended VM). Same spawn path as `up`'s run step, minus the clone.
- `create(name, from_snapshot=None, ttl=None)` — generalizes `up`. Clones
  `mfsnap-<from_snapshot>` if given, else `mf-golden`, into `mf-<name>`, then runs it.
  Records a lease when `ttl` is set. Existing `up/down/nuke` remain (up delegates to
  `create`).

**Snapshots (stateful)**

- `snapshot(name, label) -> str` — if the VM is running, `suspend` it; then
  `tart clone mf-<name> mfsnap-<name>-<label>`; then `resume` if it had been running.
  Returns snapshot id `<name>-<label>`.
  - *Fallback:* if `tart suspend` fails, `stop` instead of `suspend` (clean-disk
    snapshot), log a warning. Same fallback for `duplicate`.
- `snapshots() -> list[dict]` — `tart list` filtered to `mfsnap-`, parsed to
  `{id, vm, label, size}`. The `id` (`<vm>-<label>`, the part after `mfsnap-`) is the
  **authoritative opaque key** used by `delete_snapshot`/`create(from_snapshot=…)`;
  `vm`/`label` are best-effort display fields (split on the first `-`) and are not used
  for lookups, so hyphens in names/labels don't break anything.
- `delete_snapshot(id)` → `tart delete mfsnap-<id>`.
- Restore == provision a new VM from a snapshot via `create(from_snapshot=...)`; the
  clone **resumes** to the captured state.

**Identity / resources / access**

- `rename(old, new)` → `tart rename mf-<old> mf-<new>`; moves the lease key.
- `duplicate(name, new)` → suspend-if-running → `tart clone mf-<name> mf-<new>` →
  resume both (stateful copy; clean-disk fallback as above).
- `resources(name) -> dict` — parse `tart get mf-<name>` → `{cpu, memory_mb, disk_gb,
  display, state}`.
- `set_resources(name, cpu=None, memory=None, disk_size=None, display=None)` →
  `tart set ...`. **Requires the VM stopped** (raises `RuntimeError` otherwise, mapped
  to 409). Disk is grow-only. Changing resources discards suspended state (next run
  cold-boots) — documented, not surprising.
- `exec(name, command) -> dict` → `tart exec mf-<name> <command>` → `{stdout,
  exit_code}`. In-guest shell without SSH keys.
- `connection_info(name) -> dict` → `{ip, ssh: "ssh admin@<ip>",
  vnc: "open vnc://admin@<ip>", guest_server: "http://<ip>:8000", exec: true}`.

## Component 2 — Leases / TTL + lazy reaping

- **Store:** `~/.macfleet/state.json` →
  `{"leases": {"mf-<name>": {"expires_at": <unix>, "created_at": <unix>,
  "source": "api"|"mcp"|"cli"}}}`. Atomic write (write-temp-then-rename) guarded by a
  file lock (`fcntl.flock`); a corrupt/missing file is treated as empty (log + continue).
- **Record:** `create(ttl=<seconds>)` writes `expires_at = now + ttl`.
- **Reap:** `reap() -> list[str]` deletes each VM whose `expires_at < now` (if it still
  exists) and drops the lease entry. Idempotent — reaping an already-deleted VM is a
  no-op.
- **Lazy sweep:** `list_vms()` calls `reap()` first (reusing its own `tart list` fetch, so
  the sweep costs no extra shell-out), so abandoned agent VMs are swept regardless of
  which adapter is used, with no daemon. `macfleet serve` additionally runs `reap()` on an
  interval (asyncio background task, `to_thread`-dispatched so it can't block the event
  loop) as a backstop. `reap()` is also exposed directly via `POST /reap` and
  `macfleet reap`, for an explicit sweep on demand.
- `nuke`/`delete` clears the VM's lease; `rename` moves it.

Time is injected (`clock=time.time`) so the store is unit-testable without real time.

## Component 3 — HTTP API surface (additive)

All wrapped by the existing `RuntimeError → 409` handler. The desktop app is unaffected.

| Method + path | Body | Returns |
|---|---|---|
| `POST /vms` | `{name, from_snapshot?, ttl?}` | create/clone + run |
| `POST /vms/{name}/suspend` | — | `{ok: true}` |
| `POST /vms/{name}/resume` | — | `{ok: true}` |
| `POST /vms/{name}/snapshot` | `{label}` | `{snapshot_id}` |
| `GET /snapshots` | — | `[{id, vm, label, size}]` |
| `DELETE /snapshots/{id}` | — | `{ok: true}` |
| `POST /vms/{name}/rename` | `{new}` | `{ok: true}` |
| `POST /vms/{name}/duplicate` | `{new}` | `{ok: true}` |
| `GET /vms/{name}/resources` | — | `{cpu, memory_mb, disk_gb, display, state}` |
| `PUT /vms/{name}/resources` | `{cpu?, memory?, disk_size?, display?}` | `{ok}` / 409 if running |
| `GET /vms/{name}/connection` | — | `{ip, ssh, vnc, guest_server, exec}` |
| `POST /vms/{name}/exec` | `{command}` | `{stdout, exit_code}` |
| `POST /reap` | — | `{reaped: [name, ...]}` |

`POST /vms/{name}/up` is kept for back-compat (delegates to `create`).

## Component 4 — MCP server (`macfleet/mcp.py`)

- **Transport:** stdio (MCP Python SDK / FastMCP). Entry point `macfleet-mcp`.
  Instantiates `Fleet` in-process — no HTTP dependency, works headless.
- **Tools** (one per operation, mirroring `Fleet`):
  - *Manage:* `list_vms`, `create_vm(name, from_snapshot?, ttl_seconds?)`, `up`, `down`,
    `suspend`, `resume`, `delete_vm`, `rename_vm`, `duplicate_vm`, `get_resources`,
    `set_resources`.
  - *Snapshots:* `snapshot(name, label)`, `list_snapshots`,
    `create_from_snapshot(snapshot_id, name, ttl?)`, `delete_snapshot`.
  - *Access / drive:* `get_connection(name)`, `exec(name, command)`,
    `screenshot(name)` (returns an MCP **image** so the agent can see the desktop),
    `click(name, x, y)`, `type_text(name, text)`, `key(name, combo)`.
- **Safety:** `screenshot/click/type/key` gated behind `MACFLEET_ALLOW_CONTROL=1`
  (same as the engine). Each tool's description states it targets fleet VMs only over
  the guest IP, never the host. `delete_vm`/`delete_snapshot` execute directly (agents
  rely on them + TTL); documented plainly, no interactive dialog.
- **Errors:** `RuntimeError` from tart/guest → returned as a tool error carrying the
  tart message.
- **Packaging:** new optional extra `mcp = ["mcp>=1.0"]`; `[project.scripts]
  macfleet-mcp = "macfleet.mcp:main"`. Registration documented in the README:
  `claude mcp add macfleet -- uv run --extra mcp macfleet-mcp`.

## Testing

**L0 — offline, automated (CI gate, `make test`):**

- *Engine:* each new `Fleet` method with an injected fake runner asserts the exact
  `tart` argv and naming; `snapshot()` on a running VM asserts suspend → clone → resume
  ordering; suspend-failure asserts the stop+clone fallback.
- *Leases:* record / expire / sweep / idempotent double-reap / rename-moves-key, with an
  injected clock and a temp state path. No real time or disk.
- *API:* new endpoints via `TestClient` + extended `FakeFleet`; assert wiring and the
  409-on-running-`set_resources` path.
- *MCP:* import the tool callables with a fake `Fleet` injected; assert each tool calls
  the right `Fleet` method and maps errors. No live stdio.

**L1–L3 — manual, real Apple-silicon (README ladder):**

- **Validate the stateful-snapshot assumption first** (L2): snapshot a running VM →
  `create_from_snapshot` → confirm it resumes to the captured state. If it fails, switch
  `snapshot`/`duplicate` to stop-instead-of-suspend; tests assert argv, so it's a
  localized change.
- suspend/resume roundtrip; `exec` returns stdout; rename; duplicate; a TTL lease
  actually reaps; MCP end-to-end via `claude mcp add` (list → create_from_snapshot →
  exec → screenshot → delete).

## Error handling & safety (summary)

- All tart/guest failures → `RuntimeError` → 409 (existing handler); MCP → tool error.
- `set_resources` on a running VM → clean 409 ("stop the VM first").
- Suspend fallback to clean-disk keeps snapshot/duplicate working on images that can't
  suspend.
- Destructive ops execute directly (disposable VMs + TTL); documented, no dialog.
- Lease file corruption → empty + log; atomic write + file lock for concurrent writers.
- Computer-use gated by `MACFLEET_ALLOW_CONTROL=1` across engine, API, and MCP.

## Open validation items (resolve early in implementation)

1. Cloning a **suspended** VM and running the clone resumes to the captured state
   (the stateful-snapshot premise). Fallback: clean-disk snapshots.
2. `tart rename` / `tart set` preconditions (VM must be stopped?) — confirm and encode
   as clear 409s.
3. `tart exec` returns exit codes reliably through `_run`.
