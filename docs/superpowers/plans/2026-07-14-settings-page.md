# Settings Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `/settings` page with General (default VM size), Data (two-tier reset), and Doctor (checks + engine log) sections — and delete the frontend's hardcoded preset table in favour of the engine's (plan 2 of 3).

**Architecture:** A new `stores/settings.ts` owns everything the engine's `/config` and `/doctor` endpoints serve; `shared/api.ts` gains four methods in its existing style. `stores/fleet.ts`'s local `PRESETS` const is deleted and `create()` reads presets from the settings store instead — the point of the whole exercise. The Doctor section reads `~/.macfleet/engine.log` through `tauri-plugin-fs` rather than the engine API, deliberately, so it still works when the engine is dead.

**Tech Stack:** Vue 3.5 (`<script setup>`), Pinia 3 (setup stores), Tailwind 4 (CSS-var design system), vue-router 5, Vitest + @vue/test-utils, Playwright, Tauri 2 plugins (fs, dialog, opener).

Spec: `docs/superpowers/specs/2026-07-14-settings-doctor-and-tray-menu-design.md`
Depends on: `docs/superpowers/plans/2026-07-14-settings-engine-surface.md` (plan 1 — **merged**, endpoints are live)

## Deviations from the spec

One, deliberate, flagged for the record rather than dropped silently:

- **The spec's §5 asks for reveal buttons for both `~/.macfleet` and
  `~/Library/Logs/com.macfleet.desktop/`. This plan builds only the first.** The Tauri host
  log is plugin/webview noise; the engine log is the one that explains a non-starting engine,
  and plan 1 built it specifically for that. A second button means another `opener` scope
  entry and another test for a directory a user is unlikely to want. Trivial to add later if
  it turns out to be wanted.

## Global Constraints

- **Style: use the CSS-var design system, NOT `AboutPage.vue`.** `AboutPage.vue` and `NotFoundPage.vue` still carry stock `gray-*`/`zinc-*` classes from the template scaffold; they are outliers. Every real component (`AppHeader.vue`, `SnapshotDialog.vue`, `components/vmtabs/*`) uses arbitrary-value Tailwind over CSS vars: `bg-[var(--bg-elev)]`, `border-[var(--border)]`, `text-[var(--text-dim)]`, `text-[12.5px]`, `rounded-[7px]`. **Read `SnapshotDialog.vue` and `ResourcesTab.vue` before writing any template.**
- Available CSS vars (`src/style.css`): `--bg`, `--bg-elev`, `--bg-elev2`, `--bg-hover`, `--border`, `--border-strong`, `--text`, `--text-dim`, `--text-faint`, `--emerald`, `--amber`, `--red`, `--idle`, `--violet`, `--shadow`, `--sans`, `--mono`. Dark mode is attribute-driven (`[data-theme="dark"]`), already handled by the vars — do NOT add `dark:` variants.
- **Wire types stay snake_case.** `shared/api.ts` already exposes `memory_mb`, `total_mem_gb`, `lease_expires_at` verbatim from the engine. The engine serves presets as `{cpu, memory_gb}` — use `memory_gb`, do not rename to `memoryGb`.
- **GB→MB conversion happens at the call site of `api.create`**, exactly as the current code does (`memoryGb * 1024` becomes `memory_gb * 1024`). One site only.
- Every component carries a `data-test` hook (see existing components); the Playwright suite selects on them.
- Pinia stores are setup-style: `defineStore('name', () => { ... return {...} })`.
- Cross-store calls resolve the other store **lazily at call time** (`useUi()` inside a function body, not at module scope) — `fleet.ts` does this already and its comment explains why: "resolved lazily at call time so the module cycle never breaks".
- Tests: Vitest + `@vue/test-utils`, `setActivePinia(createPinia())` in `beforeEach`, `vi.spyOn(api, '...')` to stub the client. Fakes over mocks. See `tests/unit/fleet.test.ts`.
- **Await pending work with `flushPromises()` from `@vue/test-utils`** — the house idiom, used in 10 existing test files. Never `await new Promise(r => setTimeout(r, 0))`: it appears nowhere in this repo, and one macrotask tick does not reliably drain a chained promise the way `flushPromises` does.
- Commands (from `desktop/`): `bun run test:unit`, `bun run test:e2e`, `make lint-desktop`, `make ci`.
- Coverage gates are **lines 95 / branches 90 / functions 85 / statements 92** (`desktop/vitest.config.ts`), not 100. Its comment says why: "A blanket 100% requirement made the coverage command permanently red despite >95% line coverage." Do not chase 100%; do not let your additions drop the suite below the configured gates.
- Conventional Commits. No `Co-authored-by`.

---

### Task 1: API client methods

**Files:**
- Modify: `desktop/src/shared/api.ts`
- Test: `desktop/tests/unit/api.test.ts`

**Interfaces:**
- Consumes: the live engine endpoints from plan 1 — `GET /config`, `PUT /config`, `GET /doctor`, `POST /data/reset`
- Produces:
  - `export type PresetName = 'light' | 'standard' | 'heavy'`
  - `export interface Preset { cpu: number; memory_gb: number }`
  - `export interface ConfigResponse { default_preset: PresetName; presets: Record<PresetName, Preset> }`
  - `export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skip'`
  - `export interface DoctorCheck { id: string; label: string; status: CheckStatus; detail: string; fix: string | null }`
  - `export interface ResetResult { deleted: string[]; failed: { name: string; error: string }[]; removed_paths: string[] }`
  - `api.config()`, `api.setConfig(defaultPreset)`, `api.doctor()`, `api.resetData(scope)`

**Reference — the real engine responses (captured live from plan 1, use these exact shapes):**

```json
GET /config
{"default_preset": "standard",
 "presets": {"light": {"cpu": 2, "memory_gb": 4},
             "standard": {"cpu": 4, "memory_gb": 8},
             "heavy": {"cpu": 8, "memory_gb": 16}}}

GET /doctor
{"checks": [{"id": "arch", "label": "Apple silicon", "status": "ok", "detail": "arm64", "fix": null},
            {"id": "golden_warm", "label": "Golden image warm", "status": "warn",
             "detail": "state is 'stopped' — new VMs will cold-boot (~30-60s)", "fix": "macfleet warm"}]}

POST /data/reset  {"scope": "fleet"}
{"deleted": ["mf-web"], "failed": [], "removed_paths": ["/Users/x/.macfleet/state.json"]}
```

- [ ] **Step 1: Write the failing tests**

Read `tests/unit/api.test.ts` first and match its existing style. Append:

```ts
describe('settings endpoints', () => {
  it('config() GETs /config', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          default_preset: 'standard',
          presets: { light: { cpu: 2, memory_gb: 4 } },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )
    const cfg = await api.config()
    expect(fetchSpy.mock.calls[0][0]).toContain('/config')
    expect(cfg.default_preset).toBe('standard')
    expect(cfg.presets.light).toEqual({ cpu: 2, memory_gb: 4 })
  })

  it('setConfig() PUTs the default_preset', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ default_preset: 'heavy', presets: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    await api.setConfig('heavy')
    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).toContain('/config')
    expect(init?.method).toBe('PUT')
    expect(JSON.parse(String(init?.body))).toEqual({ default_preset: 'heavy' })
  })

  it('doctor() unwraps the checks array', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          checks: [{ id: 'arch', label: 'Apple silicon', status: 'ok', detail: 'arm64', fix: null }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )
    const checks = await api.doctor()
    // Callers want the list, not the envelope.
    expect(Array.isArray(checks)).toBe(true)
    expect(checks[0].id).toBe('arch')
  })

  it('resetData() POSTs the scope', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ deleted: ['mf-a'], failed: [], removed_paths: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const res = await api.resetData('all')
    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).toContain('/data/reset')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(String(init?.body))).toEqual({ scope: 'all' })
    expect(res.deleted).toEqual(['mf-a'])
  })
})
```

If `tests/unit/api.test.ts` stubs `fetch` differently (check the top of the file), follow ITS pattern rather than the above — the assertions matter, the stubbing mechanism should match the file.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd desktop && bun run test:unit -- api`
Expected: FAIL — `api.config is not a function`

- [ ] **Step 3: Add the types**

In `desktop/src/shared/api.ts`, next to the other wire types (near `Vm`/`HostInfo`):

```ts
export type PresetName = 'light' | 'standard' | 'heavy'

