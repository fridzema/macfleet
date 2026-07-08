# macfleet Phase 2 — gap backends + follow-ups

**Date:** 2026-07-08
**Status:** Approved — ready for implementation planning
**Scope:** The four "gap" backends the interface redesign stubbed, made real, plus five
carried-over follow-up fixes. One cohesive cycle (engine + API + MCP + desktop).

## Goal

Replace the Phase-1 honest stubs with real backends and close the deferred follow-ups:

1. **Agent-activity feed** — the header agents indicator shows real recent AI-agent actions.
2. **Suspended-vs-stopped state** — VMs suspended via the app show as "Suspended", not "running".
3. **Live per-VM metrics** — the Resources tab shows live CPU%/mem-used for the selected VM.
4. **Host Σ running-RAM** — the header capacity chip shows real used/total memory.
5. **Follow-ups** — `set_resources` grow-only guard, CORS tightening, Tauri clipboard,
   remove orphaned `store.up`/`api.up`, LogsTab test.

## Background / current state

- Engine `macfleet/connect.py::Fleet` shells to `tart`, holds a `Leases` store
  (`macfleet/leases.py`) backed by `~/.macfleet/state.json`, and a `GuestControl` for
  computer-use. `list_vms()` returns `[{name, state, source, healthy}]` with parallelized
  per-VM health checks and lazy `reap()`.
- `macfleet/api.py` — FastAPI on `:8765`; app-level `RuntimeError → 409` handler;
  `CORSMiddleware allow_origins=["*"]` (loopback only).
- `macfleet/mcp.py` — in-process stdio MCP server; tool wrappers delegate to `Fleet`.
- Desktop: `useFleet`/`ui` Pinia stores, `AppHeader` (capacity chip + `AgentIndicator`
  empty-state stub), `ResourcesTab` (configured-only bars), `ConnectTab`
  (`navigator.clipboard`).

Grounded facts driving this design:

- `tart list --format json` carries **no** CPU/Memory (only Disk/Size) → per-VM RAM needs
  `tart get`.
- `tart exec <vm> … top -l1` yields `CPU usage: … <idle>% idle` and `PhysMem: <used>M used`
  → live metrics are one exec + parse per VM.
- A **suspended VM still reports `State:"running"`** in `tart list` — tart cannot
  distinguish it, so suspension must be tracked by us.
- The MCP runs as a **separate process** from the API sidecar → an activity feed needs
  shared on-disk storage, not memory.

## Component 1 — Agent-activity feed

- **Store:** `macfleet/activity.py::Activity(path, clock=time.time)` over
  `~/.macfleet/activity.jsonl` — append-only, ring-buffered to the last **200** entries
  (trim on write). Atomic write (temp+rename), corrupt/missing file reads as empty.
  - `record(who: str, action: str, target: str)` appends `{who, action, target, ts}`.
  - `recent(limit: int = 20) -> list[dict]` returns newest-first.
- **Identity ("who"):** the MCP server resolves the agent name once at startup from the
  MCP client handshake `clientInfo.name` (e.g. `"claude-code"`), overridable by env
  `MACFLEET_AGENT`; default `"agent"`.
- **What's recorded:** MCP *action* tools only — `create_vm`, `up`, `down`, `suspend`,
  `resume`, `delete_vm`, `rename_vm`, `duplicate_vm`, `snapshot`, `create_from_snapshot`,
  `delete_snapshot`, `set_resources`, `exec`, and (when control is enabled) `screenshot`,
  `click`, `type_text`, `key`. **Not** read tools (`list_vms`, `list_snapshots`,
  `get_resources`, `get_connection`, `get_metrics`). Each wrapper calls
  `activity.record(who, <human action phrase>, <vm-or-snapshot name>)` after the Fleet op
  succeeds (a failed op is not recorded).
