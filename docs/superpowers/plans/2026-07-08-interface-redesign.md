# macfleet interface redesign — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Rebuild the macfleet desktop UI to match the approved design comp
(`docs/design/macfleet.dc.html`, rendered `docs/design/.thumbnail`) — a header + sidebar
(Fleet + Snapshots + advanced Create) + 5-tab VM detail (Screen / Terminal / Logs /
Resources / Connect) + command palette + toasts — wired to the engine APIs we already
ship, with the four no-backend features stubbed/derived.

**Design source of truth:** `docs/design/macfleet.dc.html`. It is a complete, working
reference (tokens, layout, states, copy, behaviors). Port its markup/styles/behavior into
Vue 3 + Tailwind v4 components; do not redesign. Cite it by line range in each task.

**Architecture:** Vue 3 + Pinia + Tailwind v4 in `desktop/`, talking to the FastAPI engine
on `:8765` (all endpoints already exist except a tiny new `GET /host` and an optional
`resources` arg on create — Task 3). The current three components (FleetSidebar, VmDetail,
LogPane) expand into a header, a two-section sidebar, a tabbed detail with five tab
components, a command palette, and a toast layer. State grows in the Pinia store plus a
few UI composables.

**Tech Stack:** Vue 3.5, Pinia, Tailwind v4 (`@tailwindcss/vite`), Vite, Vitest, Playwright,
Biome/ESLint, Tauri v2. Engine: Python 3.12 / FastAPI (touched only in Task 3).

## Global Constraints

- Match the design comp exactly: tokens, spacing, states, copy, and interactions. When in
  doubt, open `docs/design/macfleet.dc.html` and mirror it.
- Design tokens are the comp's CSS variables (comp lines 12–33): dark default + a
  `[data-theme="light"]` override. Theme is driven by `data-theme` on the root element
  (NOT the current `.dark` class) — reconcile `useDarkMode` accordingly.
- Strict TypeScript; follow existing `desktop/src` conventions; keep every `data-test`
  hook the current tests rely on, and add new ones as noted.
- Every list/panel has loading, empty, error, and populated states (the comp shows them).
- Destructive actions use inline two-step confirm (comp lines 223–232), never a dialog.
- All API failures surface as a toast + inline state, never an unhandled rejection (the
  store already wraps mutations; keep that).
- Gap features (Phase 2 backing) are stubbed in Phase 1 but must degrade gracefully — see
  "Gap handling" below. No fake data presented as real: agent activity shows an honest
  empty state; metric bars use configured/derived values, labelled as such.
- Tests: Vitest unit for store/composables + component behavior; Playwright e2e for the
  main flows against a mocked API. Keep the suite green; `bun run lint` + `vue-tsc` clean.
- Commit after every task (Conventional Commits).

## Gap handling (the four no-backend features, this phase)

1. **Host-capacity total** — Task 3 adds `GET /host` → `{total_mem_gb, cpu_count, name}`
   (engine reads `sysctl hw.memsize`/`hw.ncpu`). The header shows
   `running-count · Σ(running VM RAM) / total_mem_gb`.
2. **Create resource preset** — Task 3 adds optional `cpu`/`memory`/`disk` to engine
   `create` (clone → `set_config` before the first `tart run`), so the Advanced→preset
   selector actually applies. Presets: light 2/4/40, standard 4/8/50, heavy 8/16/80.
3. **Live per-VM metrics** — NOT in this phase. The Resources tab shows *configured*
   cpu/mem/disk from `resources()`; the "load"/"used" bars render from configured values
   with a subtle "configured" label (no live utilization). Phase 2 adds a guest poll.
4. **AI-agent activity feed** — NOT in this phase. The header shows the agents indicator
   with an honest empty popover ("No agent activity yet — connect an agent via MCP") and
   no fabricated count/list. Phase 2 adds the real feed.

---

## File structure