/** cpu + RAM only — never disk. `tart set --disk-size` is grow-only and mf-golden ships an
 * ~80GB base disk, so a preset disk size would ask tart to shrink it and fail the clone.
 * Engine-owned (macfleet/config.py); this app no longer keeps its own copy. */
export interface Preset {
  cpu: number
  memory_gb: number
}

export interface ConfigResponse {
  default_preset: PresetName
  presets: Record<PresetName, Preset>
}

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skip'

/** One doctor row (macfleet/doctor.py). `fix` is a human-readable hint, not an action —
 * doctor diagnoses, it never repairs. */
export interface DoctorCheck {
  id: string
  label: string
  status: CheckStatus
  detail: string
  fix: string | null
}

export interface ResetResult {
  deleted: string[]
  failed: { name: string; error: string }[]
  removed_paths: string[]
}

export type ResetScope = 'fleet' | 'all'
```

- [ ] **Step 4: Add the methods**

In the `api` object literal, next to `host`:

```ts
  config: () => j<ConfigResponse>('/config'),
  setConfig: (defaultPreset: PresetName) =>
    putJson<ConfigResponse>('/config', { default_preset: defaultPreset }),
  // Unwrap the {checks:[...]} envelope here so no caller has to know about it.
  doctor: () => j<{ checks: DoctorCheck[] }>('/doctor').then((r) => r.checks),
  resetData: (scope: ResetScope) => postJson<ResetResult>('/data/reset', { scope }),
```

Verify `putJson` / `postJson` exist and are generic in this file before using them (they are used by `setShares` / `snapshot`); if their signatures differ, match what is actually there.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd desktop && bun run test:unit -- api`
Expected: PASS

- [ ] **Step 6: Typecheck + lint**

Run: `cd desktop && bun run build && make lint-desktop`
Expected: clean

- [ ] **Step 7: Commit**

```bash
git add desktop/src/shared/api.ts desktop/tests/unit/api.test.ts
git commit -m "feat(desktop): add config, doctor, and reset API methods"
```

---

### Task 2: Settings store

**Files:**
- Create: `desktop/src/stores/settings.ts`
- Test: `desktop/tests/unit/settings.test.ts`

**Interfaces:**
- Consumes: `api.config`, `api.setConfig`, `api.doctor`, `api.resetData`, types from Task 1; `useToasts`
- Produces `useSettings()` exposing:
  - `presets: Ref<Record<PresetName, Preset> | null>`, `defaultPreset: Ref<PresetName>`, `loaded: Ref<boolean>`
  - `checks: Ref<DoctorCheck[]>`, `doctorRunning: Ref<boolean>`, `doctorError: Ref<string | null>`
  - `resetting: Ref<boolean>`
  - `load(): Promise<void>` — **idempotent**, no-op once loaded
  - `setDefaultPreset(p: PresetName): Promise<void>`
  - `runDoctor(): Promise<void>`
  - `resetData(scope: ResetScope): Promise<ResetResult | null>`

- [ ] **Step 1: Write the failing tests**

Create `desktop/tests/unit/settings.test.ts`:

```ts
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setToastScheduler, useToasts } from '../../src/composables/useToasts'
import { api } from '../../src/shared/api'
import { useSettings } from '../../src/stores/settings'

const CONFIG = {
  default_preset: 'standard' as const,
  presets: {
    light: { cpu: 2, memory_gb: 4 },
    standard: { cpu: 4, memory_gb: 8 },
    heavy: { cpu: 8, memory_gb: 16 },
  },
}

beforeEach(() => {
  setActivePinia(createPinia())
  setToastScheduler(() => {})
  useToasts().toasts.value = []
})

describe('settings store', () => {
  it('load fetches config once and is idempotent', async () => {
    const spy = vi.spyOn(api, 'config').mockResolvedValue(CONFIG)
    const s = useSettings()
    await s.load()
    await s.load()
    // A second load must not re-hit the engine — create() calls this defensively on every
    // create, so a non-idempotent load would fire an HTTP request per VM created.
    expect(spy).toHaveBeenCalledTimes(1)
    expect(s.loaded).toBe(true)
    expect(s.defaultPreset).toBe('standard')
    expect(s.presets?.heavy).toEqual({ cpu: 8, memory_gb: 16 })
  })

  it('load surfaces an error and stays unloaded so a later load retries', async () => {
    const spy = vi.spyOn(api, 'config').mockRejectedValueOnce(new Error('boom'))
    const s = useSettings()
    await s.load()
    expect(s.loaded).toBe(false)
    expect(s.presets).toBeNull()
    spy.mockResolvedValue(CONFIG)
    await s.load()
    expect(s.loaded).toBe(true)
  })

  it('concurrent loads share one request', async () => {
    const spy = vi.spyOn(api, 'config').mockResolvedValue(CONFIG)
    const s = useSettings()
    await Promise.all([s.load(), s.load(), s.load()])
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('setDefaultPreset writes through and updates state', async () => {
    vi.spyOn(api, 'config').mockResolvedValue(CONFIG)
    const spy = vi
      .spyOn(api, 'setConfig')
      .mockResolvedValue({ ...CONFIG, default_preset: 'heavy' as const })
    const s = useSettings()
    await s.load()
    await s.setDefaultPreset('heavy')
    expect(spy).toHaveBeenCalledWith('heavy')
    expect(s.defaultPreset).toBe('heavy')
  })

  it('setDefaultPreset leaves state untouched when the write fails', async () => {
    vi.spyOn(api, 'config').mockResolvedValue(CONFIG)
    vi.spyOn(api, 'setConfig').mockRejectedValue(new Error('409'))
    const s = useSettings()
    await s.load()
    await s.setDefaultPreset('heavy')
    // Optimistic UI would leave the picker showing a default the engine never accepted.
    expect(s.defaultPreset).toBe('standard')
    expect(useToasts().toasts.value.length).toBeGreaterThan(0)
  })

  it('runDoctor stores checks and clears the running flag', async () => {
    const checks = [
      { id: 'arch', label: 'Apple silicon', status: 'ok' as const, detail: 'arm64', fix: null },
    ]
    vi.spyOn(api, 'doctor').mockResolvedValue(checks)
    const s = useSettings()
    await s.runDoctor()
    expect(s.checks).toEqual(checks)
    expect(s.doctorRunning).toBe(false)
    expect(s.doctorError).toBeNull()
  })

  it('runDoctor records an error when the engine is unreachable', async () => {
    vi.spyOn(api, 'doctor').mockRejectedValue(new Error('connection refused'))
    const s = useSettings()
    await s.runDoctor()
    // Engine down is exactly when Doctor is opened — it must say so, not spin.
    expect(s.doctorError).toContain('connection refused')
    expect(s.doctorRunning).toBe(false)
    expect(s.checks).toEqual([])
  })

  it('resetData returns the result and toasts what went', async () => {
    vi.spyOn(api, 'resetData').mockResolvedValue({
      deleted: ['mf-a', 'mf-b'],
      failed: [],
      removed_paths: ['/x/state.json'],
    })
    const s = useSettings()
    const res = await s.resetData('fleet')
    expect(res?.deleted).toEqual(['mf-a', 'mf-b'])
    expect(s.resetting).toBe(false)
    expect(useToasts().toasts.value.length).toBeGreaterThan(0)
  })

  it('resetData surfaces per-VM failures rather than reporting success', async () => {
    vi.spyOn(api, 'resetData').mockResolvedValue({
      deleted: ['mf-a'],
      failed: [{ name: 'mf-b', error: 'busy' }],
      removed_paths: [],
    })
    const s = useSettings()
    await s.resetData('fleet')
    const text = useToasts().toasts.value.map((t) => t.text).join(' ')
    expect(text).toContain('mf-b')
  })

  it('resetData returns null and toasts when the request itself fails', async () => {
    vi.spyOn(api, 'resetData').mockRejectedValue(new Error('409 conflict'))
    const s = useSettings()
    expect(await s.resetData('all')).toBeNull()
    expect(s.resetting).toBe(false)
    expect(useToasts().toasts.value.length).toBeGreaterThan(0)
  })
})
```

Check `useToasts()`'s actual toast shape before asserting on `t.text` — read `src/composables/useToasts.ts` and use its real field name.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd desktop && bun run test:unit -- settings`
Expected: FAIL — cannot resolve `../../src/stores/settings`

- [ ] **Step 3: Write the store**

Create `desktop/src/stores/settings.ts`:

```ts
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { useToasts } from '../composables/useToasts'
import {
  api,
  type DoctorCheck,
  type Preset,
  type PresetName,
  type ResetResult,
  type ResetScope,
} from '../shared/api'

export const useSettings = defineStore('settings', () => {
  const { add: toast } = useToasts()

  const presets = ref<Record<PresetName, Preset> | null>(null)
  const defaultPreset = ref<PresetName>('standard')
  const loaded = ref(false)

  const checks = ref<DoctorCheck[]>([])
  const doctorRunning = ref(false)
  const doctorError = ref<string | null>(null)

  const resetting = ref(false)

  // Shared in-flight promise. create() calls load() defensively on every create, and the
  // Settings page calls it on mount — without this, a create during boot fires a second
  // GET /config. Cleared on failure so a later call retries rather than replaying the
  // rejection forever (same reasoning as api.ts's configPromise).
  let inFlight: Promise<void> | null = null

  async function load(): Promise<void> {
    if (loaded.value) return
    if (inFlight) return inFlight
    const p = (async () => {
      try {
        const cfg = await api.config()
        presets.value = cfg.presets
        defaultPreset.value = cfg.default_preset
        loaded.value = true
      } catch (e) {
        toast(`Could not load settings: ${e}`, '⚠')
      } finally {
        inFlight = null
      }
    })()
    inFlight = p
    return p
  }

  async function setDefaultPreset(p: PresetName): Promise<void> {
    try {
      const cfg = await api.setConfig(p)
      // Trust the engine's echo, not the local guess — it is the authority on what stuck.
      defaultPreset.value = cfg.default_preset
      toast(`Default size set to ${cfg.default_preset}`, '✓')
    } catch (e) {
      toast(`Could not save default size: ${e}`, '⚠')
    }
  }

  async function runDoctor(): Promise<void> {
    doctorRunning.value = true
    doctorError.value = null
    try {
      checks.value = await api.doctor()
    } catch (e) {
      // Doctor is opened precisely when things are broken; an unreachable engine is a
      // reportable state, not a spinner.
      doctorError.value = String(e)
    } finally {
      doctorRunning.value = false
    }
  }

  async function resetData(scope: ResetScope): Promise<ResetResult | null> {
    resetting.value = true
    try {
      const res = await api.resetData(scope)
      if (res.failed.length > 0) {
        toast(`Could not delete ${res.failed.map((f) => f.name).join(', ')}`, '⚠')
      } else {
        toast(`Removed ${res.deleted.length} VM(s)`, '✓')
      }
      return res
    } catch (e) {
      toast(`Reset failed: ${e}`, '⚠')
      return null
    } finally {
      resetting.value = false
    }
  }

  return {
    presets,
    defaultPreset,
    loaded,
    checks,
    doctorRunning,
    doctorError,
    resetting,
    load,
    setDefaultPreset,
    runDoctor,
    resetData,
  }
})
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd desktop && bun run test:unit -- settings`
Expected: PASS (10 passed)

- [ ] **Step 5: Commit**

```bash
git add desktop/src/stores/settings.ts desktop/tests/unit/settings.test.ts
git commit -m "feat(desktop): add settings store"
```

---

### Task 3: Delete the frontend preset table

**This is the task the whole plan exists for.** Until now `macfleet up foo` (CLI) and a desktop create produced different VMs, because the desktop had its own copy of the preset table. Plan 1 made the engine the owner; this deletes the copy.

**Files:**
- Modify: `desktop/src/stores/fleet.ts` — delete `PRESETS` (~line 44-51) and the local `Preset` union, change its one consumer (~line 433), and the `createOptions` type (~line 127)
- Modify: `desktop/src/stores/settings.ts` — apply the configured default to the create form (Step 4)
- Test: `desktop/tests/unit/fleet.test.ts`

**Interfaces:**
- Consumes: `useSettings()` (Task 2) — `presets`, `defaultPreset`, `load()`
- Produces: no new exports. `fleet.createOptions.preset` now initialises from the engine's configured default.

**The code being deleted (`desktop/src/stores/fleet.ts:44-51`):**

```ts
// cpu / RAM (GB) — matches the design comp's presets verbatim. No disk: `tart set
// --disk-size` is grow-only and mf-golden already ships an ~80GB base disk, so sending
// a preset disk size (e.g. Light's 40GB) would ask tart to shrink it and fail the clone.
const PRESETS: Record<Preset, { cpu: number; memoryGb: number }> = {
  light: { cpu: 2, memoryGb: 4 },
  standard: { cpu: 4, memoryGb: 8 },
  heavy: { cpu: 8, memoryGb: 16 },
}
```

Its only consumer is `create()` at ~line 433: `const preset = PRESETS[opts.preset]`, used at ~line 454 as `cpu: preset.cpu, memory: preset.memoryGb * 1024`.

**Name collision — resolve it this way, exactly.** `fleet.ts` currently declares a union
`type Preset = 'light' | 'standard' | 'heavy'`, while Task 1 added an interface named
`Preset` to `api.ts` for the `{cpu, memory_gb}` *shape*. Two different meanings, one name.

- **Delete** `fleet.ts`'s local `Preset` union.
- Use `PresetName` (from `api.ts`) wherever the union was meant — notably
  `CreateOptions.preset: PresetName`.
- `Preset` from now on means only the shape `{ cpu: number; memory_gb: number }`.

Grep for `Preset` across `desktop/src/` after the change: every remaining reference must be
either `PresetName` (the union) or the shape interface, never the old local union.

- [ ] **Step 1: Write the failing tests**

Append to `desktop/tests/unit/fleet.test.ts`:

```ts
describe('create uses engine-owned presets', () => {
  const CONFIG = {
    default_preset: 'heavy' as const,
    presets: {
      light: { cpu: 2, memory_gb: 4 },
      standard: { cpu: 4, memory_gb: 8 },
      heavy: { cpu: 8, memory_gb: 16 },
    },
  }

  it('sends the cpu/memory the engine defines, converting GB to MB', async () => {
    vi.spyOn(api, 'config').mockResolvedValue(CONFIG)
    vi.spyOn(api, 'listVms').mockResolvedValue([])
    const createSpy = vi.spyOn(api, 'create').mockResolvedValue(undefined as never)
    const s = useFleet()
    await useSettings().load()
    await s.refresh()
    s.createOptions.name = 'web'
    s.createOptions.preset = 'light'
    await s.create()
    expect(createSpy).toHaveBeenCalledWith('web', expect.objectContaining({ cpu: 2, memory: 4096 }))
  })

  it('defaults the create form to the engine-configured preset', async () => {
    vi.spyOn(api, 'config').mockResolvedValue(CONFIG)
    const s = useFleet()
    await useSettings().load()
    // The whole point of the "Default size" setting: a new VM gets it without the user
    // touching the picker.
    expect(s.createOptions.preset).toBe('heavy')
  })

  it('loads settings before creating even if nobody opened Settings', async () => {
    const cfgSpy = vi.spyOn(api, 'config').mockResolvedValue(CONFIG)
    vi.spyOn(api, 'listVms').mockResolvedValue([])
    const createSpy = vi.spyOn(api, 'create').mockResolvedValue(undefined as never)
    const s = useFleet()
    await s.refresh()
    s.createOptions.name = 'web'
    await s.create()
    expect(cfgSpy).toHaveBeenCalled()
    expect(createSpy).toHaveBeenCalledWith('web', expect.objectContaining({ cpu: 8 }))
  })

  it('does not create when presets are unavailable', async () => {
    vi.spyOn(api, 'config').mockRejectedValue(new Error('engine down'))
    vi.spyOn(api, 'listVms').mockResolvedValue([])
    const createSpy = vi.spyOn(api, 'create').mockResolvedValue(undefined as never)
    const s = useFleet()
    await s.refresh()
    s.createOptions.name = 'web'
    await s.create()
    // Better to refuse than to invent a size — inventing one is the bug this plan removes.
    expect(createSpy).not.toHaveBeenCalled()
  })
})
```

Add `import { useSettings } from '../../src/stores/settings'` to the test file's imports.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd desktop && bun run test:unit -- fleet`
Expected: FAIL — create still uses the hardcoded table, so `createOptions.preset` is `'standard'` not `'heavy'`

- [ ] **Step 3: Delete `PRESETS` and rewire `create()`**

Delete the `PRESETS` const and its comment block entirely. In `create()`, replace `const preset = PRESETS[opts.preset]` with:

```ts
    // Presets are engine-owned (macfleet/config.py) so the CLI and this app cannot disagree
    // about what "standard" means. load() is idempotent, so this costs one request per app
    // run, not one per create.
    const settings = useSettings()
    await settings.load()
    const preset = settings.presets?.[opts.preset]
    if (!preset) {
      toast('Could not read VM sizes from the engine', '⚠')
      return
    }
```

and at the `api.create` call, `memoryGb` becomes `memory_gb`:

```ts
        cpu: preset.cpu,
        memory: preset.memory_gb * 1024,
```

Import `useSettings` lazily inside the function body if a module cycle appears — follow the existing `useUi()` precedent in this same function and its comment.

- [ ] **Step 4: Default the create form to the configured preset**

The `createOptions` ref (~line 127) keeps `preset: 'standard'` as its initial literal — a value is needed before config arrives. Apply the engine's default once it loads. In `settings.ts`'s `load()`, after `defaultPreset.value = cfg.default_preset`, add:

```ts
        // Point the create form at the configured default. Safe to overwrite: load() runs on
        // app mount, before the user can have touched the picker, and after an explicit
        // setDefaultPreset the overwrite is exactly what the user just asked for.
        useFleet().createOptions.preset = cfg.default_preset
```

and the same line at the end of `setDefaultPreset`'s success path. Import `useFleet` **inside the function bodies**, not at module scope — `fleet.ts` imports `settings.ts`, so a module-scope import here is a cycle.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd desktop && bun run test:unit`
Expected: PASS. Existing create tests that asserted `cpu: 4, memory: 8192` from the old hardcoded table will now need `api.config` stubbed — that is a legitimate update (the source of truth moved). **Do not weaken an assertion to make it green**: if a test asserted a specific size, it should still assert a specific size, just sourced from the stubbed config.

- [ ] **Step 6: Verify the table is really gone**

Run: `cd desktop && grep -rn "memoryGb\|PRESETS" src/`
Expected: **no output.** Any hit means a second copy of the table survived and the CLI/desktop split is still there.

- [ ] **Step 7: Typecheck, lint, coverage**

Run: `cd desktop && bun run build && make lint-desktop && bun run test:unit -- --coverage`
Expected: clean; coverage stays above the configured gates (95/90/85/92)

- [ ] **Step 8: Commit**

```bash
git add desktop/src/stores/fleet.ts desktop/src/stores/settings.ts desktop/tests/unit/fleet.test.ts
git commit -m "feat(desktop): source VM size presets from the engine"
```

---

### Task 4: Route

**Files:**
- Modify: `desktop/src/router/index.ts`
- Modify: `desktop/tests/unit/router.test.ts`
- Create: `desktop/src/pages/SettingsPage.vue` (placeholder shell — filled in Tasks 5-7)

**Interfaces:**
- Produces: route `{ path: '/settings', name: 'settings' }`

**Note:** `tests/unit/router.test.ts` asserts `toHaveLength(3)` and index-addresses routes (`routes[0]`, `[1]`, `[2]`). The new route goes **before** the `:pathMatch` catch-all — a route after it is unreachable. Update the count to 4 and add a case for `/settings`; the catch-all becomes `routes[3]`.

- [ ] **Step 1: Write the failing test**

In `desktop/tests/unit/router.test.ts`, change `expect(routes).toHaveLength(3)` to `toHaveLength(4)`, change the not-found case to `router.options.routes[3]`, and add:

```ts
  it('has settings route at /settings', () => {
    const settings = router.options.routes[2]
    expect(settings.path).toBe('/settings')
    expect(settings.name).toBe('settings')
    expect(typeof settings.component).toBe('function')
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd desktop && bun run test:unit -- router`
Expected: FAIL — expected length 4, received 3

- [ ] **Step 3: Create the page shell**

Create `desktop/src/pages/SettingsPage.vue`:

```vue
<script setup lang="ts">
import { onMounted } from 'vue'
import { useSettings } from '../stores/settings'

const settings = useSettings()

onMounted(() => {
  settings.load()
})
</script>

<template>
  <div data-test="settings-page" class="mx-auto flex max-w-2xl flex-col gap-6 p-6">
    <h1 class="text-[15px] font-semibold text-[var(--text)]">Settings</h1>
  </div>
</template>
```

- [ ] **Step 4: Add the route**

In `desktop/src/router/index.ts`, between the `/about` route and the catch-all:

```ts
    {
      path: '/settings',
      name: 'settings',
      component: () => import('../pages/SettingsPage.vue'),
    },
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd desktop && bun run test:unit -- router`
Expected: PASS (6 passed)

- [ ] **Step 6: Commit**

```bash
git add desktop/src/router/index.ts desktop/tests/unit/router.test.ts desktop/src/pages/SettingsPage.vue
git commit -m "feat(desktop): add /settings route"
```

---

### Task 5: General section — default size

**Files:**
- Modify: `desktop/src/pages/SettingsPage.vue`
- Test: `desktop/tests/unit/SettingsPage.test.ts`

**Interfaces:**
- Consumes: `useSettings()` — `presets`, `defaultPreset`, `loaded`, `load`, `setDefaultPreset`

- [ ] **Step 1: Write the failing tests**

Create `desktop/tests/unit/SettingsPage.test.ts`. Read `tests/unit/ResourcesTab.test.ts` first for the mounting style, then:

```ts
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setToastScheduler } from '../../src/composables/useToasts'
import { api } from '../../src/shared/api'
import SettingsPage from '../../src/pages/SettingsPage.vue'

const CONFIG = {
  default_preset: 'standard' as const,
  presets: {
    light: { cpu: 2, memory_gb: 4 },
    standard: { cpu: 4, memory_gb: 8 },
    heavy: { cpu: 8, memory_gb: 16 },
  },
}

beforeEach(() => {
  setActivePinia(createPinia())
  setToastScheduler(() => {})
  vi.spyOn(api, 'config').mockResolvedValue(CONFIG)
})

describe('SettingsPage — General', () => {
  it('renders a card per engine preset with its real cpu/RAM', async () => {
    const w = mount(SettingsPage)
    await flushPromises()
    const cards = w.findAll('[data-test^="preset-"]')
    expect(cards).toHaveLength(3)
    // Values come from the engine, not a local table.
    expect(w.get('[data-test="preset-heavy"]').text()).toContain('8')
    expect(w.get('[data-test="preset-heavy"]').text()).toContain('16')
  })

  it('marks the configured default as selected', async () => {
    const w = mount(SettingsPage)
    await flushPromises()
    expect(w.get('[data-test="preset-standard"]').attributes('aria-checked')).toBe('true')
    expect(w.get('[data-test="preset-light"]').attributes('aria-checked')).toBe('false')
  })

  it('writes the new default when a card is clicked', async () => {
    const spy = vi
      .spyOn(api, 'setConfig')
      .mockResolvedValue({ ...CONFIG, default_preset: 'heavy' as const })
    const w = mount(SettingsPage)
    await flushPromises()
    await w.get('[data-test="preset-heavy"]').trigger('click')
    expect(spy).toHaveBeenCalledWith('heavy')
  })

  it('does not re-write the default that is already set', async () => {
    const spy = vi.spyOn(api, 'setConfig')
    const w = mount(SettingsPage)
    await flushPromises()
    await w.get('[data-test="preset-standard"]').trigger('click')
    expect(spy).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd desktop && bun run test:unit -- SettingsPage`
Expected: FAIL — no `[data-test^="preset-"]` elements

- [ ] **Step 3: Implement the General section**

Replace `desktop/src/pages/SettingsPage.vue`:

```vue
<script setup lang="ts">
import { computed, onMounted } from 'vue'
import type { PresetName } from '../shared/api'
import { useSettings } from '../stores/settings'

const settings = useSettings()

const presetList = computed(() =>
  settings.presets
    ? (Object.entries(settings.presets) as [PresetName, { cpu: number; memory_gb: number }][])
    : [],
)

async function choose(name: PresetName): Promise<void> {
  if (name === settings.defaultPreset) return
  await settings.setDefaultPreset(name)
}

onMounted(() => {
  settings.load()
})
</script>

<template>
  <div data-test="settings-page" class="mx-auto flex max-w-2xl flex-col gap-8 p-6">
    <h1 class="text-[15px] font-semibold text-[var(--text)]">Settings</h1>

    <section class="flex flex-col gap-3">
      <div>
        <h2 class="text-[13px] font-semibold text-[var(--text)]">Default size</h2>
        <p class="mt-0.5 text-[11.5px] text-[var(--text-faint)]">
          Applied to new VMs, from the CLI and here alike.
        </p>
      </div>

      <div role="radiogroup" class="grid grid-cols-3 gap-2">
        <button
          v-for="[name, p] in presetList"
          :key="name"
          type="button"
          role="radio"
          :data-test="`preset-${name}`"
          :aria-checked="name === settings.defaultPreset ? 'true' : 'false'"
          class="flex flex-col items-start gap-1 rounded-[7px] border px-3 py-2.5 text-left"
          :class="
            name === settings.defaultPreset
              ? 'border-[var(--emerald)] bg-[var(--bg-elev2)]'
              : 'border-[var(--border)] bg-[var(--bg-elev)] hover:bg-[var(--bg-hover)]'
          "
          @click="choose(name)"
        >
          <span class="text-[12.5px] font-semibold capitalize text-[var(--text)]">{{ name }}</span>
          <span class="font-mono text-[11px] tabular-nums text-[var(--text-dim)]">
            {{ p.cpu }} vCPU · {{ p.memory_gb }} GB
          </span>
        </button>
      </div>

      <p class="text-[11px] text-[var(--text-faint)]">
        Disk is not part of a preset — it can only grow, and every VM starts from the golden
        image's disk.
      </p>
    </section>
  </div>
</template>
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd desktop && bun run test:unit -- SettingsPage`
Expected: PASS (4 passed)

- [ ] **Step 5: Commit**

```bash
git add desktop/src/pages/SettingsPage.vue desktop/tests/unit/SettingsPage.test.ts
git commit -m "feat(desktop): add default size setting"
```

---

### Task 6: Data section — two-tier reset

**Files:**
- Modify: `desktop/src/pages/SettingsPage.vue`
- Test: `desktop/tests/unit/SettingsPage.test.ts`

**Interfaces:**
- Consumes: `useSettings()` — `resetData`, `resetting`; `@tauri-apps/plugin-dialog`'s `confirm`; `useFleet().refresh`

**Safety — this section deletes VMs irreversibly:**
- Two tiers. Tier 1 "Remove all VMs & data" keeps `mf-golden` (`scope: 'fleet'`). Tier 2 "Full reset" also deletes golden and resets settings (`scope: 'all'`) and **must state that golden needs a full re-bake**, which is slow.
- **Both are gated by a `confirm()` dialog naming the exact consequence.** Never call `resetData` without one.
- After a reset, refresh the fleet — the sidebar is showing VMs that no longer exist.
- `dialog:default` is already in `src-tauri/capabilities/default.json`; no capability change needed. Verify.

- [ ] **Step 1: Write the failing tests**

Append to `desktop/tests/unit/SettingsPage.test.ts`:

```ts
vi.mock('@tauri-apps/plugin-dialog', () => ({ confirm: vi.fn() }))
import { confirm } from '@tauri-apps/plugin-dialog'

describe('SettingsPage — Data', () => {
  it('does not reset when the confirm is declined', async () => {
    vi.mocked(confirm).mockResolvedValue(false)
    const spy = vi.spyOn(api, 'resetData')
    const w = mount(SettingsPage)
    await flushPromises()
    await w.get('[data-test="reset-fleet"]').trigger('click')
    await flushPromises()
    // A stray click must never delete a fleet.
    expect(spy).not.toHaveBeenCalled()
  })

  it('resets with scope fleet when confirmed', async () => {
    vi.mocked(confirm).mockResolvedValue(true)
    const spy = vi
      .spyOn(api, 'resetData')
      .mockResolvedValue({ deleted: ['mf-a'], failed: [], removed_paths: [] })
    const w = mount(SettingsPage)
    await flushPromises()
    await w.get('[data-test="reset-fleet"]').trigger('click')
    await flushPromises()
    expect(spy).toHaveBeenCalledWith('fleet')
  })

  it('resets with scope all from the full-reset button', async () => {
    vi.mocked(confirm).mockResolvedValue(true)
    const spy = vi
      .spyOn(api, 'resetData')
      .mockResolvedValue({ deleted: [], failed: [], removed_paths: [] })
    const w = mount(SettingsPage)
    await flushPromises()
    await w.get('[data-test="reset-all"]').trigger('click')
    await flushPromises()
    expect(spy).toHaveBeenCalledWith('all')
  })

  it("warns that golden needs a re-bake in the full-reset confirmation", async () => {
    vi.mocked(confirm).mockResolvedValue(false)
    const w = mount(SettingsPage)
    await flushPromises()
    await w.get('[data-test="reset-all"]').trigger('click')
    const message = String(vi.mocked(confirm).mock.calls.at(-1)?.[0])
    expect(message.toLowerCase()).toContain('re-bake')
  })

  it('refreshes the fleet after a reset so the sidebar drops dead VMs', async () => {
    vi.mocked(confirm).mockResolvedValue(true)
    vi.spyOn(api, 'resetData').mockResolvedValue({
      deleted: ['mf-a'],
      failed: [],
      removed_paths: [],
    })
    const listSpy = vi.spyOn(api, 'listVms').mockResolvedValue([])
    vi.spyOn(api, 'listSnapshots').mockResolvedValue([])
    const w = mount(SettingsPage)
    await flushPromises()
    await w.get('[data-test="reset-fleet"]').trigger('click')
    await flushPromises()
    expect(listSpy).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd desktop && bun run test:unit -- SettingsPage`
Expected: FAIL — no `[data-test="reset-fleet"]`

- [ ] **Step 3: Implement the Data section**

Add to `SettingsPage.vue`'s script:

```ts
import { confirm } from '@tauri-apps/plugin-dialog'
import { useFleet } from '../stores/fleet'

const fleet = useFleet()

async function reset(scope: 'fleet' | 'all'): Promise<void> {
  const message =
    scope === 'all'
      ? 'Delete every VM, snapshot, and setting — including the golden image?\n\nThe golden image needs a full re-bake afterwards, which takes a while. This cannot be undone.'
      : 'Delete every VM, snapshot, and stored macfleet state?\n\nThe golden image is kept, so you can spin up again immediately. This cannot be undone.'
  const ok = await confirm(message, { title: 'macfleet', kind: 'warning' })
  if (!ok) return
  const res = await settings.resetData(scope)
  // The sidebar is still showing VMs that no longer exist.
  if (res) await fleet.refresh()
}
```

and to the template, after the General section:

```html
    <section class="flex flex-col gap-3">
      <div>
        <h2 class="text-[13px] font-semibold text-[var(--text)]">Data</h2>
        <p class="mt-0.5 text-[11.5px] text-[var(--text-faint)]">
          Deletes only what macfleet owns. Other VMs in your tart store are untouched.
        </p>
      </div>

      <div class="flex flex-col gap-2">
        <button
          type="button"
          data-test="reset-fleet"
          :disabled="settings.resetting"
          class="flex items-center justify-between rounded-[7px] border border-[var(--border)] bg-[var(--bg-elev)] px-3 py-2.5 text-left hover:bg-[var(--bg-hover)] disabled:opacity-50"
          @click="reset('fleet')"
        >
          <span class="text-[12.5px] text-[var(--text)]">Remove all VMs &amp; data</span>
          <span class="text-[11px] text-[var(--text-faint)]">keeps the golden image</span>
        </button>

        <button
          type="button"
          data-test="reset-all"
          :disabled="settings.resetting"
          class="flex items-center justify-between rounded-[7px] border border-[var(--red)] bg-[var(--bg-elev)] px-3 py-2.5 text-left hover:bg-[var(--bg-hover)] disabled:opacity-50"
          @click="reset('all')"
        >
          <span class="text-[12.5px] text-[var(--red)]">Full reset</span>
          <span class="text-[11px] text-[var(--text-faint)]">golden image needs a re-bake</span>
        </button>
      </div>
    </section>
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd desktop && bun run test:unit -- SettingsPage`
Expected: PASS (9 passed)

- [ ] **Step 5: Commit**

```bash
git add desktop/src/pages/SettingsPage.vue desktop/tests/unit/SettingsPage.test.ts
git commit -m "feat(desktop): add two-tier data reset to settings"
```

---

### Task 7: Doctor section — checks

**Files:**
- Modify: `desktop/src/pages/SettingsPage.vue`
- Test: `desktop/tests/unit/SettingsPage.test.ts`