- **API:** `GET /agents/activity?limit=20` → `Fleet.activity_recent(limit)` →
  `[{who, action, target, ts}]` newest-first. `Fleet` holds an `Activity` instance
  (injectable) so the CLI/API can read it; the MCP writes to it.
- **UI:** `AppHeader`/`AgentIndicator` poll `api.agentsActivity()` (~5s). The chip shows the
  count of **distinct agents** seen in the recent entries (matching the mockup's "N AI
  agents"), with a pulse when non-empty; the popover lists the recent entries
  (who · action · target · relative time).
  The honest empty state remains when there is no activity.

## Component 2 — `list_vms` extension: configured-resources cache + suspended marker

- **Configured-resources cache** in `Fleet`: `self._res_cache: dict[str, dict]` mapping
  full VM name → `{cpu, memory_mb, disk_gb}` (from `tart get`). Lazily populated: in
  `list_vms()`'s existing parallel pass, for each VM **not** in the cache, run `tart get`
  (parallel with the health check) and cache it; cache hits cost nothing. `list_vms()`
  returns `{name, state, source, healthy, memory_mb, cpu, disk_gb}` (new fields from the
  cache; absent-cache VMs get the just-fetched values). Invalidate a VM's entry on
  `set_resources`, `create` (fresh clone), `rename` (move key), and `nuke` (drop).
  Result: steady-state `/vms` stays ~0.05s (cache hits); the first sight of a VM pays one
  `tart get`, parallelized.
- **Accepted staleness:** `_res_cache` is process-local. The API sidecar and the MCP/CLI
  run as separate processes with separate caches, so a resize done out-of-process (via
  the MCP or the `macfleet` CLI) invalidates only that process's cache — the API's `/vms`
  `cpu`/`memory_mb`/`disk_gb` fields (and the desktop header Σ-RAM chip / list rows) can
  keep showing the pre-resize value until the API process restarts. The authoritative
  per-VM Resources detail (`api.resources` → `Fleet.resources`) is uncached and always
  fresh, and the sidecar restarts on every desktop launch, so the staleness self-heals. A
  future TTL or periodic cache-clear could tighten this window if it becomes an issue.
- **Suspended marker:** track a suspended set in `~/.macfleet/state.json` under a new
  `"suspended": [<full names>]` key, via a small helper alongside `Leases` (same file,
  same atomic-write discipline). `Fleet.suspend(name)` adds the full name; `resume`,
  `down`, `nuke` remove it.
  `list_vms()` merges: a VM whose full name is in the suspended set **and** whose tart
  state is `"running"` is reported as `state: "suspended"`. (A VM that tart reports
  `stopped` is stopped regardless — the marker is only meaningful over a
  tart-"running" VM.)
- **Desktop:** the `Vm` type gains optional `memory_mb`/`cpu`/`disk_gb`; the AppHeader
  capacity chip computes `Σ(running memory_mb) / host.total_mem_gb`. The sidebar/detail may
  read the list-provided resources (the detail already fetches `resources()` separately —
  leave that; the list fields feed the header). `vmStatus()` already maps `state:"suspended"`
  to the violet styling.

## Component 3 — Live per-VM metrics

- **Engine:** `Fleet.metrics(name) -> {cpu_pct: float, mem_used_mb: int, mem_total_mb: int}`.
  Runs `tart exec <full> /bin/sh -lc "top -l1 -n0 | grep -E 'CPU usage|PhysMem'"` via the
  non-checking runner, parses: `cpu_pct = round(100 - <idle>, 1)`; `mem_used_mb` from
  `PhysMem: <n>M used`. `mem_total_mb` from the configured-resources cache (Component 2).
  A non-reachable guest (exec fails / unparseable) raises `RuntimeError` → 409.
- **API:** `GET /vms/{name}/metrics` → the dict.
- **UI (`ResourcesTab`):** when the selected VM's state is `running`, poll
  `api.metrics(name)` every ~3s and render the CPU + Memory bars from **live** values with
  `"<cpu_pct>% load"` / `"<used> / <total> GB used"` captions (per comp lines 361/367).
  Disk stays configured (bar from configured, caption from resources). When the VM is
  booting/suspended/stopped, or a metrics fetch fails, fall back to the configured bars
  (no fabricated live numbers). Poll only the selected VM — never a fleet-wide sweep.

## Component 4 — Follow-ups

1. **`set_resources` grow-only guard** (`connect.py`): before `tart set`, if `disk_size`
   is given, read the current disk (`get_config`) and drop it from the set when it does not
   exceed current — never attempt a shrink (which tart rejects). Mirrors the `create` guard.
   Also invalidate the res-cache entry after a successful set. Test with a fake run that
   errors on shrink.
2. **CORS tighten** (`api.py`): replace `allow_origins=["*"]` with the explicit Tauri
   origins — `http://localhost:1420` (dev), `tauri://localhost`, `https://tauri.localhost`
   (packaged webview). Keep `allow_methods`/`allow_headers` as needed. Verify the desktop
   dev server (`:1420`) still reaches the API; add a test asserting an allowed origin gets
   the ACAO header and a disallowed one does not.
3. **Tauri clipboard** (`ConnectTab.vue`): copy via `@tauri-apps/plugin-clipboard-manager`'s
   `writeText` when running in Tauri (feature-detect `window.__TAURI__`/import guard),
   falling back to `navigator.clipboard.writeText` in the browser/e2e. Keep the
   success-only confirmation + `.catch`. Ensure the Rust side has the clipboard-manager
   plugin permission (`capabilities`), which it already depends on.
4. **Remove orphaned `store.up`/`api.up`** (desktop): the sidebar uses `store.create`.
   Drop `store.up` and `api.up` and their now-dead tests; keep the engine `POST /vms/{n}/up`
   route + CLI `up` (back-compat). Grep to confirm no remaining `src/` callers.
5. **LogsTab test** (`LogsTab.vue`/test): replace the `/* istanbul ignore */` on
   `scrollToBottom`'s post-unmount guard with a real test that triggers the `flush:'post'`
   watcher and unmounts before it runs, asserting no throw. Remove the ignore.

## Testing

**L0 (offline, CI gate):**
- *Engine:* `Activity` store (record/recent/ring-trim/corrupt-file, injected clock);
  `metrics()` parse from canned `top` output (fake runner); `list_vms` cache behavior
  (one `tart get` per new VM, cache hit = no `tart get`, invalidation on set/rename/nuke)
  and suspended-merge; `set_resources` grow-only (fake run errors on shrink).
- *API:* new routes via `TestClient` + extended `FakeFleet` (`activity_recent`, `metrics`,
  `list_vms` extra fields); CORS allowed/denied origin test.
- *MCP:* action tools call `activity.record` with the right (who, action, target); read
  tools do not; `who` resolves from clientInfo/env/default.
- *Desktop:* AgentIndicator renders live activity + count from a mocked feed; ResourcesTab
  live bars from mocked metrics + fallback when not running; header Σ-RAM from mocked
  list; ConnectTab Tauri-vs-browser clipboard path; store `up`/`api.up` removed cleanly.
  e2e adds `/agents/activity` + `/metrics` route mocks.

**L1 (real hardware, manual):** agent feed populated by a real `claude mcp` session (create
+ snapshot + exec show up with the agent name); live CPU/mem bars on a running VM; suspend
a VM → shows Suspended (violet) → resume → running; capacity chip shows real Σ used/total;
copy works in the packaged app; CORS still lets the desktop through.

## Open validation items

1. `top -l1 -n0` output format is stable enough to parse `CPU usage`/`PhysMem` across macOS
   versions — validate on L1; fall back to `vm_stat`/`sysctl` if the format differs.
2. The Tauri webview origin in the packaged app is `tauri://localhost` (macOS) — confirm at
   L1 and adjust the CORS allowlist if the real origin differs.