Create under `desktop/src/`:
- `shared/api.ts` (modify) — add all new endpoint client fns + types.
- `shared/tokens.css` (create) or extend `style.css` — the comp's CSS variables + keyframes.
- `stores/fleet.ts` (modify) — snapshots, tab, create options, host, new mutations.
- `stores/ui.ts` (create) — theme, search, command palette, toasts (or composables).
- `composables/useToasts.ts`, `composables/useHotkeys.ts`, `composables/useTheme.ts` (create/adjust).
- `components/AppHeader.vue` (create)
- `components/FleetSidebar.vue` (rewrite)
- `components/VmDetail.vue` (rewrite → tabbed shell)
- `components/vmtabs/ScreenTab.vue`, `TerminalTab.vue`, `LogsTab.vue`, `ResourcesTab.vue`, `ConnectTab.vue` (create; LogsTab absorbs the old LogPane)
- `components/CommandPalette.vue` (create)
- `components/Toasts.vue` (create)
- `components/AgentIndicator.vue` (create — stub popover)
- `pages/HomePage.vue` / `layouts/DefaultLayout.vue` (modify) — compose the shell.
- Engine (Task 3 only): `macfleet/connect.py`, `macfleet/api.py`, `macfleet/mcp.py`, `macfleet/cli.py` + tests.

---

## PHASE 1 TASKS

### Task 1: Design tokens, theme system, global CSS

**Files:** `desktop/src/style.css` (modify), `desktop/src/composables/useDarkMode.ts` (modify), `desktop/src/layouts/DefaultLayout.vue` or `App.vue` (root `data-theme`), `tests/unit/useDarkMode.test.ts` (update).

- [ ] Port the comp's CSS variables (comp lines 12–33) and keyframes (lines 44–51) into `style.css`: `:root[data-theme="dark"]{…}` and `:root[data-theme="light"]{…}` (the comp's `[data-mf]`/`[data-theme]` selectors → the app root). Include `mfpulse/mfspin/mfglow/mfblink/mfring/mfin/mfdot` and the reduced-motion guard.
- [ ] Expose the tokens to Tailwind v4 via `@theme` so utilities resolve (e.g. `--color-emerald`, `--color-bg-elev`), OR use the CSS vars directly in components — pick one and use it consistently. Recommended: reference the vars directly (`style="background:var(--bg-elev)"` or `bg-[var(--bg-elev)]`) to keep 1:1 with the comp.
- [ ] Switch theming from the `.dark` class to `data-theme="dark|light"` on the root; update `useDarkMode` to read/write `data-theme` (default dark) and its test.
- [ ] Verify: toggling theme flips all tokens; dark and light both look like the comp; `vue-tsc` + `bun run lint` clean; unit test for the theme composable passes.
- [ ] Commit: `feat(desktop): port design-comp tokens + data-theme theming`

### Task 2: API client + types

**Files:** `desktop/src/shared/api.ts` (modify), `desktop/tests/unit/*` (add client tests, e.g. reuse the pattern in existing api usage).

- [ ] Add types: `Snapshot {id,vm,label,size}`, `Resources {cpu,memory_mb,disk_gb,display,state}`, `ConnectionInfo {ip,ssh,vnc,guest_server,exec}`, `ExecResult {stdout,exit_code}`, `HostInfo {total_mem_gb,cpu_count,name}`.
- [ ] Add client fns mapping to existing endpoints: `create(name,{from_snapshot?,ttl?,cpu?,memory?,disk?})` → `POST /vms`; `suspend(n)`,`resume(n)` → `POST /vms/{n}/suspend|resume`; `snapshot(n,label)` → `POST /vms/{n}/snapshot`; `listSnapshots()` → `GET /snapshots`; `deleteSnapshot(id)` → `DELETE /snapshots/{id}`; `rename(n,newName)` → `POST /vms/{n}/rename`; `duplicate(n,newName)` → `POST /vms/{n}/duplicate`; `resources(n)` → `GET /vms/{n}/resources`; `setResources(n,{cpu?,memory?,disk_size?,display?})` → `PUT`; `connection(n)` → `GET /vms/{n}/connection`; `exec(n,command)` → `POST /vms/{n}/exec`; `host()` → `GET /host` (Task 3).
- [ ] Verify: `vue-tsc` clean; a unit test per fn asserting method+path+body against a mocked `fetch` (mirror the existing `j()` helper). Lint clean.
- [ ] Commit: `feat(desktop): typed API client for snapshots/lifecycle/resources/connect/exec/host`

### Task 3: Engine — `GET /host` + optional resources on create

**Files:** `macfleet/connect.py`, `macfleet/api.py`, `macfleet/mcp.py` (optional tool), `macfleet/cli.py` (optional), `tests/test_connect.py`, `tests/test_api.py`. TDD.