**Interfaces:**
- Consumes: `useSettings()` — `checks`, `doctorRunning`, `doctorError`, `runDoctor`

**Status → colour mapping (use the existing CSS vars, no new colours):** `ok` → `--emerald`, `warn` → `--amber`, `fail` → `--red`, `skip` → `--idle`.

**Real output to design against** (captured live from plan 1 on a healthy machine — note `warn` and `skip` are normal, not exceptional):

```
arch            ok    arm64
tart            ok    /opt/homebrew/bin/tart
golden          ok    mf-golden present
golden_warm     warn  state is 'stopped' — new VMs will cold-boot (~30-60s)   fix: macfleet warm
tcc_screenshot  skip  computer-use disabled — set MACFLEET_ALLOW_CONTROL=1 to test
orphans         ok    none
stale_leases    ok    none
disk            ok    378GB free
```

- [ ] **Step 1: Write the failing tests**

Append to `desktop/tests/unit/SettingsPage.test.ts`:

```ts
const CHECKS = [
  { id: 'arch', label: 'Apple silicon', status: 'ok' as const, detail: 'arm64', fix: null },
  {
    id: 'golden_warm',
    label: 'Golden image warm',
    status: 'warn' as const,
    detail: "state is 'stopped'",
    fix: 'macfleet warm',
  },
  {
    id: 'tcc_screenshot',
    label: 'Screen recording permission',
    status: 'skip' as const,
    detail: 'computer-use disabled',
    fix: null,
  },
]

describe('SettingsPage — Doctor', () => {
  it('runs the checks on mount', async () => {
    const spy = vi.spyOn(api, 'doctor').mockResolvedValue(CHECKS)
    mount(SettingsPage)
    await flushPromises()
    expect(spy).toHaveBeenCalled()
  })

  it('renders a row per check with its label and detail', async () => {
    vi.spyOn(api, 'doctor').mockResolvedValue(CHECKS)
    const w = mount(SettingsPage)
    await flushPromises()
    expect(w.findAll('[data-test^="check-"]')).toHaveLength(3)
    const warm = w.get('[data-test="check-golden_warm"]')
    expect(warm.text()).toContain('Golden image warm')
    expect(warm.text()).toContain("state is 'stopped'")
  })

  it('shows the fix hint when the engine gives one', async () => {
    vi.spyOn(api, 'doctor').mockResolvedValue(CHECKS)
    const w = mount(SettingsPage)
    await flushPromises()
    expect(w.get('[data-test="check-golden_warm"]').text()).toContain('macfleet warm')
    expect(w.get('[data-test="check-arch"]').text()).not.toContain('macfleet')
  })

  it('re-runs the checks on demand', async () => {
    const spy = vi.spyOn(api, 'doctor').mockResolvedValue(CHECKS)
    const w = mount(SettingsPage)
    await flushPromises()
    await w.get('[data-test="doctor-run"]').trigger('click')
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('reports an unreachable engine instead of showing an empty check list', async () => {
    vi.spyOn(api, 'doctor').mockRejectedValue(new Error('connection refused'))
    const w = mount(SettingsPage)
    await flushPromises()
    // Engine down is when a user opens Doctor — silence would be the worst answer.
    expect(w.get('[data-test="doctor-error"]').text()).toContain('connection refused')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd desktop && bun run test:unit -- SettingsPage`
Expected: FAIL — no `[data-test="doctor-run"]`

- [ ] **Step 3: Implement the Doctor section**

Add to the script:

```ts
import type { CheckStatus } from '../shared/api'

const STATUS_COLOR: Record<CheckStatus, string> = {
  ok: 'var(--emerald)',
  warn: 'var(--amber)',
  fail: 'var(--red)',
  skip: 'var(--idle)',
}
```

and extend `onMounted`:

```ts
onMounted(() => {
  settings.load()
  settings.runDoctor()
})
```

Template, after the Data section:

```html
    <section class="flex flex-col gap-3">
      <div class="flex items-end justify-between">
        <div>
          <h2 class="text-[13px] font-semibold text-[var(--text)]">Doctor</h2>
          <p class="mt-0.5 text-[11.5px] text-[var(--text-faint)]">
            Checks this machine's setup. Reports problems; never changes anything.
          </p>
        </div>
        <button
          type="button"
          data-test="doctor-run"
          :disabled="settings.doctorRunning"
          class="h-8 rounded-lg border border-[var(--border)] px-3 text-xs text-[var(--text-dim)] hover:bg-[var(--bg-hover)] disabled:opacity-50"
          @click="settings.runDoctor()"
        >
          {{ settings.doctorRunning ? 'Checking…' : 'Run checks' }}
        </button>
      </div>

      <p
        v-if="settings.doctorError"
        data-test="doctor-error"
        class="rounded-[7px] border border-[var(--red)] bg-[var(--bg-elev)] px-3 py-2 text-[11.5px] text-[var(--red)]"
      >
        Could not reach the engine: {{ settings.doctorError }}
      </p>

      <div v-else class="flex flex-col gap-px overflow-hidden rounded-[7px] border border-[var(--border)]">
        <div
          v-for="c in settings.checks"
          :key="c.id"
          :data-test="`check-${c.id}`"
          class="flex items-start gap-2.5 bg-[var(--bg-elev)] px-3 py-2.5"
        >
          <span
            class="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full"
            :style="{ background: STATUS_COLOR[c.status] }"
          />
          <div class="flex min-w-0 flex-col">
            <span class="text-[12.5px] text-[var(--text)]">{{ c.label }}</span>
            <span class="font-mono text-[11px] break-words text-[var(--text-dim)]">{{ c.detail }}</span>
            <span v-if="c.fix" class="mt-0.5 font-mono text-[11px] text-[var(--amber)]">
              fix: {{ c.fix }}
            </span>
          </div>
        </div>
      </div>
    </section>
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd desktop && bun run test:unit -- SettingsPage`
Expected: PASS (14 passed)

- [ ] **Step 5: Commit**

```bash
git add desktop/src/pages/SettingsPage.vue desktop/tests/unit/SettingsPage.test.ts
git commit -m "feat(desktop): add doctor checks to settings"
```

---

### Task 8: Doctor section — engine log

**Files:**
- Create: `desktop/src/composables/useEngineLog.ts`
- Modify: `desktop/src/pages/SettingsPage.vue`
- Modify: `desktop/src-tauri/capabilities/default.json`
- Test: `desktop/tests/unit/useEngineLog.test.ts`

**Interfaces:**
- Consumes: `@tauri-apps/plugin-fs` (`readTextFile`, `BaseDirectory.Home`), `@tauri-apps/plugin-opener` (`revealItemInDir`)
- Produces: `useEngineLog()` -> `{ lines: Ref<string[]>, error: Ref<string | null>, load(): Promise<void>, reveal(): Promise<void> }`

**Why this reads the file directly and not through the engine API — do not "simplify" this:** the engine log's whole purpose is diagnosing an engine that failed to start. Routing it through the engine's own HTTP would fail exactly when it is needed. Plan 1 made the Tauri host write `~/.macfleet/engine.log` (current run) and `engine.log.1` (previous run), rotated per launch.

**Capability work.** `capabilities/default.json` currently scopes `fs:allow-read-text-file` to `$APPDATA/**`, `$APPCONFIG/**`, `$RESOURCE/**` — none of which cover `~/.macfleet`. Add `{ "path": "$HOME/.macfleet/engine.log" }` and `{ "path": "$HOME/.macfleet/engine.log.1" }` to that permission's `allow` list. Keep it **read-only and file-scoped** — do not grant `$HOME/**`, and do not add a write permission.

`opener:default` is already present, but **verify it actually includes reveal-item-in-dir** before relying on it: check `desktop/src-tauri/gen/schemas/desktop-schema.json` for the permission's contents. If `revealItemInDir` is not in the default set, add the specific permission identifier the schema names. **Do not guess the identifier — read the schema.** If reveal cannot be granted without a broad scope, drop the reveal button and say so in your report rather than widening the capability.

- [ ] **Step 1: Write the failing tests**

Create `desktop/tests/unit/useEngineLog.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/plugin-fs', () => ({
  readTextFile: vi.fn(),
  BaseDirectory: { Home: 'Home' },
}))
import { readTextFile } from '@tauri-apps/plugin-fs'
import { useEngineLog } from '../../src/composables/useEngineLog'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useEngineLog', () => {
  it('reads the log from the home-relative path', async () => {
    vi.mocked(readTextFile).mockResolvedValue('a\nb\nc')
    const { lines, load } = useEngineLog()
    await load()
    expect(vi.mocked(readTextFile).mock.calls[0][0]).toBe('.macfleet/engine.log')
    expect(lines.value).toEqual(['a', 'b', 'c'])
  })

  it('keeps only the last N lines', async () => {
    const many = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n')
    vi.mocked(readTextFile).mockResolvedValue(many)
    const { lines, load } = useEngineLog(10)
    await load()
    expect(lines.value).toHaveLength(10)
    expect(lines.value.at(-1)).toBe('line 499')
  })

  it('drops trailing blank lines from the file', async () => {
    vi.mocked(readTextFile).mockResolvedValue('a\nb\n')
    const { lines, load } = useEngineLog()
    await load()
    expect(lines.value).toEqual(['a', 'b'])
  })

  it('reports a missing log rather than throwing', async () => {
    vi.mocked(readTextFile).mockRejectedValue(new Error('No such file'))
    const { lines, error, load } = useEngineLog()
    await load()
    // The app may never have run the sidecar; that is a state, not a crash.
    expect(error.value).toContain('No such file')
    expect(lines.value).toEqual([])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd desktop && bun run test:unit -- useEngineLog`
Expected: FAIL — cannot resolve `../../src/composables/useEngineLog`

- [ ] **Step 3: Write the composable**

Create `desktop/src/composables/useEngineLog.ts`:

```ts
import { ref, type Ref } from 'vue'

/** The engine sidecar's stdout, written by the Tauri host (src-tauri/src/lib.rs) to
 * ~/.macfleet/engine.log and rotated one generation per launch.
 *
 * Read straight off disk through the fs plugin rather than via the engine's API — on purpose.
 * This log exists to explain an engine that failed to start, so asking that engine for it
 * would fail exactly when it matters. */
const LOG_PATH = '.macfleet/engine.log'

export function useEngineLog(tail = 200): {
  lines: Ref<string[]>
  error: Ref<string | null>
  load: () => Promise<void>
  reveal: () => Promise<void>
} {
  const lines = ref<string[]>([])
  const error = ref<string | null>(null)

  async function load(): Promise<void> {
    error.value = null
    try {
      const { readTextFile, BaseDirectory } = await import('@tauri-apps/plugin-fs')
      const text = await readTextFile(LOG_PATH, { baseDir: BaseDirectory.Home })
      lines.value = text.replace(/\n+$/, '').split('\n').slice(-tail)
    } catch (e) {
      // No sidecar has run yet, or the file is unreadable. Both are states worth showing.
      error.value = String(e)
      lines.value = []
    }
  }

  async function reveal(): Promise<void> {
    try {
      const { revealItemInDir } = await import('@tauri-apps/plugin-opener')
      const { homeDir, join } = await import('@tauri-apps/api/path')
      await revealItemInDir(await join(await homeDir(), LOG_PATH))
    } catch (e) {
      error.value = String(e)
    }
  }

  return { lines, error, load, reveal }
}
```

The dynamic `import()` mirrors `ConnectTab.vue`'s guarded-plugin-import pattern — read it and match. If the tests' `vi.mock` cannot intercept a dynamic import in this setup, switch to a static import and update the test; note the change in your report.

- [ ] **Step 4: Add the capability scope**

In `desktop/src-tauri/capabilities/default.json`, extend the existing `fs:allow-read-text-file` entry's `allow` array:

```json
      "allow": [
        { "path": "$APPDATA/**" },
        { "path": "$APPCONFIG/**" },
        { "path": "$RESOURCE/**" },
        { "path": "$HOME/.macfleet/engine.log" },
        { "path": "$HOME/.macfleet/engine.log.1" }
      ]
```

- [ ] **Step 5: Wire the log into the Doctor section**

In `SettingsPage.vue`'s script, **destructure** the composable — do not keep it as an object:

```ts
import { useEngineLog } from '../composables/useEngineLog'

// Destructured so the refs are top-level setup bindings and auto-unwrap in the template.
// Held as `const engineLog = useEngineLog()`, `engineLog.lines` stays a Ref and every
// template use needs `.value` — easy to get wrong and silently render "[object Object]".
const { lines: logLines, load: loadEngineLog, reveal: revealEngineLog } = useEngineLog()
```

and call `loadEngineLog()` in `onMounted`. Append to the Doctor section's template:

```html
      <div class="flex items-end justify-between">
        <h3 class="text-[12px] font-semibold text-[var(--text-dim)]">Engine log</h3>
        <button
          type="button"
          data-test="log-reveal"
          class="h-7 rounded-lg border border-[var(--border)] px-2.5 text-[11px] text-[var(--text-dim)] hover:bg-[var(--bg-hover)]"
          @click="revealEngineLog()"
        >
          Reveal in Finder
        </button>
      </div>
      <pre
        v-if="logLines.length"
        data-test="engine-log"
        class="max-h-64 overflow-auto rounded-[7px] border border-[var(--border)] bg-[var(--bg)] p-3 font-mono text-[11px] leading-relaxed text-[var(--text-dim)]"
      >{{ logLines.join('\n') }}</pre>
      <p v-else data-test="engine-log-empty" class="text-[11px] text-[var(--text-faint)]">
        No engine log yet — it appears once the desktop app has started the engine.
      </p>
```

- [ ] **Step 6: Run the full unit suite**

Run: `cd desktop && bun run test:unit && bun run build && make lint-desktop`
Expected: PASS, clean

- [ ] **Step 7: Verify the capability actually works — this is the whole point**

A capability typo fails silently at runtime, not at build time. Run the real app:

Run: `make dev`, open Settings, look at the Doctor section.
Expected: the engine log pane shows real uvicorn lines (`INFO: Started server process [...]`). If it shows the empty state or an error, the fs scope is wrong — fix it before committing.

If you cannot launch the GUI in your environment, say so plainly in your report and mark this step not-done. **Never report a verification you did not perform.**

- [ ] **Step 8: Commit**

```bash
git add desktop/src/composables/useEngineLog.ts desktop/src/pages/SettingsPage.vue \
        desktop/src-tauri/capabilities/default.json desktop/tests/unit/useEngineLog.test.ts
git commit -m "feat(desktop): show the engine log in doctor"
```

---

### Task 9: Entry points

**Files:**
- Modify: `desktop/src/components/AppHeader.vue`
- Modify: `desktop/src/composables/useHotkeys.ts`
- Modify: `desktop/src/stores/ui.ts` (palette item)
- Test: `desktop/tests/unit/AppHeader.test.ts`, `desktop/tests/unit/useHotkeys.test.ts`, `desktop/tests/unit/ui.test.ts`

**Interfaces:**
- Produces: a gear button in `AppHeader`, `⌘,` / `Ctrl-,` global hotkey, and a `Open settings` command-palette item in the `App` group.