- [ ] `Fleet.host_info() -> dict`: run `sysctl -n hw.memsize hw.ncpu` (via the injected runner) + hostname → `{total_mem_gb: round(bytes/1e9), cpu_count, name}`. Test with a fake runner asserting the parse.
- [ ] `Fleet.create(name, from_snapshot=None, ttl=None, cpu=None, memory=None, disk=None)`: after the clone and before `tart run`, if any of cpu/memory/disk is set, call `self.tart.set_config(target, cpu=…, memory=…, disk_size=…)` (the freshly-cloned VM is stopped). Keep existing behavior when none given. Test: create with a preset asserts a `tart set` precedes `tart run`.
- [ ] `GET /host` route → `fleet.host_info()`; extend `CreateRequest` with optional `cpu/memory/disk`; pass through. Tests via `TestClient` + `FakeFleet` (extend `FakeFleet.host_info` + `create` signature).
- [ ] Verify: `uv run pytest -q` green, `uv run ruff check` clean.
- [ ] Commit: `feat(engine): GET /host + optional resources on create (preset support)`

### Task 4: Pinia store + UI composables

**Files:** `desktop/src/stores/fleet.ts` (modify), `desktop/src/stores/ui.ts` (create), `desktop/src/composables/useToasts.ts` (create), `desktop/tests/unit/fleet.test.ts` + new store tests.

- [ ] Extend `fleet` store: `snapshots` (poll alongside vms), `host` (fetch once), `selectedTab` ('screen'|'terminal'|'logs'|'resources'|'connect'), `createOptions {name, source, preset, ttl, advancedOpen}`. Mutations (each wrapped like existing `run()` → toast on error): `suspend`, `resume`, `snapshot(label)`, `duplicate(name)`, `rename(old,new)`, `deleteSnapshot(id)`, `newFromSnapshot(snap)`, and `create` extended to pass source→from_snapshot, preset→cpu/mem/disk, ttl. Optimistic rows for create/duplicate (comp behavior lines 561–575). TTL countdown tick (comp lines 502–506) driving the sidebar chip + auto-remove + toast.
- [ ] `ui` store / composables: `theme`, `search`, command-palette (`open`, `query`, `index`, `items` built from state — comp `palette()` lines 539–557), `toasts` (add/auto-dismiss — comp line 497).
- [ ] Verify: unit tests for each new mutation (mock api, assert call + optimistic state + toast); TTL tick test with injected time; palette item generation test. Suite green.
- [ ] Commit: `feat(desktop): fleet store — snapshots, tabs, create options, lifecycle mutations, toasts`

### Task 5: AppHeader

**Files:** `desktop/src/components/AppHeader.vue` (create), compose into `App.vue`/layout, `useHotkeys` for ⌘K.

- [ ] Build from comp lines 57–105: logo mark, search input (binds `ui.search`, filters the sidebar), command-palette trigger button (⌘K), host-capacity chip (`Σ running RAM / host.total_mem_gb`, running count), agents indicator (delegate to `AgentIndicator.vue`, Task 5b), theme toggle.
- [ ] Global ⌘K/Ctrl-K opens the palette (comp lines 520–522); wire via `useHotkeys`.
- [ ] Verify: renders; search updates store; ⌘K opens palette; capacity reflects mocked host+vms; theme toggles. Component test.
- [ ] Commit: `feat(desktop): app header — search, palette trigger, capacity, agents, theme`

### Task 5b: AgentIndicator (stub)

**Files:** `desktop/src/components/AgentIndicator.vue` (create).

- [ ] Build the indicator + popover shell (comp lines 83–102) but with an honest empty state: no count badge (or "MCP"), popover body "No agent activity yet — connect an agent over MCP." No fabricated agents. A `// Phase 2:` comment points at the future feed.
- [ ] Verify: renders, popover opens/closes, shows the empty state. Test.
- [ ] Commit: `feat(desktop): agent indicator (empty-state stub for Phase 2)`

### Task 6: FleetSidebar rewrite (Fleet + Snapshots + Advanced create)

**Files:** `desktop/src/components/FleetSidebar.vue` (rewrite), tests updated.

- [ ] Fleet section (comp lines 114–137): rows with the dot styles from the comp render (lines 609–618) — running solid+glow, booting pulse, suspended dim, creating spinner; mono name; state label; TTL chip; active highlight (+ glow when live+active). Filter by `ui.search`.
- [ ] Snapshots section (comp lines 139–152): rows (◈ label / source·size·age) + `＋ VM` → `store.newFromSnapshot`.
- [ ] Create panel (comp lines 155–188): name input + `⚡ Spin up`; Advanced toggle → Source select (Golden + snapshots), Resources preset select, TTL checkbox; "resumes in ~2s" note. Wire to `store.createOptions` + `store.create`.
- [ ] Keep `data-test="vm-row"`, `up-form`, `up-name`, `up-btn` (map "Spin up" to `up-btn`); add `snap-row`, `snap-new`.
- [ ] Verify: rows render across all six states (use mocked list); creating shows optimistic row; create with a preset/snapshot/ttl calls `store.create` with the right args; snapshot `＋VM` works. Unit + keep e2e selectors.
- [ ] Commit: `feat(desktop): sidebar — fleet states, snapshots section, advanced create`

### Task 7: VmDetail tabbed shell

**Files:** `desktop/src/components/VmDetail.vue` (rewrite), `desktop/src/pages/HomePage.vue` (wire).

- [ ] Header (comp lines 197–234): status dot, inline-rename name (click → input, Enter commits via `store.rename`, Esc cancels), state badge, resource chips (vCPU/RAM/disk from the selected VM/`resources`), action cluster: Suspend/Resume (`store.suspend/resume`), ◈ Snapshot (prompt label → `store.snapshot`), ⧉ Duplicate (`store.duplicate`), ↔ Connect (switch to Connect tab), delete (two-step confirm → `store.nuke`).
- [ ] Tab bar (comp lines 236–241 + 668–669): Screen/Terminal/Logs/Resources/Connect, active underline; binds `store.selectedTab`. Render the active tab component (Tasks 8–12).
- [ ] Empty state (comp lines 406–414) when no selection: "Select a VM" / "No VMs yet — spin up first VM".
- [ ] Verify: header actions call store; tabs switch; rename/delete flows; empty state. Component test.
- [ ] Commit: `feat(desktop): tabbed VM detail — header actions, rename, tab bar`

### Task 8: ScreenTab

**Files:** `desktop/src/components/vmtabs/ScreenTab.vue` (create). Absorbs the current VmDetail screenshot logic.

- [ ] Live screenshot framed 16:10 (comp lines 246–309): poll `api.screenshot` when `state==='running'` (reuse the current stable poll + keep-last-frame behavior), click-to-control (`api.click` with pixel mapping), type input + Send (`api.type`), pause, fullscreen (best-effort). Overlay states for booting/creating/stopped/suspended/error with the comp's messages + resume action (comp lines 291–298, 682–689). Helper line (comp 307).
- [ ] Verify: screenshot renders for running; click/type call api and surface a toast; each non-running state shows its overlay. Test (mock api), reuse the current VmDetail screenshot tests.
- [ ] Commit: `feat(desktop): screen tab — live view, click/type, state overlays`

### Task 9: TerminalTab

**Files:** `desktop/src/components/vmtabs/TerminalTab.vue` (create).

- [ ] In-guest shell (comp lines 311–330): scrollback of `{cmd, out, exit_code}` (exit colored green/red — comp line 711), command input → `api.exec(name, cmd)` → append result. Per-VM history in the store or local. Prompt `admin@<name> ~ %`.
- [ ] Verify: running a command calls `api.exec` and renders stdout + exit code; nonzero exit is red. Test.
- [ ] Commit: `feat(desktop): terminal tab — in-guest exec shell`

### Task 10: LogsTab

**Files:** `desktop/src/components/vmtabs/LogsTab.vue` (create; retire `LogPane.vue`).

- [ ] Port `LogPane` behavior into the comp's Logs styling (comp lines 332–345): live tail via `api.logs`, level coloring (INFO/OK/WARN/ERR — comp line 714), pause, auto-scroll, running-gated.
- [ ] Verify: streams while running, pauses, shows "VM not running" otherwise. Keep LogPane's tests, retargeted.
- [ ] Commit: `feat(desktop): logs tab (replaces LogPane)`

### Task 11: ResourcesTab

**Files:** `desktop/src/components/vmtabs/ResourcesTab.vue` (create).