Three entry points, each doing a different job: the gear is discoverable, `⌘,` is the macOS convention and fast, the palette item is searchable. Plan 3 adds a fourth (the tray's `Settings…`).

**Current `useHotkeys` signature is `useHotkeys(onOpenPalette: () => void)`** — it is called once, from `AppHeader.vue`. Extend it to take a second callback rather than inventing a registry:

```ts
export function useHotkeys(onOpenPalette: () => void, onOpenSettings?: () => void): void
```

- [ ] **Step 1: Write the failing tests**

Append to `desktop/tests/unit/useHotkeys.test.ts` (read it first and match its harness):

```ts
it('calls onOpenSettings for meta+,', () => {
  const palette = vi.fn()
  const settings = vi.fn()
  mountWithHotkeys(palette, settings)
  window.dispatchEvent(new KeyboardEvent('keydown', { key: ',', metaKey: true }))
  expect(settings).toHaveBeenCalledTimes(1)
  expect(palette).not.toHaveBeenCalled()
})

it('calls onOpenSettings for ctrl+,', () => {
  const settings = vi.fn()
  mountWithHotkeys(vi.fn(), settings)
  window.dispatchEvent(new KeyboardEvent('keydown', { key: ',', ctrlKey: true }))
  expect(settings).toHaveBeenCalledTimes(1)
})

it('ignores a bare comma', () => {
  const settings = vi.fn()
  mountWithHotkeys(vi.fn(), settings)
  window.dispatchEvent(new KeyboardEvent('keydown', { key: ',' }))
  // Typing a comma in the search field must not open Settings.
  expect(settings).not.toHaveBeenCalled()
})
```

Reuse whatever mounting helper the existing file uses; name it as that file does.

Append to `desktop/tests/unit/AppHeader.test.ts`:

```ts
it('navigates to /settings from the gear button', async () => {
  const w = mountHeader()
  await w.get('[data-test="settings-button"]').trigger('click')
  expect(pushSpy).toHaveBeenCalledWith('/settings')
})
```

matching however that file already stubs the router (check whether it uses a real router or a `vi.mock('vue-router')` — follow it).

Append to `desktop/tests/unit/ui.test.ts`:

```ts
it('offers Open settings in the palette', () => {
  const ui = useUi()
  const item = ui.paletteItems.find((i) => i.id === 'settings')
  expect(item).toBeDefined()
  expect(item?.group).toBe('App')
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd desktop && bun run test:unit -- useHotkeys AppHeader ui`
Expected: FAIL

- [ ] **Step 3: Extend `useHotkeys`**

Replace `desktop/src/composables/useHotkeys.ts`:

```ts
import { onMounted, onUnmounted } from 'vue'

/** Global ⌘K / Ctrl-K → opens the command palette (comp `onKey`, lines 520–522), and
 * ⌘, / Ctrl-, → Settings (the macOS convention). Scoped to just those two openers — the
 * palette owns its own Escape/arrow handling once open (Task 13). */
export function useHotkeys(onOpenPalette: () => void, onOpenSettings?: () => void): void {
  function onKey(e: KeyboardEvent): void {
    const mod = e.metaKey || e.ctrlKey
    if (!mod) return
    const key = e.key.toLowerCase()
    if (key === 'k') {
      e.preventDefault()
      onOpenPalette()
    } else if (key === ',' && onOpenSettings) {
      e.preventDefault()
      onOpenSettings()
    }
  }
  onMounted(() => window.addEventListener('keydown', onKey))
  onUnmounted(() => window.removeEventListener('keydown', onKey))
}
```

- [ ] **Step 4: Add the gear button and wire the hotkey**

In `AppHeader.vue`'s script, add `import { useRouter } from 'vue-router'`, `const router = useRouter()`, and change the hotkey call to:

```ts
useHotkeys(
  () => ui.openPalette(),
  () => router.push('/settings'),
)
```

In the template, add before the theme-toggle button (so the toggle stays last):

```html
<button
  type="button"
  title="Settings (⌘,)"
  aria-label="Settings"
  data-test="settings-button"
  class="flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--bg)] text-[14px] text-[var(--text-dim)]"
  @click="router.push('/settings')"
>
  ⚙
</button>
```

- [ ] **Step 5: Add the palette item**

In `desktop/src/stores/ui.ts`'s `paletteItems`, next to the existing `theme` item in the `App` group:

```ts
    push('settings', 'Open settings', 'App', () => {
      router.push('/settings')
    })
```

`ui.ts` has no router today. Rather than importing a router into a store, follow whatever the file already does for navigation — if it does none, the cleanest option is to import the router singleton (`import router from '../router'`) since `src/router/index.ts` exports a default instance. Confirm that does not create a cycle (`router` lazily imports pages, pages import stores); if it does, drop the palette item and report it rather than forcing it.

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd desktop && bun run test:unit && bun run build && make lint-desktop`
Expected: PASS, clean

- [ ] **Step 7: Commit**

```bash
git add desktop/src/components/AppHeader.vue desktop/src/composables/useHotkeys.ts \
        desktop/src/stores/ui.ts desktop/tests/unit/
git commit -m "feat(desktop): add settings entry points"
```

---

### Task 10: E2E journey

**Files:**
- Modify: `desktop/tests/e2e/mock-api.ts`
- Create: `desktop/tests/e2e/settings.spec.ts`

**Interfaces:**
- Consumes: everything above

**Note:** `mock-api.ts` mocks by URL glob and errors loudly on anything unmocked. The new endpoints must be added or every settings journey fails. Read the file's existing route style first — `page.route('**/host', ...)` etc. — and match it.

- [ ] **Step 1: Add the mocks**

In `mockApi()`, alongside the `**/host` route:

```ts
  const config = { default_preset: 'standard', presets: { light: { cpu: 2, memory_gb: 4 }, standard: { cpu: 4, memory_gb: 8 }, heavy: { cpu: 8, memory_gb: 16 } } }
  await page.route('**/config', async (route) => {
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON() as { default_preset: string }
      config.default_preset = body.default_preset
    }
    return route.fulfill({ json: config })
  })

  await page.route('**/doctor', (route) =>
    route.fulfill({
      json: {
        checks: [
          { id: 'arch', label: 'Apple silicon', status: 'ok', detail: 'arm64', fix: null },
          { id: 'golden_warm', label: 'Golden image warm', status: 'warn', detail: "state is 'stopped'", fix: 'macfleet warm' },
        ],
      },
    }),
  )

  await page.route('**/data/reset', (route) =>
    route.fulfill({ json: { deleted: state.vms.map((v) => v.name), failed: [], removed_paths: [] } }),
  )
```

Add `config` to `MockApiState` if the file's convention is to expose mutable state (check how `state.vms` is used by specs) — the PUT-then-GET assertion below needs the mock to actually remember the write.

- [ ] **Step 2: Write the journey**

Create `desktop/tests/e2e/settings.spec.ts`, matching the existing specs' style (read one first):

```ts
import { expect, test } from '@playwright/test'
import { mockApi } from './mock-api'

test('user changes the default VM size and it sticks', async ({ page }) => {
  await mockApi(page, { vms: [{ name: 'mf-web', state: 'running', source: 'local', healthy: true }] })
  await page.goto('/')
  await page.getByTestId('settings-button').click()
  await expect(page.getByTestId('settings-page')).toBeVisible()

  await expect(page.getByTestId('preset-standard')).toHaveAttribute('aria-checked', 'true')
  await page.getByTestId('preset-heavy').click()
  await expect(page.getByTestId('preset-heavy')).toHaveAttribute('aria-checked', 'true')

  // Survives a reload because the engine, not the app, owns it.
  await page.reload()
  await expect(page.getByTestId('preset-heavy')).toHaveAttribute('aria-checked', 'true')
})

test('doctor renders the engine checks with their status', async ({ page }) => {
  await mockApi(page)
  await page.goto('/settings')
  await expect(page.getByTestId('check-arch')).toContainText('arm64')
  const warm = page.getByTestId('check-golden_warm')
  await expect(warm).toContainText("state is 'stopped'")
  await expect(warm).toContainText('macfleet warm')
})
```

Note `page.goto('/settings')` works only if the dev server serves the SPA fallback for that path — if it 404s, navigate via the gear button instead and say so in your report.

- [ ] **Step 3: Run the e2e suite**

Run: `cd desktop && bun run test:e2e`
Expected: PASS, including the pre-existing specs (the fleet store now fetches `/config` on create — an unmocked `/config` would break the create journeys, which is exactly what Step 1 prevents).

- [ ] **Step 4: Full CI gate**

Run: `cd desktop && make ci`
Expected: everything green, unit coverage still above the configured gates

- [ ] **Step 5: Commit**

```bash
git add desktop/tests/e2e/mock-api.ts desktop/tests/e2e/settings.spec.ts
git commit -m "test(desktop): cover the settings journey e2e"
```

---

## Verification

Unit and e2e suites are not enough for this plan — two of its risks (the fs capability scope, and the preset table actually coming from the engine) only show up in the real app.

1. `make dev`, then press `⌘,`.
   Expected: the Settings page opens. The three preset cards show 2/4, 4/8, 8/16 — **served by the engine**, not the app.
2. Click **Heavy**. Then, in a terminal: `cat ~/.macfleet/config.json`.
   Expected: `{"default_preset": "heavy"}`. This is the CLI/desktop split closing: `macfleet up foo` from a terminal now creates a heavy VM too.
3. Look at the Doctor section.
   Expected: eight checks with real statuses for this machine, and the engine log pane showing real uvicorn lines. An empty log pane means the fs capability scope is wrong.
4. Set the default back to **Standard** when done.

Do **not** exercise the reset buttons against a fleet you care about. If you must test one, use tier 1 (which keeps golden) on a throwaway VM, and never tier 2 unless you are willing to re-bake golden.