- [ ] Metric cards CPU/Memory/Disk/Display (comp lines 347–382) from `api.resources(name)`; bars from configured values (Phase-1 stub — no live utilization; label the bar "configured"). Locked banner when running ("Stop the VM to change…"), editable banner + inputs when stopped → `api.setResources` (disk grow-only; 409→toast).
- [ ] Verify: shows resources; edit disabled/hidden when running; setResources called with correct args when stopped; a running-state 409 surfaces a toast. Test.
- [ ] Commit: `feat(desktop): resources tab — cards + stopped-only editing`

### Task 12: ConnectTab

**Files:** `desktop/src/components/vmtabs/ConnectTab.vue` (create).

- [ ] Cards for IP / SSH / VNC / Guest server URL from `api.connection(name)` (comp lines 384–400, 677–679), each with a Copy button that writes the clipboard + shows ✓ + toast (comp `copyField` line 582). Empty/`—` when no IP yet.
- [ ] Verify: renders items from mocked connection; copy writes clipboard + confirms. Test.
- [ ] Commit: `feat(desktop): connect tab — connection info with copy`

### Task 13: CommandPalette

**Files:** `desktop/src/components/CommandPalette.vue` (create).

- [ ] Overlay + input (comp lines 419–440), grouped fuzzy list built from `ui.paletteItems` (comp `palette()` lines 539–557 + `fuzzy` 498): Create (spin up, new-from-each-snapshot), VM (snapshot/suspend-resume/duplicate/rename/resize/connect/terminal/logs), Danger (delete), Go to (switch VM), App (toggle theme). Arrow/Enter/Esc keyboard nav (comp 523–530). Each item runs the matching store action.
- [ ] Verify: ⌘K opens; typing filters; arrows move selection; Enter runs; Esc closes. Test.
- [ ] Commit: `feat(desktop): command palette (⌘K)`

### Task 14: Toasts

**Files:** `desktop/src/components/Toasts.vue` (create), ensure store mutations emit toasts.

- [ ] Bottom-right toast stack (comp lines 442–447 + 648), auto-dismiss ~2.6s, icon + message. Consume `ui.toasts`.
- [ ] Verify: a store action (e.g. suspend) produces a toast that appears then dismisses. Test.
- [ ] Commit: `feat(desktop): toast layer`

### Task 15: Compose shell + e2e + real-app verification

**Files:** `desktop/src/App.vue`/`layouts`/`pages/HomePage.vue`, `desktop/tests/e2e/*`.

- [ ] Assemble: Header (top), body = Sidebar | tabbed VmDetail, plus CommandPalette + Toasts overlays. Ensure full-height, no page scroll, dark+light both correct.
- [ ] Update/extend Playwright e2e against a mocked API for the core journeys: create (with advanced options) → appears; select VM → each tab renders; run a terminal command; open connect + copy; snapshot → appears in sidebar; ⌘K → run a command; delete (two-step). Keep the existing dashboard smoke green (retarget selectors).
- [ ] Verify (evidence required): `bun run test:unit` + `bun run lint` + `bunx vue-tsc -b` + `bunx playwright test` all green; then run the real app (`bun tauri dev`), select a VM, and screenshot it to confirm it matches `docs/design/.thumbnail` in both themes.
- [ ] Commit: `feat(desktop): compose redesigned shell + e2e`

---

## PHASE 2 (separate plan, later) — the four gap backends

1. **Agent-activity feed:** the MCP server appends `{who, action, target, ts}` for each
   tool call to an in-engine ring buffer exposed at `GET /agents/activity`; the header
   indicator + popover consume it live.
2. **Live per-VM metrics:** a guest poll (via `exec`: `top -l1`/`vm_stat`, or the
   cua-server) → real CPU%/mem-used; the Resources bars and header capacity go live.
3. **Richer host info:** disk capacity + live host memory pressure for the capacity chip.
4. **Polish:** fullscreen screen view, keyboard shortcuts beyond ⌘K, snapshot delete from
   the sidebar, per-tab deep-links.

## Testing summary

- L0 (CI gate): Vitest unit (store mutations, composables, each component's behavior) +
  Playwright e2e (mocked API) — must stay green; `vue-tsc` + lint clean; engine `pytest`
  green (Task 3).
- L1 (manual): run `bun tauri dev` against the real engine; verify each tab, create
  flows, command palette, snapshots, and both themes against the comp.
